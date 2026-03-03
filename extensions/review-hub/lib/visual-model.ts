/**
 * Visual model builder — produces a canonical section render payload
 * for the frontend, preventing parser drift between backend and client.
 *
 * The backend is the single authority for section identity and line ranges.
 * The frontend receives pre-sliced markdown per section and renders with
 * react-markdown, never deriving section IDs independently.
 */

import type { ReviewManifest } from "./manifest.js";

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * A single renderable section for the frontend.
 * Includes the raw markdown slice and all metadata needed for
 * navigation, anchoring, and drift detection.
 */
export interface RenderSection {
  /** Stable section ID from the manifest (e.g. "s-user-stories--us-003") */
  sectionId: string;
  /** Full heading hierarchy */
  headingPath: string[];
  /** Markdown heading level (1–6) */
  headingLevel: number;
  /** Raw markdown content for this section (heading line through end of section) */
  markdown: string;
  /** SHA-256 hash of the section content at generation time, for drift detection */
  sourceTextHash: string;
}

// ── Builder ────────────────────────────────────────────────────────────────

/**
 * Build the visual model from a manifest and source markdown content.
 *
 * Slices the source into per-section markdown chunks using the manifest's
 * line ranges (1-based, inclusive). Returns sections in manifest order.
 */
export function buildVisualModel(
  manifest: ReviewManifest,
  sourceContent: string,
): RenderSection[] {
  const lines = sourceContent.split("\n");

  return manifest.sections.map((section) => {
    // Line ranges are 1-based and inclusive
    const startIdx = Math.max(0, section.sourceLineStart - 1);
    const endIdx = Math.min(lines.length, section.sourceLineEnd);
    const markdown = lines.slice(startIdx, endIdx).join("\n");

    return {
      sectionId: section.id,
      headingPath: section.headingPath,
      headingLevel: section.headingLevel,
      markdown,
      sourceTextHash: section.sourceTextHash,
    };
  });
}
