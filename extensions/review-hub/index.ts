/**
 * Review Hub — pi extension for interactive PRD & design document reviews.
 *
 * Provides podcast-style audio discussions and cinematic scroll-driven
 * visual presentations with an integrated commenting system that maps
 * feedback back to source document sections.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // ── Lifecycle ────────────────────────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    // TODO: Stop review server when implemented (task 002)
  });

  pi.on("session_start", async (_event, ctx) => {
    // TODO: Cleanup orphan servers when implemented (task 002)
  });

  // ── Commands (placeholders — wired in task 012) ──────────────────────────

  pi.registerCommand("review", {
    description: "Generate an interactive review for a PRD or design document",
    handler: async (args, ctx) => {
      ctx.ui.notify("Review Hub: /review command not yet implemented", "warning");
    },
  });

  pi.registerCommand("review-apply", {
    description: "Apply review comments back to the source document",
    handler: async (args, ctx) => {
      ctx.ui.notify("Review Hub: /review-apply command not yet implemented", "warning");
    },
  });

  pi.registerCommand("review-list", {
    description: "List all reviews for a feature",
    handler: async (args, ctx) => {
      ctx.ui.notify("Review Hub: /review-list command not yet implemented", "warning");
    },
  });
}
