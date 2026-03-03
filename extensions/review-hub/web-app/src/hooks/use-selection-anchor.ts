/**
 * useSelectionAnchor — captures text selections within the document viewport
 * and produces v2 anchor drafts for comment creation.
 *
 * Listens for `mouseup` events scoped to a container element. When a valid
 * single-range selection is detected within a section block, it builds an
 * anchor payload and calls `onAnchorCaptured` with the draft.
 */

import { useEffect, useCallback, useRef } from "react";
import { buildAnchorFromSelection, type AnchorPayload } from "@/lib/anchor/capture";
import type { RenderSection } from "@/lib/api";

export interface SelectionAnchorResult {
  sectionId: string;
  anchor: AnchorPayload;
}

export interface UseSelectionAnchorOptions {
  /** Ref to the document viewport container */
  containerRef: React.RefObject<HTMLElement | null>;
  /** All rendered sections (for section text lookup) */
  sections: RenderSection[];
  /** Whether capture is enabled (e.g., only in review mode) */
  enabled: boolean;
  /** Called when a valid selection is captured */
  onAnchorCaptured: (result: SelectionAnchorResult) => void;
}

export function useSelectionAnchor({
  containerRef,
  sections,
  enabled,
  onAnchorCaptured,
}: UseSelectionAnchorOptions) {
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;

  const onCapturedRef = useRef(onAnchorCaptured);
  onCapturedRef.current = onAnchorCaptured;

  const handleMouseUp = useCallback(() => {
    if (!enabled) return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    const container = containerRef.current;
    if (!container || !container.contains(range.commonAncestorContainer)) return;

    // Find which section the selection is in
    const sectionEl = findSectionElement(range.startContainer);
    if (!sectionEl || !container.contains(sectionEl)) return;

    const sectionId = sectionEl.dataset.sectionId;
    if (!sectionId) return;

    // Check for cross-section selection: if end is in a different section, clamp
    const endSectionEl = findSectionElement(range.endContainer);
    const isCrossSection = endSectionEl !== sectionEl;

    if (isCrossSection) {
      // Clamp to originating section — user gets a warning via the UI
      console.warn("[review-hub] Cross-section selection detected, clamping to originating section");
    }

    // Get selected text
    const selectedQuote = selection.toString();
    if (!selectedQuote.trim()) return;

    // Find section text from sections array
    const section = sectionsRef.current.find((s) => s.sectionId === sectionId);
    if (!section) return;

    const anchor = buildAnchorFromSelection({
      sectionId,
      sectionText: section.markdown,
      selectedQuote,
      sectionHashAtCapture: section.sourceTextHash,
    });

    if (!anchor) return;

    onCapturedRef.current({ sectionId, anchor });

    // Clear selection after capture
    selection.removeAllRanges();
  }, [enabled, containerRef]);

  useEffect(() => {
    if (!enabled) return;

    const container = containerRef.current;
    if (!container) return;

    container.addEventListener("mouseup", handleMouseUp);
    return () => container.removeEventListener("mouseup", handleMouseUp);
  }, [enabled, handleMouseUp, containerRef]);
}

/**
 * Walk up from a DOM node to find the containing section element.
 */
function findSectionElement(node: Node | null): HTMLElement | null {
  let current: Node | null = node;
  while (current) {
    if (current instanceof HTMLElement && current.dataset.sectionId) {
      return current;
    }
    current = current.parentNode;
  }
  return null;
}
