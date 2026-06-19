import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildLaunchFallbackText } from "./launch-help.js";
import { getDocumentReviewService } from "./server.js";
import { openExternal } from "./lib/open-external.ts";

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd", ".mdx"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const REVIEW_EXTENSIONS = new Set([...MARKDOWN_EXTENSIONS, ...HTML_EXTENSIONS]);
const MARKDOWN_EXTENSION_LIST = Array.from(MARKDOWN_EXTENSIONS).join(", ");
const HTML_EXTENSION_LIST = Array.from(HTML_EXTENSIONS).join(", ");
const REVIEW_EXTENSION_LIST = Array.from(REVIEW_EXTENSIONS).join(", ");
type ReviewSourceKind = "markdown" | "html";
let activeReviewSessionCount = 0;

function stripWrappingQuotes(input: string): string {
	let text = input.trim();
	if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
		text = text.slice(1, -1).trim();
	}
	return text;
}

function reviewHelpText(): string {
	return [
		"Usage:",
		"  /review <path-to-markdown-or-html-file>",
		"",
		"Examples:",
		"  /review docs/features/README.md",
		"  /review docs/features/my-feature/design.html",
		"  /review 'docs/Design Notes.md'",
		"",
		"Notes:",
		"- Paths can be absolute or relative to your current working directory.",
		`- Markdown and HTML files are accepted (${REVIEW_EXTENSION_LIST}).`,
		"- HTML review comments are written to a sidecar .review.md file; the source HTML is not modified.",
		"- Select text in the browser and press 'c' to add a comment.",
		"- Press Ctrl+Shift+F to finish the review and write comments to the file.",
		"- After finishing, the tab will try to close automatically; if it stays open, close it and ask Pi: Apply comments in <file>.",
		"- Markdown mode supports Vim navigation: v for visual mode, h/j/k/l movement, Ctrl+U/Ctrl+D, gg/G.",
		"- HTML mode renders as a top-level visual page with a floating review dock; in-page menu/hash links work normally.",
		"- Press '?' in the browser for full keyboard shortcuts.",
		"- Review sessions run in background, so you can keep using the agent.",
	].join("\n");
}

function isMarkdownPath(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase();
	return MARKDOWN_EXTENSIONS.has(ext);
}

function isHtmlPath(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase();
	return HTML_EXTENSIONS.has(ext);
}

function getReviewSourceKind(filePath: string): ReviewSourceKind | undefined {
	if (isMarkdownPath(filePath)) return "markdown";
	if (isHtmlPath(filePath)) return "html";
	return undefined;
}

function resolveTargetPath(input: string, cwd: string): string {
	const cleaned = stripWrappingQuotes(input);
	return path.isAbsolute(cleaned) ? cleaned : path.resolve(cwd, cleaned);
}

function formatError(error: unknown): string {
	if (error instanceof Error && error.message) {
		return error.message;
	}
	return String(error);
}

function buildApplyCommentsHint(filePath: string): string {
	return [
		"Next steps:",
		"- If the review tab is still open (auto-close can be browser-blocked), close it manually.",
		`- Back in Pi, ask: Apply comments in ${path.basename(filePath)}.`,
	].join("\n");
}

function getHtmlReviewSidecarPath(filePath: string): string {
	const parsed = path.parse(filePath);
	return path.join(parsed.dir, `${parsed.name}.review.md`);
}

function buildCompletionSummary(sourceKind: ReviewSourceKind, filePath: string, commentsCount: number): string {
	if (sourceKind === "html") {
		const sidecarPath = getHtmlReviewSidecarPath(filePath);
		return [
			`Review complete. ${commentsCount} comment(s) were written to sidecar ${sidecarPath}.`,
			"The source HTML file was not modified.",
			"",
			"Next steps:",
			"- If the review tab is still open (auto-close can be browser-blocked), close it manually.",
			`- Back in Pi, ask: Apply comments in ${path.basename(sidecarPath)}.`,
		].join("\n");
	}

	return [
		`Review complete. ${commentsCount} comment(s) were written as <!-- REVIEW: ... --> annotations into ${filePath}.`,
		"",
		buildApplyCommentsHint(filePath),
	].join("\n");
}

type ValidationResult = { ok: true; resolvedPath: string; sourceKind: ReviewSourceKind } | { ok: false; error: string; hint?: string };

type ValidationExpectation = "any" | ReviewSourceKind;

async function validateAndResolve(input: string, cwd: string, expected: ValidationExpectation = "any"): Promise<ValidationResult> {
	if (!input || input === "help" || input === "--help") {
		return { ok: false, error: "No file path provided.", hint: reviewHelpText() };
	}

	const resolvedPath = resolveTargetPath(input, cwd);

	let stat: fs.Stats;
	try {
		stat = await fs.promises.lstat(resolvedPath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return {
				ok: false,
				error: `Review target not found: ${resolvedPath}`,
				hint: expected === "html" ? "Pass an existing HTML file path. Example: /review-html docs/features/my-feature/design.html" : "Pass an existing markdown or HTML file path. Example: /review README.md",
			};
		}
		return { ok: false, error: `Cannot access review target: ${resolvedPath}` };
	}

	if (stat.isSymbolicLink()) {
		return { ok: false, error: `Symlink targets are not supported: ${resolvedPath}` };
	}
	if (!stat.isFile()) {
		return { ok: false, error: `Review target must be a file: ${resolvedPath}` };
	}
	const sourceKind = getReviewSourceKind(resolvedPath);
	if (!sourceKind || (expected !== "any" && sourceKind !== expected)) {
		const expectedList = expected === "html" ? HTML_EXTENSION_LIST : expected === "markdown" ? MARKDOWN_EXTENSION_LIST : REVIEW_EXTENSION_LIST;
		const expectedLabel = expected === "html" ? "HTML" : expected === "markdown" ? "markdown" : "markdown or HTML";
		return {
			ok: false,
			error: `Unsupported file type: ${path.basename(resolvedPath)}. Expected ${expectedLabel} (${expectedList}).`,
		};
	}

	return { ok: true, resolvedPath, sourceKind };
}

export default function (pi: ExtensionAPI) {
	async function startReviewCommand(args: string, ctx: ExtensionCommandContext, expected: ValidationExpectation) {
		const input = args.trim();

		const validation = await validateAndResolve(input, ctx.cwd, expected);
		if (!validation.ok) {
			ctx.ui.notify(validation.error, "error");
			if ("hint" in validation && validation.hint) {
				ctx.ui.setEditorText(validation.hint);
			}
			return;
		}

		const { resolvedPath, sourceKind } = validation;
		ctx.ui.notify(`Starting ${sourceKind} review for ${path.basename(resolvedPath)}...`, "info");

		let session;
		try {
			const reviewService = await getDocumentReviewService();
			session = await reviewService.createSession(resolvedPath, { sourceKind });
		} catch (error) {
			ctx.ui.notify("Could not start local review service.", "error");
			ctx.ui.notify(formatError(error), "warning");
			return;
		}

		const finishLine =
			sourceKind === "html"
				? "When done, press Ctrl+Shift+F in the browser to finish the review and export a .review.md sidecar."
				: "When done, press Ctrl+Shift+F in the browser to finish the review.";
		const sessionReadyText = [
			`Review session ready: ${session.title}`,
			`Review URL: ${session.reviewUrl}`,
			"",
			"Open the URL above or wait for the browser to launch.",
			finishLine,
			sourceKind === "html"
				? `After finishing, the tab may auto-close; if it stays open, close it and ask Pi: Apply comments in ${path.basename(getHtmlReviewSidecarPath(resolvedPath))}.`
				: `After finishing, the tab may auto-close; if it stays open, close it and ask Pi: Apply comments in ${session.title}.`,
		].join("\n");
		pi.sendMessage({ customType: "review", content: sessionReadyText });
		ctx.ui.notify(`Review session ready: ${session.sessionId}`, "info");

		const launched = await openExternal(pi, session.reviewUrl);
		if (!launched.ok) {
			ctx.ui.notify("Could not launch browser. Open the URL manually.", "warning");
			const fallbackText = buildLaunchFallbackText({
				reviewUrl: session.reviewUrl,
				healthUrl: session.healthUrl,
				fallbackCommand: launched.fallbackCommand,
			});
			pi.sendMessage({ customType: "review", content: fallbackText });
		} else {
			ctx.ui.notify(`Browser opened via ${launched.usedCommand ?? "system launcher"}.`, "info");
		}

		// Track completion in background so the agent stays usable.
		activeReviewSessionCount += 1;
		ctx.ui.setStatus(
			"review",
			ctx.ui.theme.fg("accent", `● reviewing${activeReviewSessionCount > 1 ? ` (${activeReviewSessionCount})` : ""}`),
		);

		void (async () => {
			try {
				const reviewService = await getDocumentReviewService();
				const comments = await reviewService.waitForFinish(session.sessionId);

				if (comments.length > 0) {
					const target = sourceKind === "html" ? path.basename(getHtmlReviewSidecarPath(resolvedPath)) : path.basename(resolvedPath);
					ctx.ui.notify(`Review complete! ${comments.length} comment(s) written to ${target}.`, "info");
					pi.sendMessage({
						customType: "review",
						content: buildCompletionSummary(sourceKind, resolvedPath, comments.length),
					});
				} else {
					ctx.ui.notify("Review finished with no comments.", "info");
					pi.sendMessage({
						customType: "review",
						content: `Review finished with no comments on ${resolvedPath}. You can close the review tab and continue in Pi.`,
					});
				}
			} catch (error) {
				ctx.ui.notify(`Review session ended with an error: ${formatError(error)}`, "warning");
			} finally {
				activeReviewSessionCount = Math.max(0, activeReviewSessionCount - 1);
				ctx.ui.setStatus(
					"review",
					activeReviewSessionCount > 0
						? ctx.ui.theme.fg(
								"accent",
								`● reviewing${activeReviewSessionCount > 1 ? ` (${activeReviewSessionCount})` : ""}`,
							)
						: undefined,
				);
			}
		})();

		ctx.ui.notify("Review is running in the background. You can continue chatting.", "info");
	}

	// ─── /review commands ───
	pi.registerCommand("review", {
		description: "Start a document review session for a markdown or HTML file (usage: /review <path>)",
		handler: async (args, ctx) => startReviewCommand(args, ctx, "any"),
	});

	pi.registerCommand("review-html", {
		description: "Start a document review session for an HTML file and export comments to a .review.md sidecar",
		handler: async (args, ctx) => startReviewCommand(args, ctx, "html"),
	});

	// ─── review tools (LLM-callable) ───
	pi.registerTool({
		name: "review",
		label: "Review",
		description:
			"Open a markdown or HTML file in the browser for human review with inline commenting. " +
			"Markdown comments are inserted as <!-- REVIEW: ... --> annotations into the original file. " +
			"HTML comments are exported to a sidecar .review.md file.",
		parameters: Type.Object({
			path: Type.String({ description: "Path to the markdown or HTML file to review" }),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const input = params.path.replace(/^@/, "");
			const validation = await validateAndResolve(input, ctx.cwd);
			if (!validation.ok) {
				throw new Error(validation.error);
			}

			const { resolvedPath, sourceKind } = validation;

			onUpdate?.({
				content: [{ type: "text", text: `Starting review session for ${path.basename(resolvedPath)}...` }],
				details: {},
			});

			const reviewService = await getDocumentReviewService();
			const session = await reviewService.createSession(resolvedPath, { sourceKind });

			onUpdate?.({
				content: [
					{
						type: "text",
						text: [
							`Review session ready: ${session.title}`,
							`Review URL: ${session.reviewUrl}`,
							"",
							"Open the URL above or wait for the browser to launch.",
							sourceKind === "html"
								? "When done, press Ctrl+Shift+F in the browser to finish the review and export a .review.md sidecar."
								: "When done, press Ctrl+Shift+F in the browser to finish the review.",
							sourceKind === "html"
								? `After finishing, the tab may auto-close; if it stays open, close it and ask Pi: Apply comments in ${path.basename(getHtmlReviewSidecarPath(resolvedPath))}.`
								: `After finishing, the tab may auto-close; if it stays open, close it and ask Pi: Apply comments in ${session.title}.`,
						].join("\n"),
					},
				],
				details: { sessionId: session.sessionId, url: session.reviewUrl },
			});

			const launched = await openExternal(pi, session.reviewUrl);
			if (!launched.ok) {
				return {
					content: [
						{
							type: "text",
							text: `Review session created but could not open browser.\nURL: ${session.reviewUrl}\nPlease open it manually.`,
						},
					],
					details: { sessionId: session.sessionId, url: session.reviewUrl, browserOpened: false },
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: `Browser opened. Waiting for review to finish...` }],
				details: {},
			});

			// Wait for the review to finish
			const comments = await reviewService.waitForFinish(session.sessionId);

			const commentsList = `Comments:\n${comments.map((c, i) => `${i + 1}. "${c.selectedText.slice(0, 80)}${c.selectedText.length > 80 ? "..." : ""}"${c.reviewId ? ` [${c.reviewId}]` : ""} → ${c.comment}`).join("\n")}`;
			const summary =
				comments.length > 0
					? [buildCompletionSummary(sourceKind, resolvedPath, comments.length), "", commentsList].join("\n")
					: `Review finished with no comments on ${resolvedPath}. You can close the review tab and continue in Pi.`;

			return {
				content: [{ type: "text", text: summary }],
				details: {
					sessionId: session.sessionId,
					filePath: resolvedPath,
					sourceKind,
					sidecarPath: sourceKind === "html" ? getHtmlReviewSidecarPath(resolvedPath) : undefined,
					commentsCount: comments.length,
					comments: comments.map((c) => ({
						selectedText: c.selectedText.slice(0, 200),
						comment: c.comment,
						reviewId: c.reviewId,
					})),
				},
			};
		},
	});

	pi.registerTool({
		name: "review_html",
		label: "Review HTML",
		description:
			"Open an HTML file in the browser for human review with inline commenting. " +
			"Comments are exported to a sidecar .review.md file; the source HTML is not modified.",
		parameters: Type.Object({
			path: Type.String({ description: "Path to the HTML file to review" }),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const input = params.path.replace(/^@/, "");
			const validation = await validateAndResolve(input, ctx.cwd, "html");
			if (!validation.ok) {
				throw new Error(validation.error);
			}

			const { resolvedPath, sourceKind } = validation;

			onUpdate?.({
				content: [{ type: "text", text: `Starting HTML review session for ${path.basename(resolvedPath)}...` }],
				details: {},
			});

			const reviewService = await getDocumentReviewService();
			const session = await reviewService.createSession(resolvedPath, { sourceKind });

			onUpdate?.({
				content: [
					{
						type: "text",
						text: [
							`Review session ready: ${session.title}`,
							`Review URL: ${session.reviewUrl}`,
							"",
							"Open the URL above or wait for the browser to launch.",
							"When done, press Ctrl+Shift+F in the browser to finish the review and export a .review.md sidecar.",
							`After finishing, the tab may auto-close; if it stays open, close it and ask Pi: Apply comments in ${path.basename(getHtmlReviewSidecarPath(resolvedPath))}.`,
						].join("\n"),
					},
				],
				details: { sessionId: session.sessionId, url: session.reviewUrl },
			});

			const launched = await openExternal(pi, session.reviewUrl);
			if (!launched.ok) {
				return {
					content: [
						{
							type: "text",
							text: `Review session created but could not open browser.\nURL: ${session.reviewUrl}\nPlease open it manually.`,
						},
					],
					details: { sessionId: session.sessionId, url: session.reviewUrl, browserOpened: false },
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: `Browser opened. Waiting for review to finish...` }],
				details: {},
			});

			const comments = await reviewService.waitForFinish(session.sessionId);
			const commentsList = `Comments:\n${comments.map((c, i) => `${i + 1}. "${c.selectedText.slice(0, 80)}${c.selectedText.length > 80 ? "..." : ""}"${c.reviewId ? ` [${c.reviewId}]` : ""} → ${c.comment}`).join("\n")}`;
			const summary =
				comments.length > 0
					? [buildCompletionSummary("html", resolvedPath, comments.length), "", commentsList].join("\n")
					: `Review finished with no comments on ${resolvedPath}. You can close the review tab and continue in Pi.`;

			return {
				content: [{ type: "text", text: summary }],
				details: {
					sessionId: session.sessionId,
					filePath: resolvedPath,
					sourceKind: "html",
					sidecarPath: getHtmlReviewSidecarPath(resolvedPath),
					commentsCount: comments.length,
					comments: comments.map((c) => ({
						selectedText: c.selectedText.slice(0, 200),
						comment: c.comment,
						reviewId: c.reviewId,
					})),
				},
			};
		},
	});
}
