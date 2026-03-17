import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const sourceTests = [
	"extensions/document-reviewer/github-pr.test.ts",
	"extensions/document-reviewer/pr-diff-map.test.ts",
	"extensions/document-reviewer/pr-worktree.test.ts",
	"extensions/document-reviewer/review-page.test.ts",
	"extensions/document-reviewer/server.test.ts",
];

const tempDir = mkdtempSync(path.join(os.tmpdir(), "pi-config-doc-review-tests-"));

function run(command, args) {
	const result = spawnSync(command, args, {
		cwd: process.cwd(),
		stdio: "inherit",
		encoding: "utf-8",
	});

	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

try {
	run("npx", [
		"tsc",
		"--skipLibCheck",
		"--module",
		"nodenext",
		"--moduleResolution",
		"nodenext",
		"--target",
		"es2022",
		"--outDir",
		tempDir,
		"--rootDir",
		".",
		"--declaration",
		"false",
		"--sourceMap",
		"false",
		...sourceTests,
	]);

	const compiledTests = sourceTests.map((testPath) =>
		path.join(tempDir, testPath.replace(/\.ts$/, ".js")),
	);

	run("node", ["--test", ...compiledTests]);
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}
