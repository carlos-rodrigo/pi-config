import test from "node:test";
import assert from "node:assert/strict";
import {
	buildCommentDraftPayload,
	buildFinishDescription,
	buildReviewPage,
	computeSelectionMetadata,
	findFlexibleMatch,
	formatPullRequestSessionContext,
} from "./review-page.js";

test("computeSelectionMetadata derives single-line offsets and line numbers", () => {
	assert.deepEqual(computeSelectionMetadata("# Title\n\nHello world\n", "Hello"), {
		offsetStart: 9,
		offsetEnd: 14,
		matchedText: "Hello",
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
		matchedText: "Line one\nLine two",
		lineStart: 1,
		lineEnd: 2,
		inlineEligible: false,
		fallbackReason: "multi_line_selection",
	});
});

test("computeSelectionMetadata uses flexible matching for formatted text", () => {
	// Bold formatting: browser shows "bold text" but markdown has **bold** text
	const md = "This is **bold** text";
	const result = computeSelectionMetadata(md, "This is bold text");
	assert.equal(result.offsetStart, 0);
	assert.equal(result.offsetEnd, md.length);
	assert.equal(result.matchedText, md);
	assert.equal(result.lineStart, 1);
});

test("computeSelectionMetadata uses flexible matching across mixed formatting", () => {
	const md = "This is **bold** and *italic* text";
	const result = computeSelectionMetadata(md, "This is bold and italic text");
	assert.equal(result.offsetStart, 0);
	assert.equal(result.offsetEnd, md.length);
	assert.equal(result.matchedText, md);
});

test("computeSelectionMetadata expands link-only selections to the full markdown link", () => {
	const md = "- [Advanced Context Engineering](https://www.humanlayer.dev/blog/advanced-context-engineering)";
	const result = computeSelectionMetadata(md, "Advanced Context Engineering");
	assert.equal(result.offsetStart, 2);
	assert.equal(result.offsetEnd, md.length);
	assert.equal(result.matchedText, "[Advanced Context Engineering](https://www.humanlayer.dev/blog/advanced-context-engineering)");
});

test("computeSelectionMetadata matches selections that span inline code, headings, and linked list items", () => {
	const md = [
		"Improve how agents build, transfer, and retain context across sessions. Replaces compound/LEARNINGS with auto-maintained `docs/`, adds research phase and backpressure to `implement-task`, rewrites handoff for structured context packets, adds deterministic hooks, and restructures feature specs into `docs/features/` with verification workflows.",
		"",
		"Informed by:",
		"- [Advanced Context Engineering](https://www.humanlayer.dev/blog/advanced-context-engineering)",
	].join("\n");
	const selection = [
		"Improve how agents build, transfer, and retain context across sessions. Replaces compound/LEARNINGS with auto-maintained docs/, adds research phase and backpressure to implement-task, rewrites handoff for structured context packets, adds deterministic hooks, and restructures feature specs into docs/features/ with verification workflows.",
		"",
		"Informed by:",
		"Advanced Context Engineering",
	].join("\n");

	const result = computeSelectionMetadata(md, selection);
	assert.notEqual(result.offsetStart, -1);
	assert.equal(result.lineStart, 1);
	assert.equal(result.lineEnd, 4);
	assert.equal(result.fallbackReason, "multi_line_selection");
	assert.match(result.matchedText ?? "", /`docs\//);
	assert.match(result.matchedText ?? "", /\[Advanced Context Engineering\]\(https:\/\/www\.humanlayer\.dev\/blog\/advanced-context-engineering\)/);
});

test("computeSelectionMetadata returns -1 offsets for unresolvable selections", () => {
	const result = computeSelectionMetadata("# Hello World\n", "something completely different");
	assert.equal(result.offsetStart, -1);
	assert.equal(result.offsetEnd, -1);
	assert.equal(result.matchedText, undefined);
});

test("findFlexibleMatch skips inline formatting characters", () => {
	assert.deepEqual(findFlexibleMatch("**bold**", "bold"), { start: 0, end: 8 });
	assert.deepEqual(findFlexibleMatch("*italic*", "italic"), { start: 0, end: 8 });
	assert.deepEqual(findFlexibleMatch("`code`", "code"), { start: 0, end: 6 });
	assert.deepEqual(findFlexibleMatch("~~strike~~", "strike"), { start: 0, end: 10 });
});

test("findFlexibleMatch normalises whitespace", () => {
	assert.deepEqual(findFlexibleMatch("end\n\nstart", "end start"), { start: 0, end: 10 });
	assert.deepEqual(findFlexibleMatch("a  b", "a b"), { start: 0, end: 4 });
});

test("findFlexibleMatch returns null when no match possible", () => {
	assert.equal(findFlexibleMatch("hello world", "goodbye"), null);
	assert.equal(findFlexibleMatch("", "hello"), null);
	assert.equal(findFlexibleMatch("hello", ""), null);
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
