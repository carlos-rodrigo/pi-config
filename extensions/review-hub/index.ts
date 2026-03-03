/**
 * Review Hub — pi extension for interactive PRD & design document reviews.
 *
 * Provides narration-style audio walkthroughs and cinematic scroll-driven
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
import { shutdownDiaWorker } from "./lib/tts/dia.js";
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
  includeAudio: boolean; // visual is always included
  fastAudio: boolean; // compact script + faster TTS settings
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
 * Default behavior: visual review only.
 * Optional audio: --with-audio.
 *
 * Supports:
 *   /review path/to/file.md --with-audio --fast-audio --lang en|es
 *   /review @path/to/file.md  (strip leading @, following pi convention)
 *
 * Legacy flags kept for compatibility:
 *   --audio-only  => treated as --with-audio
 *   --visual-only => default behavior (ignored)
 */
function parseReviewArgs(args: string): ReviewOptions {
  const parts = args.trim().split(/\s+/);

  let filePath = "";
  let includeAudio = false;
  let fastAudio = false;
  let language: "en" | "es" = "en";

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;

    if (part === "--with-audio") {
      includeAudio = true;
    } else if (part === "--fast-audio") {
      includeAudio = true;
      fastAudio = true;
    } else if (part === "--audio-only") {
      // Backward compatibility
      includeAudio = true;
    } else if (part === "--visual-only") {
      // Backward compatibility (visual is already mandatory)
      includeAudio = false;
      fastAudio = false;
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

  return { path: filePath, includeAudio, fastAudio, language };
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
  withAudio: Type.Optional(
    Type.Boolean({ description: "Include optional narrated audio walkthrough (visual is always included)" }),
  ),
  fastAudio: Type.Optional(
    Type.Boolean({ description: "Enable faster narration generation (shorter script + faster TTS settings)" }),
  ),
  // Backward compatibility flags (deprecated)
  audioOnly: Type.Optional(
    Type.Boolean({ description: "[Deprecated] Treated as withAudio=true" }),
  ),
  visualOnly: Type.Optional(
    Type.Boolean({ description: "[Deprecated] Ignored (visual is always included)" }),
  ),
  language: Type.Optional(
    StringEnum(["en", "es"] as const, {
      description: "Language for narrated audio when withAudio=true (default: en)",
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

    // Shut down persistent Dia worker process
    await shutdownDiaWorker();
  });

  // ── Generation Pipeline ────────────────────────────────────────────────

  async function generateReview(
    options: ReviewOptions,
    ctx: { cwd: string; ui: any },
  ): Promise<{ manifestPath: string; url: string }> {
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
    const docName = path.basename(resolvedPath);
    const startTime = Date.now();

    // ── Progress helpers ──────────────────────────────────────────────
    const steps = {
      parse:  { icon: "📋", label: "Parsing document", done: false },
      script: { icon: "✍️", label: "Generating narrative script", done: false },
      tts:    { icon: "🎙️", label: "Generating narration audio", done: false },
      visual: { icon: "🎬", label: "Building visual presentation", done: false },
      serve:  { icon: "🚀", label: "Starting review server", done: false },
    };

    function elapsed(): string {
      const s = Math.round((Date.now() - startTime) / 1000);
      return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
    }

    function updateWidget(currentStep: keyof typeof steps, detail?: string) {
      const lines: string[] = [
        `Review Hub — ${docName}  (${elapsed()})`,
        "",
      ];
      for (const [key, step] of Object.entries(steps)) {
        if (!options.includeAudio && key === "script") continue;
        if (!options.includeAudio && key === "tts") continue;

        const isCurrent = key === currentStep && !step.done;
        const icon = step.done ? "✅" : isCurrent ? "⏳" : "⬜";
        let line = `  ${icon}  ${step.label}`;
        if (isCurrent && detail) line += ` — ${detail}`;
        lines.push(line);
      }
      lines.push("");
      ctx.ui.setWidget("review-hub", lines);
      ctx.ui.setStatus("review-hub", `${steps[currentStep].icon} ${steps[currentStep].label}${detail ? ` — ${detail}` : ""}`);
    }

    function markDone(step: keyof typeof steps) {
      steps[step].done = true;
    }

    function clearProgress() {
      ctx.ui.setWidget("review-hub", undefined);
    }

    let logPath = "";
    function log(message: string) {
      if (!logPath) return;
      try {
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, "utf-8");
      } catch {
        // Non-fatal logging failure
      }
    }

    // ── Phase 1: Parse ────────────────────────────────────────────────
    updateWidget("parse");
    ctx.ui.notify(
      options.fastAudio
        ? `🎬 Starting review generation for ${docName} (FAST AUDIO enabled)...`
        : `🎬 Starting review generation for ${docName}...`,
      "info",
    );

    const manifest = await createManifest(resolvedPath, reviewType, options.language);

    if (manifest.sections.length === 0) {
      clearProgress();
      throw new Error("Document has no sections (no headings found). Cannot generate review.");
    }

    manifest.audioState = options.includeAudio ? undefined : "not-requested";
    manifest.audioFailureReason = undefined;

    // Initialize per-review log file early so all later steps are captured
    fs.mkdirSync(reviewDir, { recursive: true });
    logPath = path.join(reviewDir, `${manifest.id}.log`);
    const prevLogEnv = process.env.REVIEW_HUB_LOG_FILE;
    process.env.REVIEW_HUB_LOG_FILE = logPath;

    log(`Review started: ${docName}`);
    log(`Source: ${resolvedPath}`);
    log(`Language: ${options.language}`);
    log(`Include audio: ${options.includeAudio}`);
    log(`Fast audio mode: ${options.fastAudio}`);
    log(`Sections parsed: ${manifest.sections.length}`);
    ctx.ui.notify(`🧾 Review log: ${logPath}`, "info");

    markDone("parse");
    ctx.ui.notify(`📋 Parsed ${manifest.sections.length} sections from ${docName}`, "info");

    const sourceContent = fs.readFileSync(resolvedPath, "utf-8");

    try {
      // ── Phase 2: Optional audio pipeline (script + TTS) ───────────────
      let scriptFile: string | undefined;
      if (options.includeAudio) {
      try {
        updateWidget("script");
        log("Audio pipeline: generating narrative script");
        ctx.ui.notify("✍️ Generating narration script via sub-agent... (this may take 30-60s)", "info");

        const scriptStartedAt = Date.now();
        const scriptKeepAlive = setInterval(() => {
          const secs = Math.round((Date.now() - scriptStartedAt) / 1000);
          updateWidget("script", `still generating script... (${secs}s)`);
          log(`[script] keepalive (${secs}s)`);
        }, 10000);

        const script = await generateScript(
          manifest,
          sourceContent,
          options.language,
          (msg) => {
            updateWidget("script", msg);
            log(`[script] ${msg}`);
          },
          { fastMode: options.fastAudio },
        ).finally(() => clearInterval(scriptKeepAlive));

        // Save script
        scriptFile = await saveScript(script.rawScript, reviewDir, manifest.id);
        log(`Script saved: ${scriptFile}`);
        markDone("script");
        ctx.ui.notify(`✍️ Narration script generated (${script.segments.length} lines)`, "info");

        // ── Phase 3: TTS generation ─────────────────────────────────
        updateWidget("tts", "checking TTS provider...");
        log("Audio pipeline: checking TTS provider availability");
        const provider = await selectProvider(options.language);

        const ttsInstallStartedAt = Date.now();
        const installKeepAlive = setInterval(() => {
          const secs = Math.round((Date.now() - ttsInstallStartedAt) / 1000);
          updateWidget("tts", `setting up ${provider.name}... still working (${secs}s)`);
        }, 10000);

        const ttsAvailable = await ensureTTSAvailable(provider, {
          confirm: (title, msg) => ctx.ui.confirm(title, msg),
          setStatus: (_key, text) => {
            if (text) {
              updateWidget("tts", text);
              log(`[installer] ${text}`);
            }
          },
          notify: (msg, type) => {
            ctx.ui.notify(msg, type);
            log(`[installer:${type ?? "info"}] ${msg}`);
          },
        }).finally(() => clearInterval(installKeepAlive));

        if (ttsAvailable) {
          updateWidget("tts", "loading model...");
          log(`Audio pipeline: generating audio with ${provider.name}`);
          ctx.ui.notify(
            options.fastAudio
              ? "🎙️ Generating audio in FAST mode..."
              : "🎙️ Generating audio with local TTS... (this may take several minutes)",
            "info",
          );

          let lastPhase = "loading model";
          let lastPct = 0;
          let lastUpdateAt = Date.now();
          let lastLoggedBucket = -1;

          const audioKeepAlive = setInterval(() => {
            const idleSecs = Math.round((Date.now() - lastUpdateAt) / 1000);
            updateWidget(
              "tts",
              `${lastPhase} (${Math.round(lastPct * 100)}%) — still working (${idleSecs}s since last update)`,
            );
            log(`[tts] keepalive: ${lastPhase} ${Math.round(lastPct * 100)}% (idle ${idleSecs}s)`);
          }, 10000);

          const ttsResult = await provider.generateAudio(
            script,
            (phase, pct) => {
              lastPhase = phase;
              lastPct = pct;
              lastUpdateAt = Date.now();
              updateWidget("tts", `${phase} (${Math.round(pct * 100)}%)`);

              const bucket = Math.floor(pct * 20); // 5% buckets
              if (bucket !== lastLoggedBucket) {
                lastLoggedBucket = bucket;
                log(`[tts] ${phase} (${Math.round(pct * 100)}%)`);
              }
            },
            undefined,
            {
              fastMode: options.fastAudio,
              cacheDir: path.join(reviewDir, ".audio-cache", provider.name),
            },
          ).finally(() => clearInterval(audioKeepAlive));

          // Save audio file
          const audioFilename = `${manifest.id}.${ttsResult.format}`;
          const audioPath = path.join(reviewDir, audioFilename);
          fs.mkdirSync(reviewDir, { recursive: true });
          fs.writeFileSync(audioPath, ttsResult.audioBuffer);
          log(`Audio written: ${audioPath} (${ttsResult.audioBuffer.length} bytes)`);

          // Update manifest with audio info
          manifest.audio = {
            file: audioFilename,
            durationSeconds: ttsResult.sectionTimestamps.length > 0
              ? ttsResult.sectionTimestamps[ttsResult.sectionTimestamps.length - 1]!.endTime
              : 0,
            scriptFile: path.basename(scriptFile),
          };
          manifest.audioState = "ready";
          manifest.audioFailureReason = undefined;

          // Map timestamps to sections
          for (const ts of ttsResult.sectionTimestamps) {
            const section = manifest.sections.find((s) => s.id === ts.sectionId);
            if (section) {
              section.audioStartTime = ts.startTime;
              section.audioEndTime = ts.endTime;
            }
          }
          markDone("tts");
          ctx.ui.notify(`🎙️ Audio generated (${Math.round(manifest.audio?.durationSeconds ?? 0)}s)`, "info");
        } else {
          markDone("tts");
          manifest.audioState = "failed";
          manifest.audioFailureReason = "TTS provider unavailable after setup attempt";
          log("TTS unavailable after setup attempt; continuing with visual-only");
          ctx.ui.notify("TTS not available — generating visual-only review", "warning");
        }
      } catch (err) {
        // TTS/script failure falls back to visual-only
        markDone("script");
        markDone("tts");
        const msg = (err as Error).message;
        manifest.audioState = "failed";
        manifest.audioFailureReason = msg;
        log(`Audio pipeline failed: ${msg}`);
        ctx.ui.notify(
          `Audio generation failed: ${msg}. Falling back to visual-only. See log: ${logPath}`,
          "warning",
        );
      }
    } else {
      log("Visual-first mode selected: skipping optional audio generation");
      ctx.ui.notify("🎬 Visual-first mode: skipping optional narration generation (use --with-audio to include it)", "info");
    }

    // ── Phase 4: Visual (always on) ───────────────────────────────────
    updateWidget("visual");
    manifest.visual = { file: "embedded" };
    markDone("visual");

    // Update manifest status
    manifest.status = "ready";

    // Save manifest
    const manifestPath = await saveManifest(manifest, reviewDir);
    log(`Manifest saved: ${manifestPath}`);

    // ── Phase 5: Serve ────────────────────────────────────────────────
    updateWidget("serve");
    log("Starting review web server");

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

    markDone("serve");
    updateWidget("serve");

    // Show final summary, then clear widget after a moment
    const totalTime = elapsed();
    log(`Review completed in ${totalTime}`);
    log(`Review URL: ${url}`);
    ctx.ui.notify(`✅ Review Hub ready in ${totalTime} — opened in browser`, "success");
    ctx.ui.notify(`🧾 Review log saved to ${logPath}`, "info");
    ctx.ui.setStatus("review-hub", `📝 Review live at ${url}`);

    // Clear the progress widget after 3 seconds so it doesn't linger
    setTimeout(() => clearProgress(), 3000);

    return { manifestPath, url };
    } finally {
      if (prevLogEnv === undefined) delete process.env.REVIEW_HUB_LOG_FILE;
      else process.env.REVIEW_HUB_LOG_FILE = prevLogEnv;
    }
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
      "Generate an interactive review for a PRD or design document (visual is always included). " +
      "Usage: /review <path> [--with-audio|--fast-audio] [--lang en|es]",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify(
          "Usage: /review <path> [--with-audio|--fast-audio] [--lang en|es]",
          "warning",
        );
        return;
      }

      const options = parseReviewArgs(args);
      if (!options.path) {
        ctx.ui.notify("Please provide a file path. Usage: /review <path>", "warning");
        return;
      }

      if (args.includes("--audio-only") || args.includes("--visual-only")) {
        ctx.ui.notify(
          "--audio-only/--visual-only are deprecated. Use --with-audio (visual is always included).",
          "warning",
        );
      }

      try {
        await generateReview(options, ctx);
      } catch (err) {
        ctx.ui.notify(`Review failed: ${(err as Error).message}`, "error");
        ctx.ui.setStatus("review-hub", undefined);
        ctx.ui.setWidget("review-hub", undefined);
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
      "Generate an interactive review for a PRD or design document. " +
      "Visual presentation is always included; narrated audio is optional via withAudio=true. " +
      "Supports fastAudio mode and per-section audio cache reuse for better performance.",
    parameters: reviewDocumentParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const visualOnlyDeprecated = params.visualOnly ?? false;
      const options: ReviewOptions = {
        path: params.path,
        includeAudio: visualOnlyDeprecated
          ? false
          : ((params.withAudio ?? false) || (params.audioOnly ?? false) || (params.fastAudio ?? false)),
        fastAudio: visualOnlyDeprecated ? false : (params.fastAudio ?? false),
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
        ctx.ui.setWidget("review-hub", undefined);
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
      if (args.withAudio || args.audioOnly) flags.push("with-audio");
      if (args.fastAudio) flags.push("fast-audio");
      if (args.visualOnly) flags.push("visual-only(deprecated)");
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
