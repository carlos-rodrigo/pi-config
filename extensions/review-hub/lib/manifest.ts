/**
 * Review manifest system — the central data model for Review Hub.
 *
 * A manifest ties together source sections, podcast script segments,
 * audio timestamps, and reviewer comments. It is created once from a
 * source markdown file and referenced by every other subsystem.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";


// ── Types ──────────────────────────────────────────────────────────────────

/** The central mapping contract between all Review Hub layers. */
export interface ReviewManifest {
  /** Unique review identifier, e.g. "review-001" */
  id: string;
  /** Path to the source markdown file (relative or absolute) */
  source: string;
  /** SHA-256 hash of the full source file at generation time */
  sourceHash: string;
  /** Type of document being reviewed */
  reviewType: "prd" | "design";
  /** Language for podcast/visual generation */
  language: "en" | "es";
  /** ISO timestamp of manifest creation */
  createdAt: string;
  /** ISO timestamp of review completion, or null if not yet complete */
  completedAt: string | null;
  /** Current review lifecycle status */
  status: "generating" | "ready" | "in-progress" | "reviewed" | "applied";

  /** Parsed sections from the source document */
  sections: ReviewSection[];
  /** User comments anchored to sections */
  comments: ReviewComment[];

  /** Audio metadata, populated after TTS generation */
  audio?: {
    /** Audio filename relative to the reviews directory */
    file: string;
    /** Total audio duration in seconds */
    durationSeconds: number;
    /** Script filename relative to the reviews directory */
    scriptFile: string;
  };

  /** Visual metadata */
  visual?: {
    /** Embedded in web app — no separate file */
    file: string;
  };
}

/** A parsed section from the source markdown document. */
export interface ReviewSection {
  /** Stable section ID, e.g. "s-user-stories--us-003" */
  id: string;
  /** Full heading hierarchy, e.g. ["User Stories", "US-003: Filter by Priority"] */
  headingPath: string[];
  /** Markdown heading level (1–6) */
  headingLevel: number;
  /** Disambiguator for duplicate headings (0-based) */
  occurrenceIndex: number;
  /** 1-based start line in the source file */
  sourceLineStart: number;
  /** 1-based end line in the source file (inclusive) */
  sourceLineEnd: number;
  /** SHA-256 of section content for drift detection */
  sourceTextHash: string;

  /** Start time in audio (seconds), populated after TTS */
  audioStartTime?: number;
  /** End time in audio (seconds), populated after TTS */
  audioEndTime?: number;
}

/** A reviewer comment anchored to a section. */
export interface ReviewComment {
  /** Unique comment ID (UUID) */
  id: string;
  /** References ReviewSection.id */
  sectionId: string;
  /** Seconds into audio, if commenting from waveform */
  audioTimestamp?: number;
  /** Comment category */
  type: "change" | "question" | "approval" | "concern";
  /** Urgency level */
  priority: "high" | "medium" | "low";
  /** Comment text */
  text: string;
  /** ISO timestamp of comment creation */
  createdAt: string;
}

/** Result of drift detection between manifest and current source. */
export interface DriftResult {
  /** Whether the overall file hash has changed */
  hasDrifted: boolean;
  /** Current file hash */
  currentHash: string;
  /** Original hash from manifest */
  originalHash: string;
  /** Per-section drift details */
  sectionDrifts: SectionDrift[];
}

/** Drift status for a single section. */
export interface SectionDrift {
  /** Section ID */
  sectionId: string;
  /** Section title (last element of headingPath) */
  sectionTitle: string;
  /** Whether this section's content has changed */
  hasDrifted: boolean;
  /** Current content hash */
  currentHash: string;
  /** Original content hash from manifest */
  originalHash: string;
}

// ── Parsed section (internal) ──────────────────────────────────────────────

interface ParsedSection {
  headingPath: string[];
  headingLevel: number;
  occurrenceIndex: number;
  sourceLineStart: number;
  sourceLineEnd: number;
  content: string;
}

// ── Section ID Generation ──────────────────────────────────────────────────

/**
 * Generate a stable, unambiguous section ID from a heading path.
 *
 * Each heading is slugified (lowercase, non-alphanumeric → hyphens, trimmed).
 * Levels are joined with `--`. Duplicate headings get a numeric suffix.
 *
 * Examples:
 *   ["Introduction"]           → "s-introduction"
 *   ["User Stories", "US-003"] → "s-user-stories--us-003"
 *   ["Goals"] (2nd occurrence) → "s-goals-1"
 */
export function generateSectionId(headingPath: string[], occurrenceIndex: number): string {
  const slug = headingPath
    .map((h) =>
      h
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, ""),
    )
    .join("--");
  const id = `s-${slug}`;
  return occurrenceIndex > 0 ? `${id}-${occurrenceIndex}` : id;
}

// ── SHA-256 Hashing ────────────────────────────────────────────────────────

/** Compute SHA-256 hex hash of a string. */
export function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

// ── Markdown Section Parser ────────────────────────────────────────────────

/**
 * Parse a markdown document into sections based on headings.
 *
 * Strategy:
 * - Split into lines, identify heading lines (`# `, `## `, etc.)
 * - Track heading hierarchy to build `headingPath` arrays
 * - Count duplicate heading occurrences for disambiguation
 * - Record line ranges and content for each section
 */
export function parseMarkdownSections(content: string): ParsedSection[] {
  const lines = content.split("\n");
  const sections: ParsedSection[] = [];

  // Track heading hierarchy: headingStack[level - 1] = heading text
  const headingStack: (string | undefined)[] = [];

  // Track occurrences of full heading paths for disambiguation
  const occurrenceCounts = new Map<string, number>();

  // Track current section being built
  let currentSection: ParsedSection | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1; // 1-based

    // Detect heading: lines starting with one or more # followed by space
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

    if (headingMatch) {
      // Close previous section
      if (currentSection) {
        currentSection.sourceLineEnd = lineNum - 1;
        currentSection.content = lines
          .slice(currentSection.sourceLineStart - 1, currentSection.sourceLineEnd)
          .join("\n");
        sections.push(currentSection);
      }

      const level = headingMatch[1]!.length;
      const headingText = headingMatch[2]!.trim();

      // Update heading stack: set this level, clear deeper levels
      headingStack[level - 1] = headingText;
      for (let j = level; j < headingStack.length; j++) {
        headingStack[j] = undefined;
      }

      // Build heading path from stack
      const headingPath: string[] = [];
      for (let j = 0; j < level; j++) {
        if (headingStack[j] !== undefined) {
          headingPath.push(headingStack[j]!);
        }
      }

      // Track occurrences for disambiguation
      const pathKey = headingPath.join(">>>");
      const occurrence = occurrenceCounts.get(pathKey) ?? 0;
      occurrenceCounts.set(pathKey, occurrence + 1);

      currentSection = {
        headingPath,
        headingLevel: level,
        occurrenceIndex: occurrence,
        sourceLineStart: lineNum,
        sourceLineEnd: -1, // set when section closes
        content: "",
      };
    }
  }

  // Close the last section
  if (currentSection) {
    currentSection.sourceLineEnd = lines.length;
    currentSection.content = lines
      .slice(currentSection.sourceLineStart - 1, currentSection.sourceLineEnd)
      .join("\n");
    sections.push(currentSection);
  }

  return sections;
}

// ── Manifest Creation ──────────────────────────────────────────────────────

/**
 * Create a new review manifest from a source markdown file.
 *
 * Parses the document into sections, assigns stable IDs, computes hashes,
 * and returns a manifest ready for audio/visual generation.
 */
export async function createManifest(
  sourcePath: string,
  reviewType: "prd" | "design",
  language: "en" | "es",
): Promise<ReviewManifest> {
  const resolvedPath = path.resolve(sourcePath);
  const content = fs.readFileSync(resolvedPath, "utf-8");
  const sourceHash = sha256(content);

  const parsedSections = parseMarkdownSections(content);

  const sections: ReviewSection[] = parsedSections.map((ps) => ({
    id: generateSectionId(ps.headingPath, ps.occurrenceIndex),
    headingPath: ps.headingPath,
    headingLevel: ps.headingLevel,
    occurrenceIndex: ps.occurrenceIndex,
    sourceLineStart: ps.sourceLineStart,
    sourceLineEnd: ps.sourceLineEnd,
    sourceTextHash: sha256(ps.content),
  }));

  // Determine next review ID by scanning existing manifests
  const reviewDir = path.join(path.dirname(resolvedPath), "reviews");
  const nextId = getNextReviewId(reviewDir);

  return {
    id: nextId,
    source: sourcePath,
    sourceHash,
    reviewType,
    language,
    createdAt: new Date().toISOString(),
    completedAt: null,
    status: "generating",
    sections,
    comments: [],
  };
}

/**
 * Determine the next review ID by scanning existing manifest files.
 * Returns "review-001", "review-002", etc.
 */
function getNextReviewId(reviewDir: string): string {
  if (!fs.existsSync(reviewDir)) {
    return "review-001";
  }

  const files = fs.readdirSync(reviewDir);
  const manifestFiles = files.filter((f) => f.match(/^review-\d+\.manifest\.json$/));

  if (manifestFiles.length === 0) {
    return "review-001";
  }

  const numbers = manifestFiles.map((f) => {
    const match = f.match(/^review-(\d+)\.manifest\.json$/);
    return match ? parseInt(match[1]!, 10) : 0;
  });

  const maxNum = Math.max(...numbers);
  return `review-${String(maxNum + 1).padStart(3, "0")}`;
}

// ── Manifest I/O ───────────────────────────────────────────────────────────

/**
 * Load a manifest from a JSON file.
 */
export async function loadManifest(manifestPath: string): Promise<ReviewManifest> {
  const resolvedPath = path.resolve(manifestPath);
  const content = fs.readFileSync(resolvedPath, "utf-8");
  return JSON.parse(content) as ReviewManifest;
}

/**
 * Save a manifest to disk using atomic write (temp file + rename).
 *
 * Returns the path to the saved manifest file.
 */
export async function saveManifest(manifest: ReviewManifest, dir: string): Promise<string> {
  const resolvedDir = path.resolve(dir);
  fs.mkdirSync(resolvedDir, { recursive: true });

  const filename = `${manifest.id}.manifest.json`;
  const finalPath = path.join(resolvedDir, filename);
  const tmpPath = path.join(resolvedDir, `.${filename}.tmp.${process.pid}`);

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }

  return finalPath;
}

// ── Drift Detection ────────────────────────────────────────────────────────

/**
 * Detect whether the source file has changed since the manifest was created.
 *
 * Checks both the overall file hash and per-section content hashes.
 * This enables targeted warnings about which sections have been modified.
 */
export async function detectDrift(manifest: ReviewManifest): Promise<DriftResult> {
  const resolvedPath = path.resolve(manifest.source);
  const content = fs.readFileSync(resolvedPath, "utf-8");
  const currentHash = sha256(content);

  const hasDrifted = currentHash !== manifest.sourceHash;

  // Parse current sections for per-section comparison
  const currentSections = parseMarkdownSections(content);

  const sectionDrifts: SectionDrift[] = manifest.sections.map((manifestSection) => {
    // Try to find matching section in current file
    const currentSection = currentSections.find((cs) => {
      const currentId = generateSectionId(cs.headingPath, cs.occurrenceIndex);
      return currentId === manifestSection.id;
    });

    if (!currentSection) {
      // Section was removed or renamed
      return {
        sectionId: manifestSection.id,
        sectionTitle: manifestSection.headingPath[manifestSection.headingPath.length - 1] ?? "",
        hasDrifted: true,
        currentHash: "",
        originalHash: manifestSection.sourceTextHash,
      };
    }

    const currentContentHash = sha256(currentSection.content);
    return {
      sectionId: manifestSection.id,
      sectionTitle: manifestSection.headingPath[manifestSection.headingPath.length - 1] ?? "",
      hasDrifted: currentContentHash !== manifestSection.sourceTextHash,
      currentHash: currentContentHash,
      originalHash: manifestSection.sourceTextHash,
    };
  });

  return {
    hasDrifted,
    currentHash,
    originalHash: manifest.sourceHash,
    sectionDrifts,
  };
}
