import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	buildPullRequestWorktreePath,
	buildPullRequestWorktreeRoot,
	buildPullRequestWorktreeSlug,
	cleanupPullRequestWorktree,
	ensurePullRequestWorktree,
} from "./pr-worktree.js";

interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

type ExecHandler = (command: string, args: string[]) => ExecResult | Promise<ExecResult>;

function createPi(handler: ExecHandler) {
	const calls: Array<{ command: string; args: string[] }> = [];
	const pi = {
		exec: async (command: string, args: string[]) => {
			calls.push({ command, args: [...args] });
			return handler(command, args);
		},
	} as unknown as ExtensionAPI;
	return { pi, calls };
}

function makeRepoFixture() {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pr-worktree-test-"));
	const gitRoot = path.join(tempRoot, "repo");
	fs.mkdirSync(gitRoot, { recursive: true });
	return {
		tempRoot,
		gitRoot,
		repoName: path.basename(gitRoot),
		parentDir: path.dirname(gitRoot),
		worktreePath(prNumber = 42) {
			return path.join(this.parentDir, `${this.repoName}-pr-review-worktrees`, `pr-${prNumber}`);
		},
		cleanup() {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		},
	};
}

function worktreeListOutput(gitRoot: string, entries: Array<{ path: string; head: string; detached?: boolean; branch?: string }>) {
	const blocks = [
		[
			`worktree ${gitRoot}`,
			"HEAD deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
			"branch refs/heads/main",
		].join("\n"),
		...entries.map((entry) =>
			[
				`worktree ${entry.path}`,
				`HEAD ${entry.head}`,
				entry.detached ? "detached" : `branch refs/heads/${entry.branch ?? "feature/test"}`,
			].join("\n"),
		),
	];
	return `${blocks.join("\n\n")}\n`;
}

test("buildPullRequestWorktree helpers use a reserved deterministic PR-review namespace", () => {
	const repo = {
		gitRoot: "/workspace/repo",
		repoName: "repo",
		parentDir: "/workspace",
	};

	assert.equal(buildPullRequestWorktreeSlug(42), "pr-42");
	assert.equal(buildPullRequestWorktreeRoot(repo), "/workspace/repo-pr-review-worktrees");
	assert.equal(buildPullRequestWorktreePath(repo, 42), "/workspace/repo-pr-review-worktrees/pr-42");
});

test("ensurePullRequestWorktree reuses an existing clean detached worktree at the requested head SHA", async () => {
	const fixture = makeRepoFixture();
	const worktreePath = fixture.worktreePath();
	fs.mkdirSync(worktreePath, { recursive: true });

	const { pi, calls } = createPi((_command, args) => {
		const joined = args.join(" ");
		if (joined === `-C ${fixture.gitRoot} rev-parse --show-toplevel`) {
			return { code: 0, stdout: `${fixture.gitRoot}\n`, stderr: "" };
		}
		if (joined === `-C ${fixture.gitRoot} worktree list --porcelain`) {
			return {
				code: 0,
				stdout: worktreeListOutput(fixture.gitRoot, [{ path: worktreePath, head: "abc123", detached: true }]),
				stderr: "",
			};
		}
		if (joined === `-C ${worktreePath} status --porcelain`) {
			return { code: 0, stdout: "", stderr: "" };
		}
		throw new Error(`Unexpected git call: ${joined}`);
	});

	try {
		const result = await ensurePullRequestWorktree(pi, fixture.gitRoot, { prNumber: 42, headSha: "abc123" });

		assert.deepEqual(result, {
			ok: true,
			worktreePath,
			recovered: true,
			created: false,
			repoContext: {
				gitRoot: fixture.gitRoot,
				repoName: fixture.repoName,
				parentDir: fixture.parentDir,
			},
		});
		assert.equal(calls.some((call) => call.args.includes("add")), false);
	} finally {
		fixture.cleanup();
	}
});

test("ensurePullRequestWorktree refuses to mutate a dirty existing PR worktree", async () => {
	const fixture = makeRepoFixture();
	const worktreePath = fixture.worktreePath();
	fs.mkdirSync(worktreePath, { recursive: true });

	const { pi, calls } = createPi((_command, args) => {
		const joined = args.join(" ");
		if (joined === `-C ${fixture.gitRoot} rev-parse --show-toplevel`) {
			return { code: 0, stdout: `${fixture.gitRoot}\n`, stderr: "" };
		}
		if (joined === `-C ${fixture.gitRoot} worktree list --porcelain`) {
			return {
				code: 0,
				stdout: worktreeListOutput(fixture.gitRoot, [{ path: worktreePath, head: "oldsha", detached: true }]),
				stderr: "",
			};
		}
		if (joined === `-C ${worktreePath} status --porcelain`) {
			return { code: 0, stdout: " M draft.md\n", stderr: "" };
		}
		throw new Error(`Unexpected git call: ${joined}`);
	});

	try {
		const result = await ensurePullRequestWorktree(pi, fixture.gitRoot, { prNumber: 42, headSha: "newsha" });

		assert.deepEqual(result, {
			ok: false,
			worktreePath,
			recovered: true,
			created: false,
			repoContext: {
				gitRoot: fixture.gitRoot,
				repoName: fixture.repoName,
				parentDir: fixture.parentDir,
			},
			error: `Existing PR review worktree ${worktreePath} has uncommitted changes. Clean it up manually before retrying /review-pr.`,
		});
		assert.equal(calls.some((call) => call.args.includes("remove")), false);
		assert.equal(calls.some((call) => call.args.includes("add")), false);
	} finally {
		fixture.cleanup();
	}
});

test("ensurePullRequestWorktree removes a stale registered worktree and recreates it detached at the PR head SHA", async () => {
	const fixture = makeRepoFixture();
	const worktreePath = fixture.worktreePath();
	fs.mkdirSync(worktreePath, { recursive: true });

	const { pi, calls } = createPi((_command, args) => {
		const joined = args.join(" ");
		if (joined === `-C ${fixture.gitRoot} rev-parse --show-toplevel`) {
			return { code: 0, stdout: `${fixture.gitRoot}\n`, stderr: "" };
		}
		if (joined === `-C ${fixture.gitRoot} worktree list --porcelain`) {
			return {
				code: 0,
				stdout: worktreeListOutput(fixture.gitRoot, [{ path: worktreePath, head: "oldsha", detached: true }]),
				stderr: "",
			};
		}
		if (joined === `-C ${worktreePath} status --porcelain`) {
			return { code: 0, stdout: "", stderr: "" };
		}
		if (joined === `-C ${fixture.gitRoot} worktree remove ${worktreePath}`) {
			return { code: 0, stdout: "", stderr: "" };
		}
		if (joined === `-C ${fixture.gitRoot} worktree add --detach ${worktreePath} newsha`) {
			return { code: 0, stdout: "", stderr: "" };
		}
		throw new Error(`Unexpected git call: ${joined}`);
	});

	try {
		const result = await ensurePullRequestWorktree(pi, fixture.gitRoot, { prNumber: 42, headSha: "newsha" });

		assert.equal(result.ok, true);
		assert.equal(result.recovered, true);
		assert.equal(result.created, true);
		assert.deepEqual(
			calls
				.filter((call) => call.args.includes("worktree"))
				.map((call) => call.args.slice(2)),
			[
				["worktree", "list", "--porcelain"],
				["worktree", "remove", worktreePath],
				["worktree", "add", "--detach", worktreePath, "newsha"],
			],
		);
	} finally {
		fixture.cleanup();
	}
});

test("ensurePullRequestWorktree protects unregistered directories at the deterministic path", async () => {
	const fixture = makeRepoFixture();
	const worktreePath = fixture.worktreePath();
	fs.mkdirSync(worktreePath, { recursive: true });

	const { pi, calls } = createPi((_command, args) => {
		const joined = args.join(" ");
		if (joined === `-C ${fixture.gitRoot} rev-parse --show-toplevel`) {
			return { code: 0, stdout: `${fixture.gitRoot}\n`, stderr: "" };
		}
		if (joined === `-C ${fixture.gitRoot} worktree list --porcelain`) {
			return { code: 0, stdout: worktreeListOutput(fixture.gitRoot, []), stderr: "" };
		}
		throw new Error(`Unexpected git call: ${joined}`);
	});

	try {
		const result = await ensurePullRequestWorktree(pi, fixture.gitRoot, { prNumber: 42, headSha: "abc123" });

		assert.deepEqual(result, {
			ok: false,
			worktreePath,
			recovered: false,
			created: false,
			repoContext: {
				gitRoot: fixture.gitRoot,
				repoName: fixture.repoName,
				parentDir: fixture.parentDir,
			},
			error: `PR review worktree path ${worktreePath} already exists outside git's worktree list. Remove it manually before retrying /review-pr.`,
		});
		assert.equal(calls.some((call) => call.args.includes("remove")), false);
		assert.equal(calls.some((call) => call.args.includes("add")), false);
	} finally {
		fixture.cleanup();
	}
});

test("cleanupPullRequestWorktree reports git removal failures instead of hiding them", async () => {
	const fixture = makeRepoFixture();
	const worktreePath = fixture.worktreePath();
	fs.mkdirSync(worktreePath, { recursive: true });

	const { pi } = createPi((_command, args) => {
		const joined = args.join(" ");
		if (joined === `-C ${fixture.gitRoot} rev-parse --show-toplevel`) {
			return { code: 0, stdout: `${fixture.gitRoot}\n`, stderr: "" };
		}
		if (joined === `-C ${fixture.gitRoot} worktree list --porcelain`) {
			return {
				code: 0,
				stdout: worktreeListOutput(fixture.gitRoot, [{ path: worktreePath, head: "abc123", detached: true }]),
				stderr: "",
			};
		}
		if (joined === `-C ${fixture.gitRoot} worktree remove ${worktreePath}`) {
			return { code: 1, stdout: "", stderr: "worktree contains modified files" };
		}
		throw new Error(`Unexpected git call: ${joined}`);
	});

	try {
		const result = await cleanupPullRequestWorktree(pi, fixture.gitRoot, { prNumber: 42 });
		assert.deepEqual(result, {
			ok: false,
			removed: false,
			worktreePath,
			error: `Failed to remove PR review worktree ${worktreePath}: worktree contains modified files`,
		});
	} finally {
		fixture.cleanup();
	}
});

test("cleanupPullRequestWorktree treats already-absent paths as a successful no-op", async () => {
	const fixture = makeRepoFixture();
	const worktreePath = fixture.worktreePath();

	const { pi } = createPi((_command, args) => {
		const joined = args.join(" ");
		if (joined === `-C ${fixture.gitRoot} rev-parse --show-toplevel`) {
			return { code: 0, stdout: `${fixture.gitRoot}\n`, stderr: "" };
		}
		if (joined === `-C ${fixture.gitRoot} worktree list --porcelain`) {
			return { code: 0, stdout: worktreeListOutput(fixture.gitRoot, []), stderr: "" };
		}
		throw new Error(`Unexpected git call: ${joined}`);
	});

	try {
		const result = await cleanupPullRequestWorktree(pi, fixture.gitRoot, { prNumber: 42 });
		assert.deepEqual(result, { ok: true, removed: false, worktreePath });
	} finally {
		fixture.cleanup();
	}
});

test("cleanupPullRequestWorktree protects unregistered directories at the deterministic path", async () => {
	const fixture = makeRepoFixture();
	const worktreePath = fixture.worktreePath();
	fs.mkdirSync(worktreePath, { recursive: true });

	const { pi, calls } = createPi((_command, args) => {
		const joined = args.join(" ");
		if (joined === `-C ${fixture.gitRoot} rev-parse --show-toplevel`) {
			return { code: 0, stdout: `${fixture.gitRoot}\n`, stderr: "" };
		}
		if (joined === `-C ${fixture.gitRoot} worktree list --porcelain`) {
			return { code: 0, stdout: worktreeListOutput(fixture.gitRoot, []), stderr: "" };
		}
		throw new Error(`Unexpected git call: ${joined}`);
	});

	try {
		const result = await cleanupPullRequestWorktree(pi, fixture.gitRoot, { prNumber: 42 });
		assert.deepEqual(result, {
			ok: false,
			removed: false,
			worktreePath,
			error: `PR review worktree path ${worktreePath} exists but is not registered as a git worktree. Remove it manually.`,
		});
		assert.equal(calls.some((call) => call.args.includes("remove")), false);
	} finally {
		fixture.cleanup();
	}
});
