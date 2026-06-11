import test from "node:test";
import assert from "node:assert/strict";
import { buildPullRequestDiffMap, getRightSideInlineCommentTarget } from "./pr-diff-map.js";

test("buildPullRequestDiffMap collects changed RIGHT-side lines from unified patches", () => {
	const diffMap = buildPullRequestDiffMap([
		{
			filename: "docs/README.md",
			patch: [
				"@@ -1,4 +1,5 @@",
				" # Title",
				" unchanged",
				"-old line",
				"+updated line",
				"+new line",
				" trailing",
			].join("\n"),
		},
	]);

	assert.deepEqual([...diffMap.get("docs/README.md") ?? []], [3, 4]);
});

test("getRightSideInlineCommentTarget only allows single-line comments on changed RIGHT-side lines", () => {
	const diffMap = buildPullRequestDiffMap([
		{
			filename: "docs/README.md",
			patch: [
				"@@ -10,3 +10,4 @@",
				" context",
				"-before",
				"+after",
				"+another",
				" tail",
			].join("\n"),
		},
	]);

	assert.deepEqual(
		getRightSideInlineCommentTarget(
			{ filePath: "docs/README.md", lineStart: 11, lineEnd: 11 },
			diffMap,
		),
		{ path: "docs/README.md", line: 11, side: "RIGHT" },
	);
	assert.equal(
		getRightSideInlineCommentTarget(
			{ filePath: "docs/README.md", lineStart: 10, lineEnd: 10 },
			diffMap,
		),
		null,
	);
	assert.equal(
		getRightSideInlineCommentTarget(
			{ filePath: "docs/README.md", lineStart: 11, lineEnd: 12 },
			diffMap,
		),
		null,
	);
	assert.equal(
		getRightSideInlineCommentTarget(
			{ filePath: "docs/MISSING.md", lineStart: 11, lineEnd: 11 },
			diffMap,
		),
		null,
	);
});
