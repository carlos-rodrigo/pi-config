export interface PullRequestLabel {
	owner: string;
	repo: string;
	number: number;
}

export interface PullRequestReadyDetails {
	reviewUrl: string;
	selectedFilePath: string;
	pullRequest: PullRequestLabel & { url?: string; title?: string };
}

export interface PullRequestCompletionSummary {
	commentsSubmitted: number;
	inlineComments: number;
	fallbackComments: number;
	errorComments: number;
	cleanupAttempted: boolean;
	cleanupError?: string;
}

export type PullRequestInputParseResult =
	| { ok: true; url: string; requestedPath?: string }
	| { ok: false; error: string; hint?: string };

export type PullRequestFileSelectionResult =
	| { ok: true; selectedFilePath: string; candidates: string[] }
	| { ok: false; error: string; hint?: string; candidates: string[] };

function stripWrappingQuotes(input: string): string {
	let text = input.trim();
	if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
		text = text.slice(1, -1).trim();
	}
	return text;
}

function buildPullRequestLabel(pullRequest: PullRequestLabel): string {
	return `${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`;
}

function normalizeCandidatePath(filePath: string): string {
	return stripWrappingQuotes(filePath).replace(/\\/g, "/").replace(/^\.\//, "");
}

function buildChangedMarkdownFilesHint(candidates: readonly string[]): string {
	return ["Changed markdown files:", ...candidates.map((candidate) => `- ${candidate}`)].join("\n");
}

export function buildPullRequestReviewHelpText(): string {
	return [
		"Usage:",
		"  /review-pr <github-pr-url> [changed-markdown-path]",
		"",
		"Examples:",
		"  /review-pr https://github.com/org/repo/pull/123",
		"  /review-pr https://github.com/org/repo/pull/123 docs/spec.md",
		"",
		"Notes:",
		"- GitHub CLI auth is required (`gh auth login`).",
		"- v1 only supports base-repo GitHub pull requests.",
		"- Only markdown files changed in the PR can be reviewed.",
		"- Finishing the browser review auto-submits one PR review and then cleans up the PR worktree.",
	].join("\n");
}

export function parsePullRequestReviewInput(input: string): PullRequestInputParseResult {
	const trimmed = input.trim();
	if (!trimmed || trimmed === "help" || trimmed === "--help") {
		return {
			ok: false,
			error: "No pull request URL provided.",
			hint: buildPullRequestReviewHelpText(),
		};
	}

	const firstWhitespace = trimmed.search(/\s/);
	if (firstWhitespace === -1) {
		return { ok: true, url: trimmed };
	}

	const url = trimmed.slice(0, firstWhitespace).trim();
	const remainder = trimmed.slice(firstWhitespace).trim();
	const requestedPath = remainder ? stripWrappingQuotes(remainder) : undefined;
	return requestedPath ? { ok: true, url, requestedPath } : { ok: true, url };
}

export function resolvePullRequestReviewFile(options: {
	owner: string;
	repo: string;
	number: number;
	files: readonly { filename: string }[];
	requestedPath?: string;
}): PullRequestFileSelectionResult {
	const candidates = options.files.map((file) => normalizeCandidatePath(file.filename));
	const prLabel = buildPullRequestLabel(options);

	if (candidates.length === 0) {
		return {
			ok: false,
			error: `Pull request ${prLabel} does not change any markdown files.`,
			candidates: [],
		};
	}

	if (options.requestedPath) {
		const normalizedRequestedPath = normalizeCandidatePath(options.requestedPath);
		const exactMatch = candidates.find((candidate) => candidate === normalizedRequestedPath);
		if (!exactMatch) {
			return {
				ok: false,
				error: `Markdown file ${normalizedRequestedPath} is not part of ${prLabel}.`,
				hint: buildChangedMarkdownFilesHint(candidates),
				candidates,
			};
		}
		return { ok: true, selectedFilePath: exactMatch, candidates };
	}

	if (candidates.length > 1) {
		return {
			ok: false,
			error: `Multiple markdown files changed in ${prLabel}. Re-run /review-pr <url> <file> with one of the files below.`,
			hint: buildChangedMarkdownFilesHint(candidates),
			candidates,
		};
	}

	return { ok: true, selectedFilePath: candidates[0]!, candidates };
}

export function buildPullRequestReviewReadyText(details: PullRequestReadyDetails): string {
	const prLabel = buildPullRequestLabel(details.pullRequest);
	return [
		`PR review session ready: ${prLabel}`,
		details.pullRequest.title ? `Title: ${details.pullRequest.title}` : undefined,
		`File: ${details.selectedFilePath}`,
		details.pullRequest.url ? `PR URL: ${details.pullRequest.url}` : undefined,
		`Review URL: ${details.reviewUrl}`,
		"",
		"Open the URL above or wait for the browser to launch.",
		"When done, press Ctrl+Shift+F in the browser to finish the review.",
		"Finishing auto-submits the PR review and then removes the PR review worktree.",
		"If the tab stays open, close it manually after the finish summary appears.",
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

export function buildPullRequestCompletionText(options: {
	selectedFilePath: string;
	pullRequest: PullRequestLabel;
	result: PullRequestCompletionSummary;
}): string {
	const prLabel = buildPullRequestLabel(options.pullRequest);
	const cleanupLine = options.result.cleanupAttempted
		? options.result.cleanupError
			? `Cleanup: could not remove the PR review worktree automatically (${options.result.cleanupError}).`
			: "Cleanup: removed the PR review worktree."
		: "Cleanup: no PR review worktree cleanup was needed.";

	return [
		`PR review complete for ${prLabel}.`,
		`File: ${options.selectedFilePath}`,
		`${options.result.commentsSubmitted} comment(s) submitted: ${options.result.inlineComments} inline, ${options.result.fallbackComments} fallback, ${options.result.errorComments} errors.`,
		cleanupLine,
	].join("\n");
}
