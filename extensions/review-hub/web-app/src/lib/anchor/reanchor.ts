/**
 * Re-anchor engine — resolves persisted anchor payloads against current section text.
 *
 * Strategy order (per design §4.2):
 * 1. Offset match + quote verification (exact)
 * 2. Quote search fallback, optionally scored by prefix/suffix proximity (reanchored)
 * 3. Section-level degraded fallback
 *
 * Uses the same normalization contract as capture.ts.
 */

import { normalizeTextForAnchoring } from "./capture";

// ── Types ──────────────────────────────────────────────────────────────────

export interface AnchorResolution {
  state: "exact" | "reanchored" | "degraded";
  startOffset?: number;
  endOffset?: number;
  warning?: string;
}

export interface ResolveAnchorInput {
  quote: string;
  prefix?: string;
  suffix?: string;
  startOffset?: number;
  endOffset?: number;
  sectionText: string;
}

// ── Main resolver ──────────────────────────────────────────────────────────

/**
 * Resolve an anchor against the current section text.
 *
 * Returns the resolution state and (if resolvable) the character offsets
 * within the normalized section text.
 */
export function resolveAnchor(input: ResolveAnchorInput): AnchorResolution {
  const normalizedSection = normalizeTextForAnchoring(input.sectionText);
  const normalizedQuote = normalizeTextForAnchoring(input.quote);

  if (!normalizedQuote || !normalizedSection) {
    return { state: "degraded", warning: "Empty quote or section text" };
  }

  // Handle truncated quotes (ending with …) — search using the non-ellipsis prefix
  const searchQuote = normalizedQuote.endsWith("…")
    ? normalizedQuote.slice(0, -1)
    : normalizedQuote;

  // ── Strategy 1: Offset match + quote verification ────────────────

  if (input.startOffset != null && input.endOffset != null) {
    const atOffset = normalizedSection.slice(input.startOffset, input.endOffset);
    const normalizedAtOffset = normalizeTextForAnchoring(atOffset);

    if (normalizedAtOffset === normalizedQuote || normalizedAtOffset.startsWith(searchQuote)) {
      return {
        state: "exact",
        startOffset: input.startOffset,
        endOffset: input.endOffset,
      };
    }
  }

  // ── Strategy 2: Quote search (optionally scored by context) ──────

  const occurrences = findAllOccurrences(normalizedSection, searchQuote);

  if (occurrences.length === 1) {
    const matchStart = occurrences[0];
    const matchEnd = matchStart + searchQuote.length;
    const isExact = input.startOffset == null; // no offset was provided
    return {
      state: isExact ? "exact" : "reanchored",
      startOffset: matchStart,
      endOffset: matchEnd,
      ...(isExact ? {} : { warning: "Quote found at different offset" }),
    };
  }

  if (occurrences.length > 1) {
    // Disambiguate using prefix/suffix scoring
    const best = scoreBestMatch(occurrences, searchQuote.length, normalizedSection, input);
    return {
      state: input.startOffset == null ? "exact" : "reanchored",
      startOffset: best.start,
      endOffset: best.end,
      ...(input.startOffset != null ? { warning: "Quote found at different offset (disambiguated by context)" } : {}),
    };
  }

  // ── Strategy 3: Degraded fallback ────────────────────────────────

  return {
    state: "degraded",
    warning: "Quote not found in current section text",
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Find all occurrences of `needle` in `haystack`.
 * Returns array of start offsets.
 */
function findAllOccurrences(haystack: string, needle: string): number[] {
  const result: number[] = [];
  let pos = 0;
  while (pos <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, pos);
    if (idx < 0) break;
    result.push(idx);
    pos = idx + 1;
  }
  return result;
}

/**
 * Score each occurrence by proximity to prefix/suffix context.
 * Returns the best match { start, end }.
 */
function scoreBestMatch(
  occurrences: number[],
  quoteLength: number,
  sectionText: string,
  input: ResolveAnchorInput,
): { start: number; end: number } {
  const normalizedPrefix = input.prefix ? normalizeTextForAnchoring(input.prefix) : "";
  const normalizedSuffix = input.suffix ? normalizeTextForAnchoring(input.suffix) : "";

  let bestIdx = 0;
  let bestScore = -Infinity;

  for (let i = 0; i < occurrences.length; i++) {
    const start = occurrences[i];
    const end = start + quoteLength;
    let score = 0;

    if (normalizedPrefix) {
      const beforeText = sectionText.slice(Math.max(0, start - normalizedPrefix.length - 20), start);
      if (beforeText.includes(normalizedPrefix)) {
        score += 2;
      }
    }

    if (normalizedSuffix) {
      const afterText = sectionText.slice(end, end + normalizedSuffix.length + 20);
      if (afterText.includes(normalizedSuffix)) {
        score += 2;
      }
    }

    // Tie-break: prefer the occurrence closest to the original offset
    if (input.startOffset != null) {
      const distance = Math.abs(start - input.startOffset);
      score -= distance / 10000; // small penalty for distance
    }

    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return {
    start: occurrences[bestIdx],
    end: occurrences[bestIdx] + quoteLength,
  };
}
