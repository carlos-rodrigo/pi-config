import test from "node:test";
import assert from "node:assert/strict";

import { BlameViewerComponent } from "./index.ts";

const validFgTokens = new Set([
	"accent",
	"borderAccent",
	"borderMuted",
	"dim",
	"mdLink",
	"muted",
	"success",
	"text",
	"thinkingHigh",
	"warning",
]);

function createThemeSpy() {
	const fgCalls: string[] = [];
	const bgCalls: string[] = [];

	return {
		theme: {
			fg(color: string, text: string) {
				assert.ok(validFgTokens.has(color), `unexpected fg token: ${color}`);
				fgCalls.push(color);
				return text;
			},
			bg(color: string, text: string) {
				assert.equal(color, "selectedBg");
				bgCalls.push(color);
				return text;
			},
			bold(text: string) {
				return text;
			},
		},
		fgCalls,
		bgCalls,
	};
}

test("BlameViewerComponent renders using supported theme tokens", () => {
	const { theme, fgCalls, bgCalls } = createThemeSpy();
	const viewer = new BlameViewerComponent(
		"/tmp/example.ts",
		[
			{
				hash: "a".repeat(40),
				author: "Alice Example",
				date: "2026-04-15",
				lineNum: 1,
				content: "const answer = 42;",
				isCommitBoundary: false,
			},
			{
				hash: "b".repeat(40),
				author: "Bob Example",
				date: "2026-04-14",
				lineNum: 2,
				content: "export { answer };",
				isCommitBoundary: false,
			},
		],
		theme as any,
		() => {},
	);

	const lines = viewer.render(160);

	assert.ok(lines.length > 0);
	assert.ok(fgCalls.includes("accent"));
	assert.ok(bgCalls.includes("selectedBg"));
});
