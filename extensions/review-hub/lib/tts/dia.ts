/**
 * Dia TTS Provider — English dialogue synthesis via Nari Labs Dia model.
 *
 * Performance enhancements:
 * 1) Persistent worker process (model stays loaded across reviews)
 * 2) Per-section audio cache (reuse unchanged section clips)
 * 3) Fast mode support (shorter pauses + faster sampling params)
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

import type {
  TTSProvider,
  TTSResult,
  SectionTimestamp,
  TTSGenerationOptions,
} from "./provider.js";
import type { DialogueScript, ScriptSegment } from "../script-generator.js";
import {
  getVenvPath,
  createVenv,
  installPackages,
  isVenvValid,
  convertToMp3,
} from "./installer.js";

// ── Constants ──────────────────────────────────────────────────────────────

const PROVIDER_NAME = "dia";
const VENV_PATH = getVenvPath(PROVIDER_NAME);
const DIA_GIT_URL = "git+https://github.com/nari-labs/dia.git";

const DIA_WORKER_SCRIPT = path.resolve(
  path.dirname(import.meta.url.replace("file://", "")),
  "..",
  "..",
  "python",
  "dia_worker.py",
);

const REVIEW_HUB_ROOT = path.join(os.homedir(), ".pi", "review-hub");
const DEFAULT_CACHE_DIR = path.join(REVIEW_HUB_ROOT, "audio-cache", "dia");
const WORKER_READY_TIMEOUT_MS = 25 * 60 * 1000; // first model download can legitimately take a while

const HF_MODEL_CACHE_DIR = path.join(
  os.homedir(),
  ".cache",
  "huggingface",
  "hub",
  "models--nari-labs--Dia-1.6B-0626",
);
const HF_MODEL_LOCK_DIR = path.join(
  os.homedir(),
  ".cache",
  "huggingface",
  "hub",
  ".locks",
  "models--nari-labs--Dia-1.6B-0626",
);
const STALE_ARTIFACT_AGE_MS = 10 * 60 * 1000;

const SECTION_GAP_MS = 300;
const SECTION_GAP_MS_FAST = 140;

// ── Logging ────────────────────────────────────────────────────────────────

function appendDiaLog(message: string): void {
  const logPath = process.env.REVIEW_HUB_LOG_FILE;
  if (!logPath) return;

  try {
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] [dia] ${message}\n`, "utf-8");
  } catch {
    // ignore logging failures
  }
}

// ── Worker Protocol Types ─────────────────────────────────────────────────

interface SectionChunk {
  sectionId: string;
  text: string;
}

interface WorkerProgressEvent {
  type: "progress";
  requestId: string;
  phase: "loading" | "generating" | "saving";
  sectionIndex?: number;
  sectionId?: string;
  totalSections?: number;
  percent?: number;
  cached?: boolean;
  cacheHits?: number;
}

interface WorkerDoneEvent {
  type: "done";
  requestId: string;
  outputPath: string;
  timestampsPath: string;
  durationSeconds: number;
  cacheHits: number;
  totalSections: number;
}

interface WorkerErrorEvent {
  type: "error";
  requestId?: string;
  message: string;
}

interface WorkerReadyEvent {
  type: "ready";
  model: string;
  computeDtype: string;
}

type WorkerEvent = WorkerProgressEvent | WorkerDoneEvent | WorkerErrorEvent | WorkerReadyEvent | { type: string; [k: string]: unknown };

interface PendingRequest {
  resolve: (event: WorkerDoneEvent) => void;
  reject: (error: Error) => void;
  onProgress?: (event: WorkerProgressEvent) => void;
}

class DiaWorkerClient {
  private proc: ChildProcess;
  private stdoutBuffer = "";
  private pending = new Map<string, PendingRequest>();
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;
  private isReady = false;

  constructor(private pythonPath: string) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    this.proc = spawn(this.pythonPath, [DIA_WORKER_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout?.on("data", (data) => this.handleStdout(data.toString()));

    this.proc.stderr?.on("data", (data) => {
      const text = data.toString().trim();
      if (text) appendDiaLog(`worker stderr: ${text}`);
    });

    this.proc.on("close", (code) => {
      appendDiaLog(`worker exited (code ${code ?? "null"})`);
      const err = new Error(`Dia worker exited unexpectedly (code ${code ?? "null"})`);

      if (!this.isReady) {
        this.rejectReady(err);
      }

      for (const [id, req] of this.pending.entries()) {
        req.reject(err);
        this.pending.delete(id);
      }

      if (sharedWorker === this) {
        sharedWorker = null;
      }
    });

    this.proc.on("error", (err) => {
      appendDiaLog(`worker process error: ${err.message}`);
      if (!this.isReady) {
        this.rejectReady(err);
      }
    });
  }

  async waitReady(): Promise<void> {
    return this.readyPromise;
  }

  async generateReview(
    requestId: string,
    chunks: SectionChunk[],
    outputPath: string,
    timestampsPath: string,
    options: { cacheDir: string; gapMs: number; fastMode: boolean },
    onProgress?: (event: WorkerProgressEvent) => void,
  ): Promise<WorkerDoneEvent> {
    await this.waitReady();

    return new Promise<WorkerDoneEvent>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, onProgress });

      this.sendCommand({
        type: "generate_review",
        requestId,
        chunks,
        outputPath,
        timestampsPath,
        cacheDir: options.cacheDir,
        gapMs: options.gapMs,
        fastMode: options.fastMode,
      });
    });
  }

  cancel(requestId: string): void {
    this.sendCommand({ type: "cancel", requestId });
  }

  async shutdown(): Promise<void> {
    try {
      this.sendCommand({ type: "shutdown" });
    } catch {
      // ignore
    }

    // Give it a chance to exit gracefully
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    if (!this.proc.killed) {
      this.proc.kill("SIGTERM");
    }
  }

  private sendCommand(command: Record<string, unknown>): void {
    const payload = JSON.stringify(command) + "\n";
    this.proc.stdin?.write(payload);
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;

      appendDiaLog(`worker stdout: ${line}`);

      let event: WorkerEvent;
      try {
        event = JSON.parse(line) as WorkerEvent;
      } catch {
        continue;
      }

      if (event.type === "ready") {
        this.isReady = true;
        this.resolveReady();
        continue;
      }

      if (event.type === "progress") {
        const progressEvt = event as WorkerProgressEvent;
        if (typeof progressEvt.requestId !== "string") {
          appendDiaLog("worker progress event missing requestId");
          continue;
        }
        const req = this.pending.get(progressEvt.requestId);
        req?.onProgress?.(progressEvt);
        continue;
      }

      if (event.type === "done") {
        const done = event as WorkerDoneEvent;
        const req = this.pending.get(done.requestId);
        if (req) {
          this.pending.delete(done.requestId);
          req.resolve(done);
        }
        continue;
      }

      if (event.type === "error") {
        const errEvt = event as WorkerErrorEvent;
        const err = new Error(`Dia worker error: ${errEvt.message}`);
        if (errEvt.requestId) {
          const req = this.pending.get(errEvt.requestId);
          if (req) {
            this.pending.delete(errEvt.requestId);
            req.reject(err);
          }
        } else {
          // Global worker error
          for (const [id, req] of this.pending.entries()) {
            req.reject(err);
            this.pending.delete(id);
          }
        }
      }
    }
  }
}

let sharedWorker: DiaWorkerClient | null = null;

function cleanupStaleHfArtifacts(): void {
  const now = Date.now();

  const cleanupOldFiles = (dir: string, suffix: string, label: string) => {
    if (!fs.existsSync(dir)) return;

    let removed = 0;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(suffix)) continue;
      const full = path.join(dir, entry);
      try {
        const stat = fs.statSync(full);
        if (now - stat.mtimeMs > STALE_ARTIFACT_AGE_MS) {
          fs.rmSync(full, { force: true });
          removed++;
        }
      } catch {
        // ignore single-file cleanup errors
      }
    }

    if (removed > 0) {
      appendDiaLog(`cleaned ${removed} stale ${label} file(s) from ${dir}`);
    }
  };

  cleanupOldFiles(HF_MODEL_CACHE_DIR + "/blobs", ".incomplete", "huggingface incomplete");
  cleanupOldFiles(HF_MODEL_LOCK_DIR, ".lock", "huggingface lock");
}

async function getOrCreateWorker(pythonPath: string): Promise<DiaWorkerClient> {
  if (sharedWorker) {
    return sharedWorker;
  }

  cleanupStaleHfArtifacts();

  appendDiaLog(`starting persistent Dia worker: ${DIA_WORKER_SCRIPT}`);
  const worker = new DiaWorkerClient(pythonPath);

  try {
    await Promise.race([
      worker.waitReady(),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(
            "Dia worker startup timed out after 8 minutes. " +
            "Likely causes: first model download is very slow/stalled, or a partial HuggingFace cache download. " +
            "Try setting HF_TOKEN and deleting stale *.incomplete files in ~/.cache/huggingface/hub/models--nari-labs--Dia-1.6B-0626/blobs/."
          ));
        }, WORKER_READY_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    appendDiaLog(`worker failed to become ready: ${(err as Error).message}`);
    await worker.shutdown();
    throw err;
  }

  sharedWorker = worker;
  appendDiaLog("Dia worker ready");
  return worker;
}

export async function shutdownDiaWorker(): Promise<void> {
  if (!sharedWorker) return;
  const worker = sharedWorker;
  sharedWorker = null;
  await worker.shutdown();
}

// ── Provider ───────────────────────────────────────────────────────────────

export function createDiaProvider(): TTSProvider {
  return {
    name: PROVIDER_NAME,
    supportedLanguages: ["en"],

    async isAvailable(): Promise<boolean> {
      if (!isVenvValid(VENV_PATH)) return false;

      try {
        const pythonPath = path.join(VENV_PATH, "bin", "python");
        const result = await runPythonCheck(pythonPath, "import dia; print('ok')");
        return result.trim() === "ok";
      } catch {
        return false;
      }
    },

    async install(
      onProgress: (msg: string) => void,
      _onConfirm: (msg: string) => Promise<boolean>,
    ): Promise<void> {
      onProgress("Creating Python virtual environment...");
      await createVenv(VENV_PATH);

      onProgress("Installing Dia TTS from GitHub (this may take a few minutes)...");
      await installPackages(VENV_PATH, { [DIA_GIT_URL]: "" }, onProgress);

      // Verify
      onProgress("Verifying installation...");
      const pythonPath = path.join(VENV_PATH, "bin", "python");
      try {
        await runPythonCheck(pythonPath, "import dia; print('ok')");
      } catch (err) {
        throw new Error(
          `Dia installation verification failed: ${(err as Error).message}\n` +
            `Try manually: ${pythonPath} -c "import dia"`,
        );
      }

      onProgress("Dia TTS installed successfully!");
    },

    async generateAudio(
      script: DialogueScript,
      onProgress: (phase: string, progress: number) => void,
      signal?: AbortSignal,
      options?: TTSGenerationOptions,
    ): Promise<TTSResult> {
      const pythonPath = path.join(VENV_PATH, "bin", "python");
      const chunks = groupBySection(script.segments);
      const totalSections = chunks.length;

      if (totalSections === 0) {
        throw new Error("No dialogue chunks available for Dia generation");
      }

      const fastMode = options?.fastMode === true;
      const gapMs = fastMode ? SECTION_GAP_MS_FAST : SECTION_GAP_MS;
      const cacheDir = options?.cacheDir ?? DEFAULT_CACHE_DIR;
      fs.mkdirSync(cacheDir, { recursive: true });

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-hub-dia-"));
      const outputPath = path.join(tmpDir, "output.wav");
      const timestampsPath = path.join(tmpDir, "timestamps.json");

      const requestId = crypto.randomUUID();

      try {
        onProgress(
          fastMode ? "Preparing Dia worker (fast mode)..." : "Preparing Dia worker...",
          0,
        );

        const worker = await getOrCreateWorker(pythonPath);

        if (signal) {
          signal.addEventListener(
            "abort",
            () => worker.cancel(requestId),
            { once: true },
          );
        }

        let cacheHits = 0;
        await worker.generateReview(
          requestId,
          chunks,
          outputPath,
          timestampsPath,
          { cacheDir, gapMs, fastMode },
          (evt) => {
            if (evt.phase === "loading") {
              onProgress("Loading Dia model...", 0.05);
              return;
            }

            if (evt.phase === "saving") {
              onProgress("Saving generated audio...", 0.95);
              return;
            }

            if (evt.phase === "generating") {
              const idx = (evt.sectionIndex ?? 0) + 1;
              const pct = evt.percent ?? idx / totalSections;
              cacheHits = evt.cacheHits ?? cacheHits;
              const cacheInfo = cacheHits > 0 ? `, cache hits: ${cacheHits}` : "";
              const cachedFlag = evt.cached ? " (cached)" : "";
              onProgress(
                `Generating audio: section ${idx}/${totalSections}${cachedFlag}${cacheInfo}`,
                0.08 + pct * 0.84,
              );
            }
          },
        );

        if (!fs.existsSync(outputPath)) {
          throw new Error("Dia generation produced no output file");
        }

        // Convert to MP3
        onProgress("Converting to MP3...", 0.95);
        const mp3Path = outputPath.replace(".wav", ".mp3");
        const finalPath = await convertToMp3(outputPath, mp3Path);

        // Read audio buffer
        const audioBuffer = fs.readFileSync(finalPath);
        const format = finalPath.endsWith(".mp3") ? "mp3" as const : "wav" as const;

        // Read timestamps
        let sectionTimestamps: SectionTimestamp[] = [];
        if (fs.existsSync(timestampsPath)) {
          sectionTimestamps = JSON.parse(fs.readFileSync(timestampsPath, "utf-8"));
        }

        onProgress("Audio generation complete!", 1);

        return { audioBuffer, format, sectionTimestamps };
      } finally {
        try {
          fs.rmSync(tmpDir, { recursive: true });
        } catch {
          // Ignore
        }
      }
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function groupBySection(segments: ScriptSegment[]): SectionChunk[] {
  const chunks: SectionChunk[] = [];
  let currentSectionId = "";
  let currentLines: string[] = [];

  for (const seg of segments) {
    if (seg.sectionId !== currentSectionId) {
      if (currentLines.length > 0) {
        chunks.push({ sectionId: currentSectionId, text: currentLines.join("\n") });
      }
      currentSectionId = seg.sectionId;
      currentLines = [];
    }

    let line = `[${seg.speaker}]`;
    if (seg.direction) {
      line += ` (${seg.direction})`;
    }
    line += ` ${seg.text}`;
    currentLines.push(line);
  }

  if (currentLines.length > 0) {
    chunks.push({ sectionId: currentSectionId, text: currentLines.join("\n") });
  }

  return chunks;
}

function runPythonCheck(pythonPath: string, code: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const proc = spawn(pythonPath, ["-c", code], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (d) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Python check failed: ${stderr.slice(0, 300)}`));
    });

    proc.on("error", (err) => reject(err));
  });
}
