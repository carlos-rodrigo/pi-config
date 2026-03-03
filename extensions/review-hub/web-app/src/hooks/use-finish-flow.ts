/**
 * useFinishFlow — orchestrates the finish flow from the frontend.
 *
 * Steps:
 * 1. Fetch export preview from /export-feedback
 * 2. Try browser clipboard write
 * 3. If clipboard fails, use /clipboard/copy backend fallback
 * 4. Call /finish with idempotencyKey + exportHash
 * 5. Report result (success/failure/warning)
 */

import { useCallback, useRef, useState } from "react";
import type { ReviewApiClient } from "@/lib/api/client";

// ── Types ──────────────────────────────────────────────────────────────────

export interface FinishFlowState {
  stage: "idle" | "exporting" | "copying" | "finishing" | "done" | "error";
  exportMarkdown: string | null;
  exportHash: string | null;
  error: string | null;
  warning: string | null;
  handedOff: boolean;
  copiedByBackend: boolean;
}

const INITIAL_STATE: FinishFlowState = {
  stage: "idle",
  exportMarkdown: null,
  exportHash: null,
  error: null,
  warning: null,
  handedOff: false,
  copiedByBackend: false,
};

// ── Hook ───────────────────────────────────────────────────────────────────

export function useFinishFlow(client: ReviewApiClient | null) {
  const [state, setState] = useState<FinishFlowState>(INITIAL_STATE);
  const idempotencyKeyRef = useRef<string | null>(null);

  const startFinish = useCallback(async () => {
    if (!client) {
      setState({ ...INITIAL_STATE, stage: "error", error: "No API client available" });
      return;
    }

    // Generate idempotency key for this attempt
    const idempotencyKey = crypto.randomUUID();
    idempotencyKeyRef.current = idempotencyKey;

    try {
      // Step 1: Fetch export
      setState((prev) => ({ ...prev, stage: "exporting", error: null, warning: null }));
      const exported = await client.exportFeedback();
      setState((prev) => ({
        ...prev,
        exportMarkdown: exported.markdown,
        exportHash: exported.exportHash,
      }));

      // Step 2: Try browser clipboard
      setState((prev) => ({ ...prev, stage: "copying" }));
      let clipboardMode: "browser" | "backend-fallback" = "browser";

      try {
        await navigator.clipboard.writeText(exported.markdown);
      } catch {
        // Browser clipboard failed — will use backend fallback
        clipboardMode = "backend-fallback";
      }

      // Step 3: Call /finish
      setState((prev) => ({ ...prev, stage: "finishing" }));
      const result = await client.finish({
        idempotencyKey,
        exportHash: exported.exportHash,
        clipboardMode,
      });

      if (result.success) {
        setState({
          stage: "done",
          exportMarkdown: exported.markdown,
          exportHash: exported.exportHash,
          error: null,
          warning: result.warning ?? null,
          handedOff: result.handedOff,
          copiedByBackend: result.copiedByBackend ?? false,
        });
      } else {
        setState({
          stage: "error",
          exportMarkdown: exported.markdown,
          exportHash: exported.exportHash,
          error: result.warning ?? "Finish failed",
          warning: null,
          handedOff: false,
          copiedByBackend: false,
        });
      }
    } catch (err) {
      setState((prev) => ({
        ...prev,
        stage: "error",
        error: err instanceof Error ? err.message : "Finish flow failed",
      }));
    }
  }, [client]);

  const reset = useCallback(() => {
    setState(INITIAL_STATE);
    idempotencyKeyRef.current = null;
  }, []);

  return { state, startFinish, reset };
}
