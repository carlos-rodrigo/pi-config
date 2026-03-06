import test from "node:test";
import assert from "node:assert/strict";
import { formatAnchorSnippet, renderThreadsMarkup } from "./threads-panel.js";

const FIXED_TIME = 1_762_115_200_000;

test("formatAnchorSnippet prefers quote text and truncates long anchors", () => {
	const snippet = formatAnchorSnippet(
		{
			exact: "This is a very long selected quote that should be truncated so cards stay compact in the thread panel.",
		},
		40,
	);

	assert.equal(snippet, "This is a very long selected quote that…");
});

test("renderThreadsMarkup renders active thread and plain-text reply form", () => {
	const markup = renderThreadsMarkup(
		[
			{
				threadId: "thread-1",
				anchor: { exact: "Selected paragraph" },
				comments: [
					{ commentId: "c1", body: "C1", createdAt: FIXED_TIME },
					{ commentId: "c2", body: "C1.1", createdAt: FIXED_TIME + 1000 },
				],
				createdAt: FIXED_TIME,
				updatedAt: FIXED_TIME + 1000,
			},
		],
		{ activeThreadId: "thread-1" },
	);

	assert.match(markup, /thread-card--active/);
	assert.match(markup, /Selected paragraph/);
	assert.match(markup, /data-thread-reply-form/);
	assert.match(markup, /<textarea[^>]*data-thread-reply-input/);
	assert.match(markup, /Reply/);
	assert.doesNotMatch(markup, /severity|status|classification|tag/i);
});

test("renderThreadsMarkup preserves reply draft content per thread", () => {
	const markup = renderThreadsMarkup(
		[
			{
				threadId: "thread-1",
				anchor: { exact: "Selected paragraph" },
				comments: [{ commentId: "c1", body: "C1", createdAt: FIXED_TIME }],
				createdAt: FIXED_TIME,
				updatedAt: FIXED_TIME,
			},
		],
		{
			activeThreadId: "thread-1",
			replyDrafts: new Map([["thread-1", "keep this draft"]]),
		},
	);

	assert.match(markup, />keep this draft<\/textarea>/);
});

test("renderThreadsMarkup labels stale anchors", () => {
	const markup = renderThreadsMarkup([
		{
			threadId: "thread-1",
			anchor: { exact: "Removed paragraph" },
			comments: [{ commentId: "c1", body: "C1", createdAt: FIXED_TIME }],
			createdAt: FIXED_TIME,
			updatedAt: FIXED_TIME,
			stale: true,
		},
	]);

	assert.match(markup, /stale anchor/i);
	assert.match(markup, /thread-card--stale/);
});

test("renderThreadsMarkup returns empty-state copy when there are no threads", () => {
	const markup = renderThreadsMarkup([], { activeThreadId: null });
	assert.match(markup, /No comment threads yet/i);
});
