import test from "node:test";
import assert from "node:assert/strict";
import {
	buildCommentDraftPayload,
	buildFinishDescription,
	buildReviewPage,
	computeSelectionMetadata,
	formatPullRequestSessionContext,
} from "./review-page.js";

test("computeSelectionMetadata derives single-line offsets and line numbers", () => {
	assert.deepEqual(computeSelectionMetadata("# Title\n\nHello world\n", "Hello"), {
		offsetStart: 9,
		offsetEnd: 14,
		lineStart: 3,
		lineEnd: 3,
		inlineEligible: true,
		fallbackReason: undefined,
	});
});

test("computeSelectionMetadata marks multi-line selections as fallback-only", () => {
	assert.deepEqual(computeSelectionMetadata("Line one\nLine two\n", "Line one\nLine two"), {
		offsetStart: 0,
		offsetEnd: 17,
		lineStart: 1,
		lineEnd: 2,
		inlineEligible: false,
		fallbackReason: "multi_line_selection",
	});
});

test("buildCommentDraftPayload sends PR line metadata only in pull request mode", () => {
	const selection = {
		selectedText: "Hello",
		offsetStart: 9,
		offsetEnd: 14,
		lineStart: 3,
		lineEnd: 3,
	};

	assert.deepEqual(buildCommentDraftPayload("pull_request", selection, "Looks good"), {
		selectedText: "Hello",
		comment: "Looks good",
		offsetStart: 9,
		offsetEnd: 14,
		lineStart: 3,
		lineEnd: 3,
	});
	assert.deepEqual(buildCommentDraftPayload("document", selection, "Looks good"), {
		selectedText: "Hello",
		comment: "Looks good",
		offsetStart: 9,
		offsetEnd: 14,
	});
});

test("PR-mode helpers format session context and finish copy", () => {
	assert.equal(
		formatPullRequestSessionContext({ owner: "acme", repo: "widgets", number: 42, filePath: "docs/README.md" }, "README.md"),
		"acme/widgets#42 · docs/README.md",
	);
	assert.match(buildFinishDescription("pull_request", 2), /Fallback comments/);
	assert.match(buildFinishDescription("document", 2), /REVIEW: \.\.\./);
});

test("buildReviewPage includes PR-mode context and line metadata hooks", () => {
	const html = buildReviewPage("session-123", "README.md");

	assert.match(html, /id="session-context"/);
	assert.match(html, /buildCommentDraftPayload/);
	assert.match(html, /buildFinishDescription/);
	assert.match(html, /Fallback only/);
	assert.match(html, /pull_request/);
});
