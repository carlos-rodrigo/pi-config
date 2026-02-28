/**
 * Bark TTS Provider — Multilingual dialogue synthesis via Bark model.
 *
 * Bark supports multiple languages including Spanish, using different
 * speaker presets for S1/S2 voices. Processes segments individually
 * (no native multi-speaker support like Dia).
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type { TTSProvider, TTSResult, SectionTimestamp } from "./provider.js";
import type { DialogueScript, ScriptSegment } from "../script-generator.js";
import { getVenvPath, createVenv, installPackages, isVenvValid, convertToMp3 } from "./installer.js";

// ── Constants ──────────────────────────────────────────────────────────────

const PROVIDER_NAME = "bark";
const VENV_PATH = getVenvPath(PROVIDER_NAME);
const PYTHON_SCRIPT = path.resolve(
  path.dirname(import.meta.url.replace("file://", "")),
  "..",
  "..",
  "python",
  "generate_bark.py",
);

const REQUIREMENTS: Record<string, string> = {
  bark: "",           // suno-bark
  torch: "",
  numpy: "",
  scipy: "",
  soundfile: "",
};

const SECTION_GAP_MS = 400; // Slightly longer gap for Bark (segment-based)

// Speaker presets by language
const SPEAKER_PRESETS: Record<string, { s1: string; s2: string }> = {
  en: { s1: "v2/en_speaker_0", s2: "v2/en_speaker_1" },
  es: { s1: "v2/es_speaker_0", s2: "v2/es_speaker_1" },
};

// ── Provider ───────────────────────────────────────────────────────────────

export function createBarkProvider(): TTSProvider {
  return {
    name: PROVIDER_NAME,
    supportedLanguages: ["en", "es"],

    async isAvailable(): Promise<boolean> {
      if (!isVenvValid(VENV_PATH)) return false;

      try {
        const pythonPath = path.join(VENV_PATH, "bin", "python");
        const result = await runPythonCheck(
          pythonPath,
          'from bark import generate_audio; print("ok")',
        );
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

      onProgress("Installing Bark TTS and dependencies (this may take a while)...");
      await installPackages(VENV_PATH, REQUIREMENTS, onProgress);

      // Verify
      onProgress("Verifying installation...");
      const pythonPath = path.join(VENV_PATH, "bin", "python");
      try {
        await runPythonCheck(pythonPath, 'from bark import generate_audio; print("ok")');
      } catch (err) {
        throw new Error(
          `Bark installation verification failed: ${(err as Error).message}\n` +
            `Try manually: ${pythonPath} -c "from bark import generate_audio"`,
        );
      }

      onProgress("Bark TTS installed successfully!");
    },

    async generateAudio(
      script: DialogueScript,
      onProgress: (phase: string, progress: number) => void,
      signal?: AbortSignal,
    ): Promise<TTSResult> {
      const pythonPath = path.join(VENV_PATH, "bin", "python");

      // Prepare segments with speaker presets
      const totalSegments = script.segments.length;

      // Write script to temp file
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-hub-bark-"));
      const scriptPath = path.join(tmpDir, "script.json");
      const outputPath = path.join(tmpDir, "output.wav");
      const timestampsPath = path.join(tmpDir, "timestamps.json");

      // Detect language from the script's first few segments (or default to es)
      const lang = detectLanguage(script);

      fs.writeFileSync(scriptPath, JSON.stringify({
        segments: script.segments.map((seg) => ({
          ...seg,
          speakerPreset: SPEAKER_PRESETS[lang]?.[seg.speaker.toLowerCase() as "s1" | "s2"]
            ?? SPEAKER_PRESETS.es![seg.speaker.toLowerCase() as "s1" | "s2"],
        })),
        gapMs: SECTION_GAP_MS,
        language: lang,
      }), "utf-8");

      try {
        onProgress("Loading Bark model (this may take a minute)...", 0);

        // Spawn Python process
        const proc = spawn(pythonPath, [
          PYTHON_SCRIPT,
          "--script", scriptPath,
          "--output", outputPath,
          "--lang", lang,
        ], {
          stdio: ["pipe", "pipe", "pipe"],
        });

        // Handle abort
        if (signal) {
          signal.addEventListener("abort", () => {
            proc.kill("SIGTERM");
          }, { once: true });
        }

        // Read progress
        await processOutput(proc, totalSegments, (progress) => {
          if (progress.phase === "loading") {
            onProgress("Loading Bark model...", 0.05);
          } else if (progress.phase === "generating") {
            const pct = (progress.segmentIndex! + 1) / totalSegments;
            const estRemaining = progress.estRemainingSeconds
              ? ` (~${Math.ceil(progress.estRemainingSeconds / 60)}min left)`
              : "";
            onProgress(
              `Generating audio: segment ${progress.segmentIndex! + 1}/${totalSegments}${estRemaining}`,
              0.1 + pct * 0.8,
            );
          } else if (progress.phase === "saving") {
            onProgress("Saving audio file...", 0.95);
          }
        });

        // Read output
        if (!fs.existsSync(outputPath)) {
          throw new Error("Bark generation produced no output file");
        }

        // Convert to MP3
        onProgress("Converting to MP3...", 0.95);
        const mp3Path = outputPath.replace(".wav", ".mp3");
        const finalPath = await convertToMp3(outputPath, mp3Path);

        const audioBuffer = fs.readFileSync(finalPath);
        const format = finalPath.endsWith(".mp3") ? "mp3" as const : "wav" as const;

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

function detectLanguage(script: DialogueScript): string {
  // Simple heuristic: check for Spanish-specific words
  const text = script.segments.slice(0, 5).map((s) => s.text).join(" ").toLowerCase();
  const spanishWords = ["el", "la", "los", "las", "de", "en", "que", "es", "por", "del", "con"];
  const matchCount = spanishWords.filter((w) => text.includes(` ${w} `)).length;
  return matchCount >= 3 ? "es" : "en";
}

interface ProgressEvent {
  phase: "loading" | "generating" | "saving" | "done";
  segmentIndex?: number;
  sectionId?: string;
  estRemainingSeconds?: number;
}

function processOutput(
  proc: ChildProcess,
  totalSegments: number,
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
          // Not JSON
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
        reject(new Error(`Bark generation failed (exit ${code}): ${stderr.slice(0, 500)}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn Bark: ${err.message}`));
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
