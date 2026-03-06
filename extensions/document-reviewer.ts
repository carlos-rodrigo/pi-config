import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildLaunchFallbackText } from "./document-reviewer/launch-help.js";
import { getDocumentReviewService } from "./document-reviewer/server.js";
import { openExternal } from "./lib/open-external.js";

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd", ".mdx"]);
const MARKDOWN_EXTENSION_LIST = Array.from(MARKDOWN_EXTENSIONS).join(", ");

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

export default function (pi: ExtensionAPI) {
	pi.registerCommand("review", {
		description: "Start a document review session for a markdown file (usage: /review <path>)",
		handler: async (args, ctx) => {
			const input = args.trim();

			if (!input || input === "help" || input === "--help") {
				ctx.ui.setEditorText(reviewHelpText());
				ctx.ui.notify("/review help written to editor", "info");
				return;
			}

			const resolvedPath = resolveTargetPath(input, ctx.cwd);

			let stat: fs.Stats;
			try {
				stat = await fs.promises.lstat(resolvedPath);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT") {
					ctx.ui.notify(`Review target not found: ${resolvedPath}`, "error");
					ctx.ui.notify("Pass an existing markdown file path. Example: /review README.md", "warning");
					return;
				}

				ctx.ui.notify(`Cannot access review target: ${resolvedPath}`, "error");
				ctx.ui.notify(code ? `Reason: ${code}` : "Please check file permissions and try again.", "warning");
				return;
			}

			if (stat.isSymbolicLink()) {
				ctx.ui.notify(`Symlink targets are not supported for /review: ${resolvedPath}`, "error");
				return;
			}

			if (!stat.isFile()) {
				ctx.ui.notify(`Review target must be a file: ${resolvedPath}`, "error");
				return;
			}

			if (!isMarkdownPath(resolvedPath)) {
				ctx.ui.notify(
					`Unsupported file type for /review: ${path.basename(resolvedPath)}. Expected markdown (${MARKDOWN_EXTENSION_LIST}).`,
					"error",
				);
				return;
			}

			ctx.ui.notify(`Starting review for ${path.basename(resolvedPath)}...`, "info");

			let session;
			try {
				const reviewService = await getDocumentReviewService();
				session = await reviewService.createSession(resolvedPath);
			} catch (error) {
				ctx.ui.notify("Could not start local review service for /review.", "error");
				ctx.ui.notify(formatError(error), "warning");
				return;
			}

			ctx.ui.setEditorText(
				[
					`Review session ready: ${session.title}`,
					`Session ID: ${session.sessionId}`,
					`Review URL: ${session.reviewUrl}`,
					`Health URL: ${session.healthUrl}`,
					`Document URL: ${session.documentUrl}`,
				].join("\n"),
			);
			ctx.ui.notify(`Review session ready: ${session.sessionId}`, "info");

			const launched = await openExternal(pi, session.reviewUrl);
			if (!launched.ok) {
				ctx.ui.notify("Could not launch browser for review session.", "error");
				ctx.ui.notify("Review session is still running locally; open the URL manually.", "warning");

				const fallbackText = buildLaunchFallbackText({
					reviewUrl: session.reviewUrl,
					healthUrl: session.healthUrl,
					fallbackCommand: launched.fallbackCommand,
				});
				ctx.ui.setEditorText(fallbackText);

				if (launched.error) {
					ctx.ui.notify(launched.error, "warning");
				}
				return;
			}

			ctx.ui.notify(`Review launch started via ${launched.usedCommand ?? "system launcher"}.`, "info");
		},
	});
}
