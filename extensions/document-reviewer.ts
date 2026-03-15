import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildLaunchFallbackText } from "./document-reviewer/launch-help.js";
import { getDocumentReviewService } from "./document-reviewer/server.js";
import { openExternal } from "./lib/open-external.js";

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd", ".mdx"]);
const MARKDOWN_EXTENSION_LIST = Array.from(MARKDOWN_EXTENSIONS).join(", ");
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
		"  /review <path-to-markdown-file>",
		"",
		"Examples:",
		"  /review .features/document-reviewer-extension/prd.md",
		"  /review 'docs/Design Notes.md'",
		"",
		"Notes:",
		"- Paths can be absolute or relative to your current working directory.",
		`- Only markdown files are accepted (${MARKDOWN_EXTENSION_LIST}).`,
		"- Select text in the browser and press 'c' to add a comment.",
		"- Press Ctrl+Shift+F to finish the review and write comments to the file.",
		"- After finishing, the tab will try to close automatically; if it stays open, close it and ask Pi: Apply comments in <file>.",
		"- Press 'v' to enter visual mode (selection mode), then move with h/j/k/l.",
		"- Use Shift+h/j/k/l in visual mode to extend selection, then press 'c' to comment.",
		"- Use j/k (normal mode), Ctrl+U/Ctrl+D, gg/G for document navigation.",
		"- Press '?' in the browser for full keyboard shortcuts.",
		"- Review sessions run in background, so you can keep using the agent.",
	].join("\n");
}

function isMarkdownPath(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase();
	return MARKDOWN_EXTENSIONS.has(ext);
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

type ValidationResult = { ok: true; resolvedPath: string } | { ok: false; error: string; hint?: string };

async function validateAndResolve(input: string, cwd: string): Promise<ValidationResult> {
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
				hint: "Pass an existing markdown file path. Example: /review README.md",
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
	if (!isMarkdownPath(resolvedPath)) {
		return {
			ok: false,
			error: `Unsupported file type: ${path.basename(resolvedPath)}. Expected markdown (${MARKDOWN_EXTENSION_LIST}).`,
		};
	}

	return { ok: true, resolvedPath };
}

export default function (pi: ExtensionAPI) {
	// ─── /review command ───
	pi.registerCommand("review", {
		description: "Start a document review session for a markdown file (usage: /review <path>)",
		handler: async (args, ctx) => {
			const input = args.trim();

			const validation = await validateAndResolve(input, ctx.cwd);
			if (!validation.ok) {
				ctx.ui.notify(validation.error, "error");
				if ("hint" in validation && validation.hint) {
					ctx.ui.setEditorText(validation.hint);
				}
				return;
			}

			const { resolvedPath } = validation;
			ctx.ui.notify(`Starting review for ${path.basename(resolvedPath)}...`, "info");

			let session;
			try {
				const reviewService = await getDocumentReviewService();
				session = await reviewService.createSession(resolvedPath);
			} catch (error) {
				ctx.ui.notify("Could not start local review service.", "error");
				ctx.ui.notify(formatError(error), "warning");
				return;
			}

			const sessionReadyText = [
				`Review session ready: ${session.title}`,
				`Review URL: ${session.reviewUrl}`,
				"",
				"Open the URL above or wait for the browser to launch.",
				"When done, press Ctrl+Shift+F in the browser to finish the review.",
				`After finishing, the tab may auto-close; if it stays open, close it and ask Pi: Apply comments in ${session.title}.`,
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
						ctx.ui.notify(
							`Review complete! ${comments.length} comment(s) written to ${path.basename(resolvedPath)}.`,
							"info",
						);
						pi.sendMessage({
							customType: "review",
							content: [
								`Review complete. ${comments.length} comment(s) were written as <!-- REVIEW: ... --> annotations into ${resolvedPath}.`,
								"",
								buildApplyCommentsHint(resolvedPath),
							].join("\n"),
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
		},
	});

	// ─── review tool (LLM-callable) ───
	pi.registerTool({
		name: "review",
		label: "Review",
		description:
			"Open a markdown file in the browser for human review with inline commenting. " +
			"The reviewer can select text and add comments. Comments are inserted as <!-- REVIEW: ... --> " +
			"annotations into the original file when the review is finished.",
		parameters: Type.Object({
			path: Type.String({ description: "Path to the markdown file to review" }),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const input = params.path.replace(/^@/, "");
			const validation = await validateAndResolve(input, ctx.cwd);
			if (!validation.ok) {
				throw new Error(validation.error);
			}

			const { resolvedPath } = validation;

			onUpdate?.({
				content: [{ type: "text", text: `Starting review session for ${path.basename(resolvedPath)}...` }],
				details: {},
			});

			const reviewService = await getDocumentReviewService();
			const session = await reviewService.createSession(resolvedPath);

			onUpdate?.({
				content: [
					{
						type: "text",
						text: [
							`Review session ready: ${session.title}`,
							`Review URL: ${session.reviewUrl}`,
							"",
							"Open the URL above or wait for the browser to launch.",
							"When done, press Ctrl+Shift+F in the browser to finish the review.",
							`After finishing, the tab may auto-close; if it stays open, close it and ask Pi: Apply comments in ${session.title}.`,
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

			const summary =
				comments.length > 0
					? [
						`Review complete. ${comments.length} comment(s) were written as <!-- REVIEW: ... --> annotations into ${resolvedPath}.`,
						"",
						`Comments:\n${comments.map((c, i) => `${i + 1}. "${c.selectedText.slice(0, 80)}${c.selectedText.length > 80 ? "..." : ""}" → ${c.comment}`).join("\n")}`,
						"",
						buildApplyCommentsHint(resolvedPath),
					].join("\n")
					: `Review finished with no comments on ${resolvedPath}. You can close the review tab and continue in Pi.`;

			return {
				content: [{ type: "text", text: summary }],
				details: {
					sessionId: session.sessionId,
					filePath: resolvedPath,
					commentsCount: comments.length,
					comments: comments.map((c) => ({
						selectedText: c.selectedText.slice(0, 200),
						comment: c.comment,
					})),
				},
			};
		},
	});
}
