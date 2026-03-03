/**
 * HighlightLayer — renders anchored quote indicators within section blocks.
 *
 * Shows the quoted text with visual state (exact/reanchored/degraded) as
 * clickable badges that navigate to the corresponding comment.
 */

import { memo } from "react";
import { cn } from "@/lib/utils";
import type { AnchorResolution } from "@/lib/anchor/reanchor";
import type { ReviewComment } from "@/lib/api";

// ── Types ──────────────────────────────────────────────────────────────────

export interface HighlightEntry {
  comment: ReviewComment;
  resolution: AnchorResolution;
}

export interface HighlightLayerProps {
  /** Highlights for a single section */
  highlights: HighlightEntry[];
  /** Called when clicking a highlight to navigate to comment */
  onHighlightClick?: (commentId: string) => void;
  className?: string;
}

// ── Component ──────────────────────────────────────────────────────────────

export const HighlightLayer = memo(function HighlightLayer({
  highlights,
  onHighlightClick,
  className,
}: HighlightLayerProps) {
  if (highlights.length === 0) return null;

  return (
    <div className={cn("highlight-layer mt-1 flex flex-wrap gap-1", className)}>
      {highlights.map(({ comment, resolution }) => (
        <HighlightChip
          key={comment.id}
          comment={comment}
          resolution={resolution}
          onClick={onHighlightClick}
        />
      ))}
    </div>
  );
});

// ── Highlight chip ─────────────────────────────────────────────────────────

interface HighlightChipProps {
  comment: ReviewComment;
  resolution: AnchorResolution;
  onClick?: (commentId: string) => void;
}

const STATE_STYLES: Record<AnchorResolution["state"], string> = {
  exact: "bg-yellow-100 dark:bg-yellow-900/30 border-yellow-300 dark:border-yellow-700 text-yellow-800 dark:text-yellow-200",
  reanchored: "bg-orange-100 dark:bg-orange-900/30 border-orange-300 dark:border-orange-700 text-orange-800 dark:text-orange-200",
  degraded: "bg-red-100 dark:bg-red-900/30 border-red-300 dark:border-red-700 text-red-800 dark:text-red-200",
};

const STATE_ICONS: Record<AnchorResolution["state"], string> = {
  exact: "📌",
  reanchored: "🔄",
  degraded: "⚠️",
};

const HighlightChip = memo(function HighlightChip({
  comment,
  resolution,
  onClick,
}: HighlightChipProps) {
  const quote = comment.anchor?.quote ?? "";
  const displayQuote = quote.length > 40 ? quote.slice(0, 37) + "…" : quote;

  return (
    <button
      type="button"
      onClick={() => onClick?.(comment.id)}
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs transition-opacity hover:opacity-80",
        STATE_STYLES[resolution.state],
      )}
      title={
        resolution.state === "degraded"
          ? `⚠️ ${resolution.warning ?? "Could not locate quoted text"}`
          : resolution.state === "reanchored"
            ? `🔄 ${resolution.warning ?? "Quote found at different position"}`
            : `📌 Exact match`
      }
    >
      <span aria-hidden>{STATE_ICONS[resolution.state]}</span>
      <span className="max-w-[200px] truncate italic">&ldquo;{displayQuote}&rdquo;</span>
    </button>
  );
});
