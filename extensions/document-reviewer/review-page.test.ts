import test from "node:test";
import assert from "node:assert/strict";
import {
	buildCommentDraftPayload,
	buildFinishDescription,
	buildHtmlVisualReviewPage,
	buildReviewPage,
	buildStructuredDecisionFeedbackPayload,
	computeSelectionMetadata,
	createSerializedWriteQueue,
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
		"Improve how agents build, transfer, and retain context across sessions. Replaces ad-hoc notes with auto-maintained `docs/`, adds research phase and backpressure to `implement-task`, rewrites handoff for structured context packets, adds deterministic hooks, and keeps feature packets focused on strategy and system models.",
		"",
		"Informed by:",
		"- [Advanced Context Engineering](https://www.humanlayer.dev/blog/advanced-context-engineering)",
	].join("\n");
	const selection = [
		"Improve how agents build, transfer, and retain context across sessions. Replaces ad-hoc notes with auto-maintained docs/, adds research phase and backpressure to implement-task, rewrites handoff for structured context packets, adds deterministic hooks, and keeps feature packets focused on strategy and system models.",
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

test("buildCommentDraftPayload preserves HTML review anchors", () => {
	assert.deepEqual(
		buildCommentDraftPayload(
			"document",
			{
				selectedText: "Review this section",
				offsetStart: 0,
				offsetEnd: 0,
				reviewId: "summary",
				selector: { exact: "Review this section" },
			},
			"Looks good",
			"html",
		),
		{
			selectedText: "Review this section",
			comment: "Looks good",
			offsetStart: 0,
			offsetEnd: 0,
			reviewId: "summary",
			selector: { exact: "Review this section" },
		},
	);
});

test("PR-mode helpers format session context and finish copy", () => {
	assert.equal(
		formatPullRequestSessionContext({ owner: "acme", repo: "widgets", number: 42, filePath: "docs/README.md" }, "README.md"),
		"acme/widgets#42 · docs/README.md",
	);
	assert.match(buildFinishDescription("pull_request", 2), /Fallback comments/);
	assert.match(buildFinishDescription("document", 2), /REVIEW: \.\.\./);
	assert.match(buildFinishDescription("document", 2, "html"), /sidecar/);
});

test("buildReviewPage includes PR-mode context and line metadata hooks", () => {
	const html = buildReviewPage("session-123", "README.md");

	assert.match(html, /id="session-context"/);
	assert.match(html, /buildCommentDraftPayload/);
	assert.match(html, /buildFinishDescription/);
	assert.match(html, /Fallback only/);
	assert.match(html, /pull_request/);
});

test("buildStructuredDecisionFeedbackPayload distinguishes selected and confirmed review input", () => {
	const state = {
		validContract: true,
		optionId: "company",
		selection: "Company accounts",
		rationale: "Shared banking reality",
		owner: "Product owner",
		question: "Where should accounts live?",
		sourceFingerprint: "a".repeat(64),
		complete: true,
	};

	assert.deepEqual(buildStructuredDecisionFeedbackPayload(state, false), {
		selectedText: "Where should accounts live?",
		comment: `Decision selected: Company accounts | Option ID: company | Rationale: Shared banking reality | Owner: Product owner | Completion: complete | Source fingerprint: ${"a".repeat(64)} | Canonical approval: unchanged.`,
		feedbackKind: "decision",
		decisionFeedbackStatus: "selected",
	});
	assert.equal(buildStructuredDecisionFeedbackPayload({ ...state, complete: false }, true), undefined);
	assert.equal(buildStructuredDecisionFeedbackPayload({ ...state, validContract: false }, false), undefined);
	assert.equal(buildStructuredDecisionFeedbackPayload({ ...state, selection: "" }, false), undefined);
	assert.equal(buildStructuredDecisionFeedbackPayload(state, true)?.decisionFeedbackStatus, "confirmed");
	assert.match(
		buildStructuredDecisionFeedbackPayload({ ...state, optionId: "other", selection: "Field accounts" }, false)?.comment ?? "",
		/Decision selected: Field accounts \| Option ID: other/,
	);
});

test("createSerializedWriteQueue serializes writes and retains failures until that decision retries", async () => {
	const calls: string[] = [];
	const queue = createSerializedWriteQueue();
	let releaseFirst!: () => void;
	let markFirstStarted!: () => void;
	const firstGate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const firstStarted = new Promise<void>((resolve) => {
		markFirstStarted = resolve;
	});
	const failed = queue.enqueue("decision-a", async () => {
		calls.push("first");
		markFirstStarted();
		await firstGate;
		throw new Error("write failed");
	});
	const unrelatedSuccess = queue.enqueue("decision-b", async () => {
		calls.push("second");
	});
	const draining = assert.rejects(queue.drain(), /write failed/);

	await firstStarted;
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(calls, ["first"]);
	releaseFirst();
	await assert.rejects(failed, /write failed/);
	await unrelatedSuccess;
	await draining;
	await queue.enqueue("decision-a", async () => {
		calls.push("retry");
	});
	await queue.drain();
	assert.deepEqual(calls, ["first", "second", "retry"]);
});

test("buildHtmlVisualReviewPage injects top-level review overlay without an iframe", () => {
	const html = buildHtmlVisualReviewPage(
		"session-123",
		"design.html",
		'<!doctype html><html><head><base href="/"><meta http-equiv="Content-Security-Policy" content="default-src none"><title>Design</title></head><body><nav><a href="#summary">Summary</a></nav><section id="summary" data-review-id="summary">Hello</section><article data-review-id="gap-001"><div data-review-decision="single-choice"><label><input type="radio" name="gap" value="option-a">Option A</label></div></article><fieldset data-review-id="decision-001" data-review-decision="recorded-decision" data-decision-status="proposed" data-decision-source-fingerprint="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"><legend>Where should accounts live?</legend><label><input type="radio" name="decision" value="company" checked><span>Company accounts</span></label><label><span>Rationale</span><textarea data-decision-rationale>Shared banking reality</textarea></label><label><span>Owner</span><input data-decision-owner value="Product owner"></label><label><input type="checkbox" data-decision-recorded disabled>Decision recorded</label><p class="decision-status">Not recorded</p></fieldset><script>window.bad = true;</script></body></html>',
		{ nonce: "nonce-123" },
	);

	assert.match(html, /pi-html-review-root/);
	assert.match(html, /Comment selection/);
	assert.match(html, /data-review-id="summary"/);
	assert.match(html, /data-review-decision="single-choice"/);
	assert.match(html, /data-review-decision="recorded-decision"/);
	assert.match(html, /Decision selected:/);
	assert.match(html, /buildStructuredDecisionFeedbackPayload/);
	assert.match(html, /feedbackKind: 'decision'/);
	assert.match(html, /checkbox\.disabled = finishingReview \|\| !state\.complete/);
	assert.match(html, /data-review-decision-dirty/);
	assert.match(html, /finishingReview/);
	assert.match(html, /target\.matches\('\[data-decision-custom\]'\)/);
	assert.ok(html.includes(".replace(/\\s+/g, ' ')"));
	assert.match(html, /href="#summary"/);
	assert.match(html, /script nonce="nonce-123"/);
	assert.doesNotMatch(html, /html-review-frame/);
	assert.doesNotMatch(html, /<iframe/);
	assert.doesNotMatch(html, /<base href/);
	assert.doesNotMatch(html, /http-equiv="Content-Security-Policy"/i);
	assert.doesNotMatch(html, /window\.bad/);
});
