import assert from "node:assert/strict";
import test from "node:test";
import { compilePlainTextReviewExport } from "./export.ts";

const FIXED_TIME = 1_762_115_200_000;

test("compilePlainTextReviewExport formats bullets with anchor context + comment text", () => {
	const result = compilePlainTextReviewExport([
		{
			threadId: "thread-1",
			anchor: { exact: "Selected architecture paragraph" },
			comments: [
				{ commentId: "c1", body: "Clarify the rollout order", createdAt: FIXED_TIME },
				{ commentId: "c2", body: "Mention migration fallback", createdAt: FIXED_TIME + 1 },
			],
			createdAt: FIXED_TIME,
			updatedAt: FIXED_TIME + 1,
		},
		{
			threadId: "thread-2",
			anchor: { exact: "Removed section" },
			comments: [{ commentId: "c3", body: "This thread is now stale", createdAt: FIXED_TIME + 2 }],
			createdAt: FIXED_TIME + 2,
			updatedAt: FIXED_TIME + 2,
			stale: true,
		},
	]);

	assert.equal(result.count, 3);
	assert.match(result.text, /- \[anchor: Selected architecture paragraph\] Clarify the rollout order/);
	assert.match(result.text, /- \[anchor: Selected architecture paragraph\] Mention migration fallback/);
	assert.match(result.text, /- \[stale anchor: Removed section\] This thread is now stale/);
});

test("compilePlainTextReviewExport reports empty exports", () => {
	const result = compilePlainTextReviewExport([]);
	assert.equal(result.count, 0);
	assert.match(result.text, /no comments to export/i);
});
