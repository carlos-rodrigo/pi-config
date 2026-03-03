/**
 * Runtime bridge — typed contract between the review HTTP server and
 * privileged extension operations (pi messaging, clipboard, audio lifecycle).
 *
 * The server calls bridge methods for actions that require extension-level
 * access (e.g. `pi.sendUserMessage`). The extension wires concrete
 * implementations when constructing the server.
 */

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Callback contract passed from `index.ts` into the review server factory.
 *
 * Each method represents a privileged action that cannot be performed
 * from within the HTTP server alone.
 */
export interface ReviewRuntimeBridge {
  /**
   * Send the canonical feedback markdown to the pi chat input.
   * Wraps `pi.sendUserMessage()`.
   */
  handoffFeedbackToPi(markdown: string): Promise<void>;

  /**
   * Copy markdown to the system clipboard from the backend.
   * Used as fallback when browser Clipboard API is unavailable.
   */
  copyToClipboard(markdown: string): Promise<{ copied: boolean; warning?: string }>;

  /**
   * Trigger audio regeneration for a review.
   * Delegates to the TTS pipeline in the extension.
   */
  requestAudioRegeneration(reviewId: string, options?: { fastAudio?: boolean }): Promise<void>;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Create a no-op bridge where all actions succeed silently.
 * Useful for tests and as a fallback when no real bridge is wired.
 */
export function createNoOpBridge(): ReviewRuntimeBridge {
  return {
    handoffFeedbackToPi: async () => {},
    copyToClipboard: async () => ({ copied: true }),
    requestAudioRegeneration: async () => {},
  };
}
