/**
 * FinishService — orchestrates the review completion flow.
 *
 * Handles export hash verification, idempotency, clipboard fallback,
 * and pi handoff via the runtime bridge.
 *
 * Scaffold — full implementation in task 010.
 */

import type { ReviewManifest } from "../manifest.js";
import { saveManifest } from "../manifest.js";
import type { ReviewRuntimeBridge } from "../runtime-bridge.js";
import { ExportService } from "./export-service.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface FinishRequest {
  idempotencyKey: string;
  exportHash: string;
  clipboardMode: "browser" | "backend-fallback";
}

export interface FinishResult {
  success: boolean;
  handedOff: boolean;
  copiedByBackend?: boolean;
  warning?: string;
}

// ── Service ────────────────────────────────────────────────────────────────

export class FinishService {
  constructor(
    private bridge: ReviewRuntimeBridge,
    private exportService: ExportService,
  ) {}

  /**
   * Execute the finish flow: verify export, mark review complete, handoff to pi.
   * Scaffold — full idempotency + error handling in task 010.
   */
  async finish(
    manifest: ReviewManifest,
    reviewDir: string,
    request: FinishRequest,
  ): Promise<FinishResult> {
    // Idempotency check — return success for duplicate keys
    if (
      manifest.finishMeta?.lastFinishIdempotencyKey === request.idempotencyKey &&
      manifest.finishMeta?.lastExportHash === request.exportHash
    ) {
      return {
        success: true,
        handedOff: true,
        warning: "Idempotent replay — finish already completed with this key",
      };
    }

    // Recompute export and verify hash
    const exported = this.exportService.export(manifest);
    if (exported.exportHash !== request.exportHash) {
      return {
        success: false,
        handedOff: false,
        warning: "Export hash mismatch — comments may have changed since preview",
      };
    }

    // Clipboard fallback via bridge
    let copiedByBackend: boolean | undefined;
    if (request.clipboardMode === "backend-fallback") {
      try {
        const clipResult = await this.bridge.copyToClipboard(exported.markdown);
        copiedByBackend = clipResult.copied;
      } catch (err) {
        return {
          success: false,
          handedOff: false,
          copiedByBackend: false,
          warning: `Backend clipboard failed: ${(err as Error).message}`,
        };
      }
    }

    // Mark review as completed
    manifest.status = "reviewed";
    manifest.completedAt = new Date().toISOString();

    if (!manifest.finishMeta) {
      manifest.finishMeta = {};
    }
    manifest.finishMeta.lastFinishIdempotencyKey = request.idempotencyKey;
    manifest.finishMeta.lastExportHash = request.exportHash;
    manifest.finishMeta.lastFinishedAt = manifest.completedAt;

    await saveManifest(manifest, reviewDir);

    // Handoff to pi
    let handedOff = false;
    try {
      await this.bridge.handoffFeedbackToPi(exported.markdown);
      handedOff = true;
    } catch (err) {
      // Non-fatal: review is already marked complete
      return {
        success: true,
        handedOff: false,
        copiedByBackend,
        warning: `Review completed but pi handoff failed: ${(err as Error).message}`,
      };
    }

    return {
      success: true,
      handedOff,
      copiedByBackend,
    };
  }
}
