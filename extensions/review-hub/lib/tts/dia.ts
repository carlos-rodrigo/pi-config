/**
 * Dia TTS Provider — English dialogue synthesis via Nari Labs Dia model.
 * Full implementation in task 008.
 */

import type { TTSProvider } from "./provider.js";

export function createDiaProvider(): TTSProvider {
  return {
    name: "dia",
    supportedLanguages: ["en"],

    async isAvailable() {
      return false; // TODO: task 008
    },

    async install(_onProgress, _onConfirm) {
      throw new Error("Dia TTS installation not yet implemented (task 008)");
    },

    async generateAudio(_script, _onProgress, _signal) {
      throw new Error("Dia TTS generation not yet implemented (task 008)");
    },
  };
}
