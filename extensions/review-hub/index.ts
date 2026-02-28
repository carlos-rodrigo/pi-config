/**
 * Review Hub — pi extension for interactive PRD & design document reviews.
 *
 * Provides podcast-style audio discussions and cinematic scroll-driven
 * visual presentations with an integrated commenting system that maps
 * feedback back to source document sections.
 *
 * Commands: /review, /review-apply, /review-list
 * Tools: review_document, review_apply
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Lib Imports ────────────────────────────────────────────────────────────

import {
  createManifest,
  loadManifest,
  saveManifest,
  type ReviewManifest,
} from "./lib/manifest.js";

import {
  createReviewServer,
  cleanupOrphanServers,
  type ReviewServer,
} from "./lib/server.js";

import {
  generateScript,
  saveScript,
} from "./lib/script-generator.js";

import { selectProvider } from "./lib/tts/provider.js";
import { ensureTTSAvailable } from "./lib/tts/installer.js";

import {
  buildApplyPrompt,
  validateForApply,
  checkDriftWarning,
  markAsApplied,
  generateChangeSummary,
} from "./lib/applicator.js";

// ── Types ──────────────────────────────────────────────────────────────────

interface ReviewOptions {
  path: string;
  audioOnly: boolean;
  visualOnly: boolean;
  language: "en" | "es";
}

interface ReviewDocumentDetails {
  manifestPath?: string;
  url?: string;
  error?: string;
}

interface ReviewApplyDetails {
  applied: boolean;
  reason?: string;
  error?: string;
}

// ── Argument Parsing ───────────────────────────────────────────────────────

/**
 * Parse /review command arguments.
 *
 * Supports:
 *   /review path/to/file.md --audio-only --visual-only --lang en|es
 *   /review @path/to/file.md  (strip leading @, following pi convention)
 */
function parseReviewArgs(args: string): ReviewOptions {
  const parts = args.trim().split(/\s+/);

  let filePath = "";
  let audioOnly = false;
  let visualOnly = false;
  let language: "en" | "es" = "en";

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;

    if (part === "--audio-only") {
      audioOnly = true;
    } else if (part === "--visual-only") {
      visualOnly = true;
    } else if (part === "--lang" && i + 1 < parts.length) {
      const lang = parts[i + 1]!.toLowerCase();
      if (lang === "es" || lang === "en") {
        language = lang;
      }
      i++; // skip the value
    } else if (!filePath) {
      // First non-flag argument is the file path
      filePath = part.startsWith("@") ? part.slice(1) : part;
    }
  }

  return { path: filePath, audioOnly, visualOnly, language };
}

// ── Feature Directory Detection ────────────────────────────────────────────

/**
 * Resolve the reviews directory for a source file.
 *
 * - If inside `.features/X/`, use `.features/X/reviews/`
 * - Otherwise, create `reviews/` next to the source file
 */
function resolveReviewDir(sourcePath: string): string {
  const resolved = path.resolve(sourcePath);
  const parts = resolved.split(path.sep);

  // Look for .features/{feature}/ in the path
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === ".features" && parts[i + 1]) {
      // Found .features/{feature}/... — use .features/{feature}/reviews/
      const featureDir = parts.slice(0, i + 2).join(path.sep);
      return path.join(featureDir, "reviews");
    }
  }

  // Not inside .features — use reviews/ next to the source file
  return path.join(path.dirname(resolved), "reviews");
}

/**
 * Detect the review type from the filename.
 */
function detectReviewType(sourcePath: string): "prd" | "design" {
  const basename = path.basename(sourcePath).toLowerCase();
  if (basename.includes("design")) return "design";
  return "prd";
}

// ── Tool Parameter Schemas ──────────────────────────────────────────────────

const reviewDocumentParams = Type.Object({
  path: Type.String({ description: "Path to the markdown file to review" }),
  audioOnly: Type.Optional(
    Type.Boolean({ description: "Generate audio review only (no visual)" }),
  ),
  visualOnly: Type.Optional(
    Type.Boolean({ description: "Generate visual review only (no audio)" }),
  ),
  language: Type.Optional(
    StringEnum(["en", "es"] as const, {
      description: "Language for podcast (default: en)",
    }),
  ),
});

const reviewApplyParams = Type.Object({
  manifestPath: Type.String({
    description: "Path to the review manifest JSON file",
  }),
});

// ── Extension Entry Point ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let server: ReviewServer | null = null;

  // ── Lifecycle ──────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, _ctx) => {
    const result = cleanupOrphanServers();
    if (result.warning) {
      console.warn(`[review-hub] ${result.warning}`);
    }
    if (result.cleaned) {
      console.log("[review-hub] Cleaned up orphan server lock file");
    }
  });

  pi.on("session_shutdown", async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  });

  // ── Generation Pipeline ────────────────────────────────────────────────

  async function generateReview(
    options: ReviewOptions,
    ctx: { cwd: string; ui: any },
  ): Promise<{ manifestPath: string; url: string }> {
    // Validate conflicting flags
    if (options.audioOnly && options.visualOnly) {
      throw new Error("Cannot use both --audio-only and --visual-only. Pick one.");
    }

    const resolvedPath = path.isAbsolute(options.path)
      ? options.path
      : path.resolve(ctx.cwd, options.path);

    // Validate source file
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Source file not found: ${resolvedPath}`);
    }
    if (!resolvedPath.endsWith(".md")) {
      throw new Error(`Only markdown (.md) files are supported. Got: ${resolvedPath}`);
    }

    const reviewDir = resolveReviewDir(resolvedPath);
    const reviewType = detectReviewType(resolvedPath);

    // Phase 1: Create manifest
    ctx.ui.setStatus("review-hub", "📋 Parsing document...");
    const manifest = await createManifest(resolvedPath, reviewType, options.language);

    if (manifest.sections.length === 0) {
      throw new Error("Document has no sections (no headings found). Cannot generate review.");
    }

    const sourceContent = fs.readFileSync(resolvedPath, "utf-8");

    // Phase 2: Script generation (skip if visual-only)
    let scriptFile: string | undefined;
    if (!options.visualOnly) {
      try {
        ctx.ui.setStatus("review-hub", "✍️ Generating podcast script...");
        const script = await generateScript(
          manifest,
          sourceContent,
          options.language,
          (msg) => ctx.ui.setStatus("review-hub", `✍️ ${msg}`),
        );

        // Save script
        scriptFile = await saveScript(script.rawScript, reviewDir, manifest.id);
        ctx.ui.setStatus("review-hub", "✍️ Script saved");

        // Phase 3: TTS generation
        ctx.ui.setStatus("review-hub", "🎙️ Preparing audio generation...");
        const provider = await selectProvider(options.language);
        const ttsAvailable = await ensureTTSAvailable(provider, {
          confirm: (title, msg) => ctx.ui.confirm(title, msg),
          setStatus: (key, text) => ctx.ui.setStatus(key, text),
          notify: (msg, type) => ctx.ui.notify(msg, type),
        });

        if (ttsAvailable) {
          ctx.ui.setStatus("review-hub", "🎙️ Generating audio...");
          const ttsResult = await provider.generateAudio(
            script,
            (phase, pct) => {
              ctx.ui.setStatus(
                "review-hub",
                `🎙️ ${phase} (${Math.round(pct * 100)}%)`,
              );
            },
          );

          // Save audio file
          const audioFilename = `${manifest.id}.${ttsResult.format}`;
          const audioPath = path.join(reviewDir, audioFilename);
          fs.mkdirSync(reviewDir, { recursive: true });
          fs.writeFileSync(audioPath, ttsResult.audioBuffer);

          // Update manifest with audio info
          manifest.audio = {
            file: audioFilename,
            durationSeconds: ttsResult.sectionTimestamps.length > 0
              ? ttsResult.sectionTimestamps[ttsResult.sectionTimestamps.length - 1]!.endTime
              : 0,
            scriptFile: path.basename(scriptFile),
          };

          // Map timestamps to sections
          for (const ts of ttsResult.sectionTimestamps) {
            const section = manifest.sections.find((s) => s.id === ts.sectionId);
            if (section) {
              section.audioStartTime = ts.startTime;
              section.audioEndTime = ts.endTime;
            }
          }
        } else {
          ctx.ui.notify("TTS not available — generating visual-only review", "warning");
        }
      } catch (err) {
        // TTS/script failure falls back to visual-only
        ctx.ui.notify(
          `Audio generation failed: ${(err as Error).message}. Falling back to visual-only.`,
          "warning",
        );
      }
    }

    // Set visual marker if not audio-only
    if (!options.audioOnly) {
      manifest.visual = { file: "embedded" };
    }

    // Update manifest status
    manifest.status = "ready";

    // Save manifest
    ctx.ui.setStatus("review-hub", "💾 Saving review artifacts...");
    const manifestPath = await saveManifest(manifest, reviewDir);

    // Phase 4: Start server and open browser
    ctx.ui.setStatus("review-hub", "🚀 Starting review server...");

    // Stop any existing server
    if (server) {
      await server.stop();
    }

    server = createReviewServer();
    const { url } = await server.start(manifest, reviewDir);

    // Open browser (macOS)
    try {
      await pi.exec("open", [url]);
    } catch {
      // Fallback: just notify with URL
      ctx.ui.notify(`Open in browser: ${url}`, "info");
    }

    ctx.ui.setStatus("review-hub", `📝 Review live at ${url}`);
    ctx.ui.notify("Review Hub is ready! Open your browser to start reviewing.", "success");

    return { manifestPath, url };
  }

  // ── Apply Review ───────────────────────────────────────────────────────

  async function applyReview(
    manifestPath: string,
    ctx: { cwd: string; ui: any },
  ): Promise<{ changeSummary: string; prompt: string }> {
    const resolvedPath = path.isAbsolute(manifestPath)
      ? manifestPath
      : path.resolve(ctx.cwd, manifestPath);

    const manifest = await loadManifest(resolvedPath);

    // Validate
    const validation = validateForApply(manifest);
    if (!validation.valid) {
      throw new Error(validation.reason!);
    }

    // Check drift
    const driftWarning = await checkDriftWarning(manifest);
    if (driftWarning) {
      ctx.ui.notify(driftWarning, "warning");
    }

    // Read source content
    const sourcePath = path.resolve(manifest.source);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Source file not found: ${sourcePath}`);
    }
    const sourceContent = fs.readFileSync(sourcePath, "utf-8");

    // Build apply prompt
    const prompt = buildApplyPrompt(manifest, sourceContent);

    if (!prompt) {
      const summary = generateChangeSummary(manifest, false);
      // Mark as applied — no changes needed
      const reviewDir = path.dirname(resolvedPath);
      await markAsApplied(manifest, reviewDir);
      return { changeSummary: summary, prompt: "" };
    }

    // Mark as applied
    const reviewDir = path.dirname(resolvedPath);
    await markAsApplied(manifest, reviewDir);

    const summary = generateChangeSummary(manifest, true);
    return { changeSummary: summary, prompt };
  }

  // ── List Reviews ───────────────────────────────────────────────────────

  async function listReviews(
    featureFilter: string | undefined,
    cwd: string,
  ): Promise<string> {
    const featuresDir = path.join(cwd, ".features");
    if (!fs.existsSync(featuresDir)) {
      return "No .features/ directory found.";
    }

    const features = fs.readdirSync(featuresDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "archive");

    if (featureFilter) {
      const matching = features.filter((f) =>
        f.name.toLowerCase().includes(featureFilter.toLowerCase()),
      );
      if (matching.length === 0) {
        return `No features found matching "${featureFilter}".`;
      }
      return formatReviewList(matching.map((f) => f.name), featuresDir);
    }

    return formatReviewList(features.map((f) => f.name), featuresDir);
  }

  function formatReviewList(featureNames: string[], featuresDir: string): string {
    const lines: string[] = [];
    let totalCount = 0;

    for (const name of featureNames) {
      const reviewsDir = path.join(featuresDir, name, "reviews");
      if (!fs.existsSync(reviewsDir)) continue;

      const manifests = fs.readdirSync(reviewsDir)
        .filter((f) => f.endsWith(".manifest.json"));

      if (manifests.length === 0) continue;

      lines.push(`\n📁 ${name}`);

      for (const manifestFile of manifests) {
        try {
          const content = fs.readFileSync(
            path.join(reviewsDir, manifestFile),
            "utf-8",
          );
          const m = JSON.parse(content) as ReviewManifest;
          const commentCount = m.comments?.length ?? 0;
          const statusIcon = getStatusIcon(m.status);
          const date = m.createdAt
            ? new Date(m.createdAt).toLocaleDateString()
            : "unknown";
          const source = path.basename(m.source);
          lines.push(
            `  ${statusIcon} ${m.id} — ${source} [${m.status}] ${commentCount} comment(s) — ${date}`,
          );
          totalCount++;
        } catch {
          lines.push(`  ⚠️ ${manifestFile} — invalid manifest`);
        }
      }
    }

    if (totalCount === 0) {
      return "No reviews found.";
    }

    return `Found ${totalCount} review(s):${lines.join("\n")}`;
  }

  function getStatusIcon(status: string): string {
    switch (status) {
      case "generating": return "⏳";
      case "ready": return "🟢";
      case "in-progress": return "🔵";
      case "reviewed": return "🟡";
      case "applied": return "✅";
      default: return "❓";
    }
  }

  // ── Commands ───────────────────────────────────────────────────────────

  pi.registerCommand("review", {
    description:
      "Generate an interactive review for a PRD or design document. " +
      "Usage: /review <path> [--audio-only] [--visual-only] [--lang en|es]",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify(
          "Usage: /review <path> [--audio-only] [--visual-only] [--lang en|es]",
          "warning",
        );
        return;
      }

      const options = parseReviewArgs(args);
      if (!options.path) {
        ctx.ui.notify("Please provide a file path. Usage: /review <path>", "warning");
        return;
      }

      try {
        await generateReview(options, ctx);
      } catch (err) {
        ctx.ui.notify(`Review failed: ${(err as Error).message}`, "error");
        ctx.ui.setStatus("review-hub", undefined);
      }
    },
  });

  pi.registerCommand("review-apply", {
    description:
      "Apply review comments back to the source document. " +
      "Usage: /review-apply <manifest-path>",
    handler: async (args, ctx) => {
      const manifestPath = args.trim();
      if (!manifestPath) {
        ctx.ui.notify(
          "Usage: /review-apply <path/to/review-NNN.manifest.json>",
          "warning",
        );
        return;
      }

      try {
        const { changeSummary, prompt } = await applyReview(manifestPath, ctx);

        if (!prompt) {
          ctx.ui.notify(changeSummary, "info");
          return;
        }

        // Send the apply prompt to the LLM for execution
        ctx.ui.notify(changeSummary, "info");
        pi.sendUserMessage(
          `Apply the following review changes to the source document. ` +
          `After editing, confirm the changes.\n\n${prompt}`,
        );
      } catch (err) {
        ctx.ui.notify(`Apply failed: ${(err as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("review-list", {
    description:
      "List all reviews for a feature. Usage: /review-list [feature-name]",
    handler: async (args, ctx) => {
      try {
        const result = await listReviews(args.trim() || undefined, ctx.cwd);
        ctx.ui.notify(result, "info");
      } catch (err) {
        ctx.ui.notify(`List failed: ${(err as Error).message}`, "error");
      }
    },
  });

  // ── Tools ──────────────────────────────────────────────────────────────

  pi.registerTool<typeof reviewDocumentParams, ReviewDocumentDetails>({
    name: "review_document",
    label: "Review Document",
    description:
      "Generate an interactive review (podcast + visual) for a PRD or design document. " +
      "Opens a browser with the review web app where users can listen to a podcast-style " +
      "discussion and add section-anchored comments.",
    parameters: reviewDocumentParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const options: ReviewOptions = {
        path: params.path,
        audioOnly: params.audioOnly ?? false,
        visualOnly: params.visualOnly ?? false,
        language: params.language ?? "en",
      };

      try {
        const { manifestPath, url } = await generateReview(options, ctx);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Review generated and opened in browser.\n` +
                `URL: ${url}\n` +
                `Manifest: ${manifestPath}\n\n` +
                `The user can now review the document in the browser, add comments, ` +
                `and click "Done Reviewing" when finished. Then use /review-apply or ` +
                `the review_apply tool to apply comments back to the source.`,
            },
          ],
          details: { manifestPath, url },
        };
      } catch (err) {
        const errorMsg = (err as Error).message;
        ctx.ui.setStatus("review-hub", undefined);
        return {
          content: [
            { type: "text" as const, text: `Review generation failed: ${errorMsg}` },
          ],
          details: { error: errorMsg },
        };
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("review_document "));
      text += theme.fg("muted", args.path);
      const flags: string[] = [];
      if (args.audioOnly) flags.push("audio-only");
      if (args.visualOnly) flags.push("visual-only");
      if (args.language && args.language !== "en") flags.push(`lang:${args.language}`);
      if (flags.length > 0) {
        text += " " + theme.fg("dim", `[${flags.join(", ")}]`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details;

      if (details.error) {
        return new Text(
          theme.fg("error", `Review failed: ${details.error}`),
          0, 0,
        );
      }

      let text = "🎬 " + theme.fg("success", "Review ready");
      if (details.url) {
        text += " " + theme.fg("dim", details.url);
      }

      if (expanded && details.manifestPath) {
        text += "\n  " + theme.fg("muted", `Manifest: ${details.manifestPath}`);
      }

      return new Text(text, 0, 0);
    },
  });

  pi.registerTool<typeof reviewApplyParams, ReviewApplyDetails>({
    name: "review_apply",
    label: "Apply Review",
    description:
      "Apply review comments from a completed review back to the source document. " +
      "The review must have status 'reviewed' (user clicked 'Done Reviewing' in the browser).",
    parameters: reviewApplyParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const { changeSummary, prompt } = await applyReview(params.manifestPath, ctx);

        if (!prompt) {
          return {
            content: [{ type: "text" as const, text: changeSummary }],
            details: { applied: false, reason: "no-actionable-comments" },
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text:
                `${changeSummary}\n\n` +
                `Apply the following changes to the source document:\n\n${prompt}`,
            },
          ],
          details: { applied: true },
        };
      } catch (err) {
        const errorMsg = (err as Error).message;
        return {
          content: [
            { type: "text" as const, text: `Apply failed: ${errorMsg}` },
          ],
          details: { applied: false, error: errorMsg },
        };
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("review_apply "));
      text += theme.fg("muted", args.manifestPath);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details;

      if (details.error) {
        return new Text(
          theme.fg("error", `Apply failed: ${details.error}`),
          0, 0,
        );
      }

      if (!details.applied) {
        return new Text(
          theme.fg("dim", "No actionable changes — all comments are approvals"),
          0, 0,
        );
      }

      let text = "✏️ " + theme.fg("success", "Review applied");
      if (expanded) {
        const msg = result.content[0];
        if (msg?.type === "text") {
          const firstLine = msg.text.split("\n")[0] ?? "";
          text += "\n  " + theme.fg("muted", firstLine);
        }
      }

      return new Text(text, 0, 0);
    },
  });
}
