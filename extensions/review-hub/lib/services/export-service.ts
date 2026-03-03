/**
 * ExportService — generates compact markdown feedback from review comments.
 *
 * Serializes open comments into a deterministic, token-efficient format
 * suitable for agent consumption. Returns an exportHash for tamper detection.
 */

import * as crypto from "node:crypto";
import type { ReviewManifest, ReviewComment } from "../manifest.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ExportResult {
  markdown: string;
  exportHash: string;
  stats: {
    totalComments: number;
    openComments: number;
    resolvedComments: number;
  };
}

export interface ExportOptions {
  /** Which comments to include. Defaults to "open". */
  scope?: "open" | "all";
}

// ── Service ────────────────────────────────────────────────────────────────

export class ExportService {
  /**
   * Generate compact markdown export from a manifest.
   * Placeholder — full implementation in task 009.
   */
  export(manifest: ReviewManifest, options: ExportOptions = {}): ExportResult {
    const scope = options.scope ?? "open";

    const comments = scope === "open"
      ? manifest.comments.filter((c) => c.status !== "resolved")
      : manifest.comments;

    const totalComments = manifest.comments.length;
    const openComments = manifest.comments.filter((c) => c.status !== "resolved").length;
    const resolvedComments = totalComments - openComments;

    // Sort by section order (document order), then creation time
    const sectionOrder = new Map(manifest.sections.map((s, i) => [s.id, i]));
    const sorted = [...comments].sort((a, b) => {
      const sectionDiff = (sectionOrder.get(a.sectionId) ?? 999) - (sectionOrder.get(b.sectionId) ?? 999);
      if (sectionDiff !== 0) return sectionDiff;
      return a.createdAt.localeCompare(b.createdAt);
    });

    const lines: string[] = [
      "# Review Feedback (open items)",
      `Source: ${manifest.source}`,
      `Review: ${manifest.id}`,
      "",
    ];

    for (const comment of sorted) {
      const quote = comment.anchor?.quote
        ? `quote: "${truncateQuote(comment.anchor.quote, 280)}"`
        : "[no anchor]";
      lines.push(`- [${comment.type}][${comment.priority}] section: ${comment.sectionId}`);
      lines.push(`  ${quote}`);
      lines.push(`  action: ${comment.text}`);
      lines.push("");
    }

    const markdown = lines.join("\n").trimEnd() + "\n";
    const exportHash = crypto.createHash("sha256").update(markdown, "utf-8").digest("hex");

    return {
      markdown,
      exportHash,
      stats: { totalComments, openComments, resolvedComments },
    };
  }
}

function truncateQuote(quote: string, maxLength: number): string {
  if (quote.length <= maxLength) return quote;
  return quote.slice(0, maxLength).trimEnd() + "…";
}
