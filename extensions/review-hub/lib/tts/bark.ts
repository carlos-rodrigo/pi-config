/**
 * Bark TTS Provider — Spanish dialogue synthesis via Bark multilingual model.
 * Full implementation in task 009.
 */

import type { TTSProvider } from "./provider.js";

export function createBarkProvider(): TTSProvider {
  return {
    name: "bark",
    supportedLanguages: ["es"],

    async isAvailable() {
      return false; // TODO: task 009
    },

    async install(_onProgress, _onConfirm) {
      throw new Error("Bark TTS installation not yet implemented (task 009)");
    },

    async generateAudio(_script, _onProgress, _signal) {
      throw new Error("Bark TTS generation not yet implemented (task 009)");
    },
  };
}
