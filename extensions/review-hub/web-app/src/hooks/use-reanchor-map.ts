/**
 * useReanchorMap — computes resolved anchor states for all anchored comments.
 *
 * Re-runs whenever comments or sections change.
 * Returns a map from commentId → AnchorResolution.
 */

import { useMemo } from "react";
import { resolveAnchor, type AnchorResolution } from "@/lib/anchor/reanchor";
import type { ReviewComment } from "@/lib/api";
import type { RenderSection } from "@/lib/api";

export type AnchorMap = Map<string, AnchorResolution>;

/**
 * Compute anchor resolutions for all anchored comments.
 *
 * Comments without anchors are not included in the map.
 */
export function useReanchorMap(
  comments: ReviewComment[],
  sections: RenderSection[],
): AnchorMap {
  return useMemo(() => {
    const sectionTextMap = new Map<string, string>();
    for (const section of sections) {
      sectionTextMap.set(section.sectionId, section.markdown);
    }

    const map = new Map<string, AnchorResolution>();

    for (const comment of comments) {
      if (!comment.anchor) continue;

      const sectionText = sectionTextMap.get(comment.anchor.sectionId) ?? "";
      const resolution = resolveAnchor({
        quote: comment.anchor.quote,
        prefix: comment.anchor.prefix,
        suffix: comment.anchor.suffix,
        startOffset: comment.anchor.startOffset,
        endOffset: comment.anchor.endOffset,
        sectionText,
      });

      map.set(comment.id, resolution);
    }

    return map;
  }, [comments, sections]);
}
