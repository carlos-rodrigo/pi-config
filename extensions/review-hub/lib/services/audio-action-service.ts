/**
 * AudioActionService — manages audio lifecycle status and regeneration actions.
 *
 * Delegates regeneration to the runtime bridge, which calls the TTS pipeline
 * in the extension. Tracks generation state for polling by the frontend.
 *
 * Scaffold — full implementation in task 011.
 */

import type { ReviewManifest } from "../manifest.js";
import { saveManifest } from "../manifest.js";
import type { ReviewRuntimeBridge } from "../runtime-bridge.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type AudioState = "not-requested" | "generating" | "ready" | "failed";

export interface AudioStatus {
  state: AudioState;
  reason?: string;
  progress?: number;
}

export interface RegenerateResult {
  accepted: boolean;
  status: AudioState;
}

// ── Service ────────────────────────────────────────────────────────────────

export class AudioActionService {
  constructor(
    private bridge: ReviewRuntimeBridge,
  ) {}

  /**
   * Get current audio status from manifest state.
   */
  getStatus(manifest: ReviewManifest): AudioStatus {
    const state: AudioState = manifest.audioState ?? (manifest.audio ? "ready" : "not-requested");

    return {
      state,
      reason: manifest.audioFailureReason,
    };
  }

  /**
   * Request audio regeneration via the runtime bridge.
   * Scaffold — full state management in task 011.
   */
  async regenerate(
    manifest: ReviewManifest,
    reviewDir: string,
    options?: { fastAudio?: boolean },
  ): Promise<RegenerateResult> {
    const currentStatus = this.getStatus(manifest);

    if (currentStatus.state === "generating") {
      return { accepted: false, status: "generating" };
    }

    // Mark as generating
    manifest.audioState = undefined; // will be set by the pipeline
    manifest.audioFailureReason = undefined;

    try {
      await this.bridge.requestAudioRegeneration(manifest.id, options);
      return { accepted: true, status: "generating" };
    } catch (err) {
      manifest.audioState = "failed";
      manifest.audioFailureReason = (err as Error).message;
      await saveManifest(manifest, reviewDir);
      return { accepted: false, status: "failed" };
    }
  }
}
