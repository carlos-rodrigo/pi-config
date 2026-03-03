/**
 * Anchor capture — builds v2 anchor payloads from text selections.
 *
 * Pure functions that work with raw text (no DOM dependency).
 * The hook layer (useSelectionAnchor) bridges DOM Selection API to these.
 *
 * Normalization contract (shared with re-anchor logic):
 * 1. Convert line endings to \n
 * 2. Collapse whitespace runs to single space
 * 3. Compute offsets against normalized text (UTF-16)
 */

// ── Constants ──────────────────────────────────────────────────────────────

/** Maximum length for the captured quote text. */
export const MAX_QUOTE_LENGTH = 280;

/** Maximum length for prefix/suffix context. */
export const MAX_CONTEXT_LENGTH = 80;

// ── Types ──────────────────────────────────────────────────────────────────

export interface AnchorPayload {
  version: 2;
  sectionId: string;
  quote: string;
  prefix?: string;
  suffix?: string;
  startOffset?: number;
  endOffset?: number;
  sectionHashAtCapture?: string;
  anchorAlgoVersion: "v2-section-text";
}

export interface BuildAnchorInput {
  sectionId: string;
  sectionText: string;
  selectedQuote: string;
  sectionHashAtCapture?: string;
}

// ── Normalization ──────────────────────────────────────────────────────────

/**
 * Normalize text for anchoring.
 * Converts CRLF to LF, collapses whitespace runs (except newlines) to single space, trims.
 */
export function normalizeTextForAnchoring(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .trim();
}

// ── Anchor Builder ─────────────────────────────────────────────────────────

/**
 * Build a v2 anchor payload from a text selection within a section.
 *
 * Returns null if the selection is empty or whitespace-only.
 */
export function buildAnchorFromSelection(input: BuildAnchorInput): AnchorPayload | null {
  const normalizedQuote = normalizeTextForAnchoring(input.selectedQuote);
  if (!normalizedQuote) return null;

  const normalizedSection = normalizeTextForAnchoring(input.sectionText);
  const quote = normalizedQuote.length > MAX_QUOTE_LENGTH
    ? normalizedQuote.slice(0, MAX_QUOTE_LENGTH) + "…"
    : normalizedQuote;

  // Find offset within normalized section text
  const startOffset = normalizedSection.indexOf(normalizedQuote);
  const endOffset = startOffset >= 0 ? startOffset + normalizedQuote.length : undefined;

  // Extract prefix/suffix context
  let prefix: string | undefined;
  let suffix: string | undefined;

  if (startOffset >= 0) {
    const rawPrefix = normalizedSection.slice(Math.max(0, startOffset - MAX_CONTEXT_LENGTH), startOffset);
    prefix = rawPrefix.trim() || undefined;

    const rawSuffix = normalizedSection.slice(
      startOffset + normalizedQuote.length,
      startOffset + normalizedQuote.length + MAX_CONTEXT_LENGTH,
    );
    suffix = rawSuffix.trim() || undefined;
  }

  const anchor: AnchorPayload = {
    version: 2,
    sectionId: input.sectionId,
    quote,
    anchorAlgoVersion: "v2-section-text",
  };

  if (prefix) anchor.prefix = prefix;
  if (suffix) anchor.suffix = suffix;
  if (startOffset >= 0) anchor.startOffset = startOffset;
  if (endOffset !== undefined) anchor.endOffset = endOffset;
  if (input.sectionHashAtCapture) anchor.sectionHashAtCapture = input.sectionHashAtCapture;

  return anchor;
}
