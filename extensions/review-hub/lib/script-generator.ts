/**
 * Podcast Script Generator — Creates engaging two-host dialogue scripts
 * from PRD/design documents using a dedicated sub-agent.
 *
 * The generator annotates the source document with section markers,
 * sends it to a pi sub-agent with a screenwriter-quality prompt, and
 * parses the output into structured dialogue segments.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type { ReviewManifest } from "./manifest.js";

// ── Types ──────────────────────────────────────────────────────────────────

/** A complete dialogue script with structured segments. */
export interface DialogueScript {
  /** Ordered dialogue segments mapped to sections */
  segments: ScriptSegment[];
  /** The full raw script text as generated */
  rawScript: string;
}

/** A single dialogue line within the script. */
export interface ScriptSegment {
  /** Maps to ReviewSection.id */
  sectionId: string;
  /** Which host is speaking */
  speaker: "S1" | "S2";
  /** The dialogue text */
  text: string;
  /** Stage direction, e.g. "(laughs)", "(pauses)" */
  direction?: string;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate a podcast dialogue script from a source document.
 *
 * Spawns a pi sub-agent with a specialized screenwriter prompt.
 * The sub-agent generates the full script which is then parsed
 * into structured segments.
 */
export async function generateScript(
  manifest: ReviewManifest,
  sourceContent: string,
  language: "en" | "es",
  onProgress: (msg: string) => void,
): Promise<DialogueScript> {
  onProgress("Preparing document for script generation...");

  // Annotate source with section markers
  const annotatedSource = annotateWithSections(manifest, sourceContent);

  // Build the system prompt
  const systemPrompt = buildSystemPrompt(manifest, language);

  // Build the task prompt
  const taskPrompt = buildTaskPrompt(annotatedSource, manifest, language);

  onProgress("Generating podcast script via sub-agent...");

  // Run sub-agent
  let rawScript: string;
  try {
    rawScript = await runSubAgent(systemPrompt, taskPrompt, onProgress);
  } catch (err) {
    onProgress("First attempt failed, retrying with simplified prompt...");
    // Retry with simplified prompt
    const simplePrompt = buildSimplifiedPrompt(annotatedSource, manifest, language);
    rawScript = await runSubAgent(systemPrompt, simplePrompt, onProgress);
  }

  onProgress("Parsing script into segments...");

  // Parse the raw script
  const segments = parseScript(rawScript, manifest);

  // Validate coverage
  const coveredSections = new Set(segments.map((s) => s.sectionId));
  for (const section of manifest.sections) {
    if (!coveredSections.has(section.id)) {
      console.warn(`[script-generator] Warning: section not covered in script: ${section.id}`);
    }
  }

  const coveredCount = coveredSections.size;
  const totalCount = manifest.sections.length;
  onProgress(`Script complete: ${coveredCount}/${totalCount} sections covered, ${segments.length} dialogue lines`);

  return { segments, rawScript };
}

// ── Source Annotation ──────────────────────────────────────────────────────

/**
 * Annotate the source markdown with section markers.
 * Inserts `<!-- SECTION: {sectionId} -->` before each section's heading.
 */
function annotateWithSections(manifest: ReviewManifest, sourceContent: string): string {
  const lines = sourceContent.split("\n");
  const insertions: { lineIndex: number; marker: string }[] = [];

  for (const section of manifest.sections) {
    // Insert marker before the section's start line (0-indexed)
    const lineIndex = section.sourceLineStart - 1;
    insertions.push({
      lineIndex,
      marker: `<!-- SECTION: ${section.id} -->`,
    });
  }

  // Apply insertions from bottom to top so line indices stay valid
  insertions.sort((a, b) => b.lineIndex - a.lineIndex);
  for (const ins of insertions) {
    lines.splice(ins.lineIndex, 0, ins.marker);
  }

  return lines.join("\n");
}

// ── Prompts ────────────────────────────────────────────────────────────────

function buildSystemPrompt(manifest: ReviewManifest, language: "en" | "es"): string {
  const langName = language === "en" ? "English" : "Spanish";
  const docType = manifest.reviewType === "prd" ? "Product Requirements Document (PRD)" : "Technical Design Document";

  return `You are a screenwriter who creates engaging podcast dialogue scripts.

Your task is to transform technical documents into natural, lively two-host conversations. The hosts are:
- **[S1]** — The Lead Host. Explains concepts clearly, provides context, and drives the conversation forward. Enthusiastic but measured.
- **[S2]** — The Analyst. Asks sharp questions, highlights trade-offs, plays devil's advocate, and brings practical perspective.

## Rules

1. Generate dialogue in **${langName}** only.
2. Cover **every section** of the document. Each section is marked with \`<!-- SECTION: section-id -->\`. You MUST include these exact markers in your output.
3. Keep each section's dialogue proportional to its content — short sections get brief coverage, detailed sections get thorough discussion.
4. Use speaker tags \`[S1]\` and \`[S2]\` at the start of each dialogue line.
5. Include natural conversational elements:
   - Reactions: "Right, and that's the interesting part..."
   - Questions: "But what about the edge case where...?"
   - Emphasis: "(pauses) This is actually really clever."
   - Laughter: "(laughs) Yeah, that's a bold choice."
   - Transitions: "So moving on to the next section..."
6. Open with a brief introduction of the document being reviewed.
7. Close with a summary/recap of key takeaways.
8. Make it sound like a real conversation — back and forth, not a lecture.
9. S2 should genuinely challenge S1's explanations, not just agree.
10. Keep each speaker's turn to 1-3 sentences. Avoid long monologues.

## Output Format

\`\`\`
<!-- SECTION: s-introduction -->
[S1] Today we're looking at this ${docType}...
[S2] Yeah, what caught my eye right away is...

<!-- SECTION: s-goals -->
[S1] So let's talk about what they're trying to achieve here.
[S2] (pauses) There are some ambitious goals in this list.
\`\`\``;
}

function buildTaskPrompt(annotatedSource: string, manifest: ReviewManifest, language: "en" | "es"): string {
  const langName = language === "en" ? "English" : "Spanish";
  const sectionIds = manifest.sections.map((s) => s.id).join(", ");

  return `Generate a podcast dialogue script in ${langName} for the following document.

**IMPORTANT:** You must include ALL of these section markers in your output:
${sectionIds}

Use the format: \`<!-- SECTION: section-id -->\` followed by \`[S1]\` and \`[S2]\` dialogue lines.

Here is the document:

---

${annotatedSource}

---

Generate the complete podcast script now. Start with the introduction and cover every section in order.`;
}

function buildSimplifiedPrompt(annotatedSource: string, manifest: ReviewManifest, language: "en" | "es"): string {
  const langName = language === "en" ? "English" : "Spanish";

  return `Generate a two-host podcast dialogue in ${langName} about this document. Use [S1] and [S2] speaker tags. Include <!-- SECTION: id --> markers for each section.

Document:

${annotatedSource}

Generate the script:`;
}

// ── Sub-Agent Execution ────────────────────────────────────────────────────

/**
 * Run a pi sub-agent with the given prompts and return the text output.
 */
async function runSubAgent(
  systemPrompt: string,
  taskPrompt: string,
  onProgress: (msg: string) => void,
): Promise<string> {
  // Write system prompt to temp file
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-hub-script-"));
  const promptPath = path.join(tmpDir, "system-prompt.md");
  fs.writeFileSync(promptPath, systemPrompt, "utf-8");

  const args = [
    "--mode", "json",
    "-p",
    "--no-session",
    "--append-system-prompt", promptPath,
    taskPrompt,
  ];

  try {
    const output = await new Promise<string>((resolve, reject) => {
      const proc = spawn("pi", args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      const messages: Array<{ role: string; content: string }> = [];

      proc.stdout.on("data", (data) => {
        stdout += data.toString();

        // Parse JSON lines for progress
        const lines = stdout.split("\n");
        stdout = lines.pop() ?? ""; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "message_end" && event.message?.role === "assistant") {
              const content = extractTextContent(event.message);
              if (content) {
                messages.push({ role: "assistant", content });
                // Report progress with section count
                const sectionMatches = content.match(/<!-- SECTION:/g);
                if (sectionMatches) {
                  onProgress(`Script generation: ${sectionMatches.length} sections so far...`);
                }
              }
            }
          } catch {
            // Not valid JSON, skip
          }
        }
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        // Get final output from the last assistant message
        const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
        if (lastAssistant?.content) {
          resolve(lastAssistant.content);
        } else if (code !== 0) {
          reject(new Error(`Sub-agent failed with code ${code}: ${stderr.slice(0, 500)}`));
        } else {
          reject(new Error("Sub-agent produced no output"));
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn sub-agent: ${err.message}`));
      });
    });

    return output;
  } finally {
    // Cleanup temp files
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Extract text content from a pi JSON mode message.
 */
function extractTextContent(message: { content?: Array<{ type: string; text?: string }> }): string {
  if (!message.content) return "";
  return message.content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("");
}

// ── Script Parsing ─────────────────────────────────────────────────────────

/**
 * Parse a raw script string into structured ScriptSegment[].
 *
 * Expected format:
 * ```
 * <!-- SECTION: s-introduction -->
 * [S1] Today we're looking at...
 * [S2] Yeah, what caught my eye...
 * ```
 */
export function parseScript(rawScript: string, manifest: ReviewManifest): ScriptSegment[] {
  const segments: ScriptSegment[] = [];
  const lines = rawScript.split("\n");

  let currentSectionId = manifest.sections[0]?.id ?? "unknown";
  const validSectionIds = new Set(manifest.sections.map((s) => s.id));

  for (const line of lines) {
    // Check for section marker
    const sectionMatch = line.match(/<!--\s*SECTION:\s*(\S+)\s*-->/);
    if (sectionMatch) {
      const id = sectionMatch[1]!;
      if (validSectionIds.has(id)) {
        currentSectionId = id;
      }
      continue;
    }

    // Check for speaker line
    const speakerMatch = line.match(/^\[S([12])\]\s*(.+)$/);
    if (speakerMatch) {
      const speaker = `S${speakerMatch[1]}` as "S1" | "S2";
      let text = speakerMatch[2]!.trim();

      // Extract direction annotations
      let direction: string | undefined;
      const directionMatch = text.match(/^\(([^)]+)\)\s*/);
      if (directionMatch) {
        direction = directionMatch[1]!;
        text = text.slice(directionMatch[0].length);
      }

      // Also check for inline directions
      const inlineDirection = text.match(/\(([^)]+)\)/);
      if (inlineDirection && !direction) {
        direction = inlineDirection[1]!;
      }

      if (text) {
        segments.push({
          sectionId: currentSectionId,
          speaker,
          text,
          direction,
        });
      }
    }
  }

  return segments;
}

/**
 * Save a script to disk as a markdown file.
 */
export async function saveScript(rawScript: string, reviewDir: string, reviewId: string): Promise<string> {
  const resolvedDir = path.resolve(reviewDir);
  fs.mkdirSync(resolvedDir, { recursive: true });

  const filename = `${reviewId}.script.md`;
  const filePath = path.join(resolvedDir, filename);
  fs.writeFileSync(filePath, rawScript, "utf-8");

  return filePath;
}
