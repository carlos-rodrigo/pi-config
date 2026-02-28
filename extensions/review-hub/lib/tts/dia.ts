/**
 * Dia TTS Provider — English dialogue synthesis via Nari Labs Dia model.
 *
 * Dia natively supports multi-speaker dialogue with [S1]/[S2] tags,
 * producing expressive, natural-sounding conversations.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type { TTSProvider, TTSResult, SectionTimestamp } from "./provider.js";
import type { DialogueScript, ScriptSegment } from "../script-generator.js";
import { getVenvPath, createVenv, installPackages, isVenvValid, convertToMp3 } from "./installer.js";

// ── Constants ──────────────────────────────────────────────────────────────

const PROVIDER_NAME = "dia";
const VENV_PATH = getVenvPath(PROVIDER_NAME);
const PYTHON_SCRIPT = path.resolve(
  path.dirname(import.meta.url.replace("file://", "")),
  "..",
  "..",
  "python",
  "generate_dia.py",
);

const REQUIREMENTS: Record<string, string> = {
  "dia-tts": "",       // Latest compatible version
  torch: "",           // Will install appropriate version for platform
  numpy: "",
  soundfile: "",
};

const SECTION_GAP_MS = 300; // Silence between sections in milliseconds

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
      onConfirm: (msg: string) => Promise<boolean>,
    ): Promise<void> {
      onProgress("Creating Python virtual environment...");
      await createVenv(VENV_PATH);

      onProgress("Installing Dia TTS and dependencies...");
      await installPackages(VENV_PATH, REQUIREMENTS, onProgress);

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
    ): Promise<TTSResult> {
      const pythonPath = path.join(VENV_PATH, "bin", "python");

      // Group segments by section for chunk processing
      const chunks = groupBySection(script.segments);
      const totalSections = chunks.length;

      // Write script to temp file
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-hub-dia-"));
      const scriptPath = path.join(tmpDir, "script.json");
      const outputPath = path.join(tmpDir, "output.wav");
      const timestampsPath = path.join(tmpDir, "timestamps.json");

      fs.writeFileSync(scriptPath, JSON.stringify({
        segments: script.segments,
        chunks,
        gapMs: SECTION_GAP_MS,
      }), "utf-8");

      try {
        onProgress("Loading Dia model...", 0);

        // Spawn Python process
        const proc = spawn(pythonPath, [
          PYTHON_SCRIPT,
          "--script", scriptPath,
          "--output", outputPath,
        ], {
          stdio: ["pipe", "pipe", "pipe"],
        });

        // Handle abort
        if (signal) {
          signal.addEventListener("abort", () => {
            proc.kill("SIGTERM");
          }, { once: true });
        }

        // Read progress from stdout
        await processOutput(proc, (progress) => {
          if (progress.phase === "loading") {
            onProgress("Loading Dia model...", 0.05);
          } else if (progress.phase === "generating") {
            const pct = (progress.sectionIndex! + 1) / totalSections;
            onProgress(
              `Generating audio: section ${progress.sectionIndex! + 1}/${totalSections}`,
              0.1 + pct * 0.8,
            );
          } else if (progress.phase === "saving") {
            onProgress("Saving audio file...", 0.95);
          }
        });

        // Read output
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
        // Cleanup temp dir
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

interface SectionChunk {
  sectionId: string;
  text: string; // Combined dialogue with [S1]/[S2] tags
}

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

interface ProgressEvent {
  phase: "loading" | "generating" | "saving" | "done";
  sectionIndex?: number;
  sectionId?: string;
}

function processOutput(
  proc: ChildProcess,
  onProgress: (event: ProgressEvent) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as ProgressEvent;
          onProgress(event);
        } catch {
          // Not JSON — might be regular output
        }
      }
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Dia generation failed (exit ${code}): ${stderr.slice(0, 500)}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn Dia: ${err.message}`));
    });
  });
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
