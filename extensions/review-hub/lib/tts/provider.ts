/**
 * TTS Provider Interface — Pluggable text-to-speech for Review Hub.
 *
 * Defines the contract that Dia (English) and Bark (Spanish) implement.
 * Each provider handles its own installation, model loading, and audio generation.
 */

import type { DialogueScript } from "../script-generator.js";

// ── Types ──────────────────────────────────────────────────────────────────

/** Pluggable TTS provider interface. */
export interface TTSProvider {
  /** Provider name (e.g. "dia", "bark") */
  name: string;
  /** Supported language codes */
  supportedLanguages: string[];

  /** Check if the provider's dependencies are installed and ready. */
  isAvailable(): Promise<boolean>;

  /** Install the provider's dependencies (venv, pip packages, model download). */
  install(
    onProgress: (msg: string) => void,
    onConfirm: (msg: string) => Promise<boolean>,
  ): Promise<void>;

  /**
   * Generate audio from a dialogue script.
   * @param script - The structured dialogue script
   * @param onProgress - Progress callback with phase name and 0-1 progress
   * @param signal - Optional abort signal
   * @returns Audio buffer with format and section timestamps
   */
  generateAudio(
    script: DialogueScript,
    onProgress: (phase: string, progress: number) => void,
    signal?: AbortSignal,
  ): Promise<TTSResult>;
}

/** Result of audio generation. */
export interface TTSResult {
  /** Raw audio data */
  audioBuffer: Buffer;
  /** Audio format */
  format: "wav" | "mp3";
  /** Per-section start/end times for waveform mapping */
  sectionTimestamps: SectionTimestamp[];
}

/** Timestamp range for a single section in the audio. */
export interface SectionTimestamp {
  /** References ReviewSection.id */
  sectionId: string;
  /** Start time in seconds */
  startTime: number;
  /** End time in seconds */
  endTime: number;
}

// ── Provider Selection ─────────────────────────────────────────────────────

/**
 * Select the appropriate TTS provider for a language.
 *
 * - English → Dia (Nari Labs, native dialogue support)
 * - Spanish → Bark (multilingual, voice presets)
 *
 * Returns a lazy-loaded provider instance.
 */
export async function selectProvider(language: string): Promise<TTSProvider> {
  if (language === "es") {
    const { createBarkProvider } = await import("./bark.js");
    return createBarkProvider();
  }
  // Default to Dia for English
  const { createDiaProvider } = await import("./dia.js");
  return createDiaProvider();
}
