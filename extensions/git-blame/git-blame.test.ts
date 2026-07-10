import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BlameViewerComponent, getGitBlame } from "./index.ts";

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

test("getGitBlame supports shell-significant file names", async () => {
	const dir = mkdtempSync(join(tmpdir(), "git-blame-"));
	const file = join(dir, 'quote".ts');
	try {
		execFileSync("git", ["init", "-q"], { cwd: dir });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
		writeFileSync(file, "export const value = 1;\n", "utf8");
		execFileSync("git", ["add", "--", 'quote".ts'], { cwd: dir });
		execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir });

		const blame = await getGitBlame(file);
		assert.equal(blame?.length, 1);
		assert.equal(blame?.[0]?.content, "export const value = 1;");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

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
