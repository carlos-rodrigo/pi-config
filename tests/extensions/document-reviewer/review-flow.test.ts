import test from "node:test";
import assert from "node:assert/strict";
import {
	buildPullRequestCompletionText,
	buildPullRequestReviewReadyText,
	parsePullRequestReviewInput,
	resolvePullRequestReviewFile,
} from "../../../extensions/document-reviewer/review-flow.ts";

test("parsePullRequestReviewInput splits the PR URL from an optional quoted file path", () => {
	assert.deepEqual(parsePullRequestReviewInput("https://github.com/acme/widgets/pull/42 'docs/Design Notes.md'"), {
		ok: true,
		url: "https://github.com/acme/widgets/pull/42",
		requestedPath: "docs/Design Notes.md",
	});
});

test("resolvePullRequestReviewFile asks the user to pick a markdown file when multiple candidates exist", () => {
	assert.deepEqual(
		resolvePullRequestReviewFile({
			owner: "acme",
			repo: "widgets",
			number: 42,
			files: [{ filename: "README.md" }, { filename: "docs/spec.md" }],
		}),
		{
			ok: false,
			error: "Multiple markdown files changed in acme/widgets#42. Re-run /review-pr <url> <file> with one of the files below.",
			hint: ["Changed markdown files:", "- README.md", "- docs/spec.md"].join("\n"),
			candidates: ["README.md", "docs/spec.md"],
		},
	);
});

test("resolvePullRequestReviewFile rejects file paths that are not part of the PR markdown diff", () => {
	assert.deepEqual(
		resolvePullRequestReviewFile({
			owner: "acme",
			repo: "widgets",
			number: 42,
			requestedPath: "docs/missing.md",
			files: [{ filename: "README.md" }, { filename: "docs/spec.md" }],
		}),
		{
			ok: false,
			error: "Markdown file docs/missing.md is not part of acme/widgets#42.",
			hint: ["Changed markdown files:", "- README.md", "- docs/spec.md"].join("\n"),
			candidates: ["README.md", "docs/spec.md"],
		},
	);
});

test("buildPullRequestReviewReadyText summarizes the PR session and finish behavior", () => {
	const text = buildPullRequestReviewReadyText({
		reviewUrl: "http://127.0.0.1:4312/review/abc123",
		selectedFilePath: "docs/spec.md",
		pullRequest: {
			owner: "acme",
			repo: "widgets",
			number: 42,
			url: "https://github.com/acme/widgets/pull/42",
			title: "Improve docs",
		},
	});

	assert.match(text, /acme\/widgets#42/);
	assert.match(text, /docs\/spec\.md/);
	assert.match(text, /Ctrl\+Shift\+F/);
	assert.match(text, /auto-submits the PR review/);
});

test("buildPullRequestCompletionText reports inline, fallback, error, and cleanup outcomes", () => {
	const text = buildPullRequestCompletionText({
		selectedFilePath: "docs/spec.md",
		pullRequest: {
			owner: "acme",
			repo: "widgets",
			number: 42,
		},
		result: {
			commentsSubmitted: 3,
			inlineComments: 2,
			fallbackComments: 1,
			errorComments: 0,
			cleanupAttempted: true,
		},
	});

	assert.match(text, /acme\/widgets#42/);
	assert.match(text, /docs\/spec\.md/);
	assert.match(text, /3 comment\(s\) submitted/);
	assert.match(text, /2 inline/);
	assert.match(text, /1 fallback/);
	assert.match(text, /0 errors/);
	assert.match(text, /cleanup: removed the PR review worktree/i);
});
