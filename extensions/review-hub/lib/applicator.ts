/**
 * Comment Applicator — Applies review comments back to source documents.
 *
 * Reads a completed review manifest, groups comments by section, builds
 * an LLM prompt, and generates an updated document. The user reviews
 * a diff before changes are written.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { ReviewManifest, ReviewComment, ReviewSection } from "./manifest.js";
import { detectDrift, saveManifest } from "./manifest.js";

// ── Types ──────────────────────────────────────────────────────────────────

/** Result of applying review comments. */
export interface ApplyResult {
  /** The updated document content */
  updatedContent: string;
  /** Human-readable diff summary */
  diff: string;
  /** Brief summary for tool result */
  changeSummary: string;
}

/** Options for the apply operation. */
export interface ApplyOptions {
  /** If true, skip the drift check */
  skipDriftCheck?: boolean;
  /** If true, skip the user approval step (for automated testing) */
  skipApproval?: boolean;
}

// ── Comment Type Labels ────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  change: "CHANGE",
  concern: "CONCERN",
  question: "QUESTION",
  approval: "APPROVAL",
};

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Build the LLM prompt for applying review comments to a source document.
 *
 * This is separated from the actual LLM call so it can be used
 * by both the tool (LLM applies) and testing (verify prompt quality).
 */
export function buildApplyPrompt(
  manifest: ReviewManifest,
  sourceContent: string,
): string {
  // Check if there are any actionable comments
  const actionableComments = manifest.comments.filter((c) => c.type !== "approval");
  if (actionableComments.length === 0) {
    return ""; // No changes needed
  }

  // Group comments by section
  const commentsBySection = groupCommentsBySection(manifest.comments, manifest.sections);

  // Build the prompt
  const sectionComments = Array.from(commentsBySection.entries())
    .map(([sectionId, comments]) => {
      const section = manifest.sections.find((s) => s.id === sectionId);
      const title = section
        ? section.headingPath.join(" > ")
        : sectionId;

      const commentLines = comments
        .map((c) => {
          const priority = c.priority !== "medium" ? ` (${c.priority} priority)` : "";
          return `- [${TYPE_LABELS[c.type] ?? c.type}]${priority}: "${c.text}"`;
        })
        .join("\n");

      return `### Section: ${title} (id: ${sectionId})\n${commentLines}`;
    })
    .join("\n\n");

  const docType = manifest.reviewType === "prd" ? "Product Requirements Document (PRD)" : "Technical Design Document";

  return `You are editing a ${docType} based on structured review feedback.

## Current Document

${sourceContent}

## Review Comments (grouped by section)

${sectionComments}

## Instructions

- For **CHANGE** comments: modify the section content as requested by the reviewer
- For **CONCERN** comments: address by adding context, caveats, or modifying the section
- For **QUESTION** comments: add them to an "Open Questions" section at the end of the document (create the section if it doesn't exist)
- For **APPROVAL** comments: leave the section completely unchanged
- Prioritize **HIGH** priority comments over MEDIUM and LOW
- Preserve the document structure, formatting, and all sections not mentioned in comments
- Do NOT remove sections unless a comment explicitly requests it
- Do NOT add new sections unless a comment explicitly requests it (except Open Questions for question comments)

**Output the complete updated document in markdown. Include every section, even unchanged ones.**`;
}

/**
 * Generate a diff summary comparing original and updated content.
 */
export function generateDiffSummary(
  original: string,
  updated: string,
): string {
  const originalLines = original.split("\n");
  const updatedLines = updated.split("\n");

  let added = 0;
  let removed = 0;
  const modifiedSections = new Set<string>();

  // Simple line-by-line comparison
  const maxLen = Math.max(originalLines.length, updatedLines.length);
  let currentSection = "";

  for (let i = 0; i < maxLen; i++) {
    const origLine = originalLines[i] ?? "";
    const updLine = updatedLines[i] ?? "";

    // Track current section
    const headingMatch = (origLine || updLine).match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      currentSection = headingMatch[1]!;
    }

    if (origLine !== updLine) {
      if (i >= originalLines.length) {
        added++;
      } else if (i >= updatedLines.length) {
        removed++;
      } else {
        added++;
        removed++;
      }
      if (currentSection) {
        modifiedSections.add(currentSection);
      }
    }
  }

  const parts: string[] = [];
  if (modifiedSections.size > 0) {
    parts.push(`${modifiedSections.size} section(s) modified`);
  }
  if (added > 0) parts.push(`${added} line(s) added`);
  if (removed > 0) parts.push(`${removed} line(s) removed`);

  if (parts.length === 0) {
    return "No changes";
  }

  const summary = parts.join(", ");
  const sectionList = Array.from(modifiedSections)
    .map((s) => `  • ${s}`)
    .join("\n");

  return `${summary}\n\nModified sections:\n${sectionList}`;
}

/**
 * Generate a brief change summary for tool results.
 */
export function generateChangeSummary(
  manifest: ReviewManifest,
  hasChanges: boolean,
): string {
  if (!hasChanges) {
    return `No actionable changes — all ${manifest.comments.length} comments are approvals.`;
  }

  const typeCounts: Record<string, number> = {};
  for (const c of manifest.comments) {
    typeCounts[c.type] = (typeCounts[c.type] || 0) + 1;
  }

  const parts: string[] = [];
  if (typeCounts.change) parts.push(`${typeCounts.change} change(s)`);
  if (typeCounts.concern) parts.push(`${typeCounts.concern} concern(s) addressed`);
  if (typeCounts.question) parts.push(`${typeCounts.question} question(s) added to Open Questions`);
  if (typeCounts.approval) parts.push(`${typeCounts.approval} approval(s)`);

  const source = path.basename(manifest.source);
  return `Applied ${manifest.comments.length} comments to ${source}: ${parts.join(", ")}`;
}

/**
 * Check if a review is ready to be applied.
 */
export function validateForApply(manifest: ReviewManifest): { valid: boolean; reason?: string } {
  if (manifest.status === "applied") {
    return { valid: false, reason: "Review has already been applied" };
  }

  if (manifest.status !== "reviewed") {
    return { valid: false, reason: `Review status is "${manifest.status}" — must be "reviewed"` };
  }

  if (manifest.comments.length === 0) {
    return { valid: false, reason: "Review has no comments" };
  }

  return { valid: true };
}

/**
 * Check for source drift and return a warning message if drifted.
 */
export async function checkDriftWarning(manifest: ReviewManifest): Promise<string | null> {
  const drift = await detectDrift(manifest);

  if (!drift.hasDrifted) {
    return null;
  }

  const driftedSections = drift.sectionDrifts.filter((s) => s.hasDrifted);
  const sectionList = driftedSections
    .map((s) => `  • ${s.sectionTitle}${s.currentHash === "" ? " (removed)" : " (modified)"}`)
    .join("\n");

  return `The source document has changed since this review was created.\n\n` +
    `${driftedSections.length} section(s) affected:\n${sectionList}\n\n` +
    `Applying comments to the current version may produce unexpected results.`;
}

/**
 * Apply the review by updating the manifest status.
 * The actual document edit is done by the LLM in the main session.
 */
export async function markAsApplied(
  manifest: ReviewManifest,
  reviewDir: string,
): Promise<void> {
  manifest.status = "applied";
  manifest.completedAt = manifest.completedAt ?? new Date().toISOString();
  await saveManifest(manifest, reviewDir);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function groupCommentsBySection(
  comments: ReviewComment[],
  sections: ReviewSection[],
): Map<string, ReviewComment[]> {
  const map = new Map<string, ReviewComment[]>();

  // Initialize with all sections that have comments
  for (const comment of comments) {
    if (!map.has(comment.sectionId)) {
      map.set(comment.sectionId, []);
    }
    map.get(comment.sectionId)!.push(comment);
  }

  // Sort comments within each section: high priority first, then by type
  const typePriority: Record<string, number> = {
    change: 0,
    concern: 1,
    question: 2,
    approval: 3,
  };

  const priorityOrder: Record<string, number> = {
    high: 0,
    medium: 1,
    low: 2,
  };

  for (const [, sectionComments] of map) {
    sectionComments.sort((a, b) => {
      const pa = priorityOrder[a.priority] ?? 1;
      const pb = priorityOrder[b.priority] ?? 1;
      if (pa !== pb) return pa - pb;

      const ta = typePriority[a.type] ?? 2;
      const tb = typePriority[b.type] ?? 2;
      return ta - tb;
    });
  }

  return map;
}
