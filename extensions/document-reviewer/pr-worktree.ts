import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getRepoContext, removeWorktree, type RepoContext } from "../lib/worktree.js";

const PR_REVIEW_WORKTREE_ROOT_SUFFIX = "-pr-review-worktrees";

export interface EnsurePullRequestWorktreeOptions {
	prNumber: number;
	headSha: string;
}

export interface EnsurePullRequestWorktreeResult {
	ok: boolean;
	worktreePath: string;
	repoContext?: RepoContext;
	recovered: boolean;
	created: boolean;
	error?: string;
}

export interface CleanupPullRequestWorktreeOptions {
	prNumber: number;
}

export interface CleanupPullRequestWorktreeResult {
	ok: boolean;
	removed: boolean;
	worktreePath: string;
	error?: string;
}

interface PullRequestWorktreeRecord {
	path: string;
	head?: string;
	branch?: string;
	detached: boolean;
	isMain: boolean;
}

function normalizeResolvedPath(filePath: string): string {
	return path.resolve(filePath);
}

function validatePullRequestNumber(prNumber: number): void {
	if (!Number.isInteger(prNumber) || prNumber <= 0) {
		throw new RangeError(`Pull request number must be a positive integer. Received: ${prNumber}`);
	}
}

function validateHeadSha(headSha: string): string {
	const normalized = headSha.trim();
	if (!normalized) {
		throw new Error("Pull request head SHA is required to create a review worktree.");
	}
	return normalized;
}

async function git(pi: ExtensionAPI, cwd: string, args: string[]) {
	return pi.exec("git", ["-C", cwd, ...args]);
}

function parseWorktreePorcelain(repo: RepoContext, output: string): PullRequestWorktreeRecord[] {
	const items: PullRequestWorktreeRecord[] = [];
	const mainPath = normalizeResolvedPath(repo.gitRoot);
	let current: Partial<PullRequestWorktreeRecord> | null = null;

	const pushCurrent = () => {
		if (!current?.path) return;
		items.push({
			path: current.path,
			head: current.head,
			branch: current.branch,
			detached: current.detached ?? false,
			isMain: normalizeResolvedPath(current.path) === mainPath,
		});
	};

	for (const line of output.split("\n")) {
		if (line.trim().length === 0) {
			pushCurrent();
			current = null;
			continue;
		}

		if (line.startsWith("worktree ")) {
			pushCurrent();
			current = { path: line.slice("worktree ".length).trim() };
			continue;
		}

		if (!current) continue;

		if (line.startsWith("HEAD ")) {
			current.head = line.slice("HEAD ".length).trim();
		} else if (line.startsWith("branch ")) {
			const ref = line.slice("branch ".length).trim();
			current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
			current.detached = false;
		} else if (line === "detached") {
			current.detached = true;
		}
	}

	pushCurrent();
	return items;
}

async function listWorktreeRecords(pi: ExtensionAPI, repo: RepoContext): Promise<PullRequestWorktreeRecord[] | null> {
	const result = await git(pi, repo.gitRoot, ["worktree", "list", "--porcelain"]);
	if (result.code !== 0) return null;
	return parseWorktreePorcelain(repo, result.stdout);
}

async function findPullRequestWorktree(
	pi: ExtensionAPI,
	repo: RepoContext,
	worktreePath: string,
): Promise<PullRequestWorktreeRecord | null | undefined> {
	const items = await listWorktreeRecords(pi, repo);
	if (!items) return null;
	const normalizedTarget = normalizeResolvedPath(worktreePath);
	return items.find((item) => normalizeResolvedPath(item.path) === normalizedTarget);
}

async function inspectWorktreeDirtyState(
	pi: ExtensionAPI,
	worktreePath: string,
): Promise<{ ok: boolean; dirty: boolean; error?: string }> {
	const result = await git(pi, worktreePath, ["status", "--porcelain"]);
	if (result.code !== 0) {
		return {
			ok: false,
			dirty: true,
			error: result.stderr.trim() || result.stdout.trim() || "Failed to inspect worktree status.",
		};
	}
	return { ok: true, dirty: result.stdout.trim().length > 0 };
}

export function buildPullRequestWorktreeSlug(prNumber: number): string {
	validatePullRequestNumber(prNumber);
	return `pr-${prNumber}`;
}

export function buildPullRequestWorktreeRoot(repo: RepoContext): string {
	return path.join(repo.parentDir, `${repo.repoName}${PR_REVIEW_WORKTREE_ROOT_SUFFIX}`);
}

export function buildPullRequestWorktreePath(repo: RepoContext, prNumber: number): string {
	return path.join(buildPullRequestWorktreeRoot(repo), buildPullRequestWorktreeSlug(prNumber));
}

export async function ensurePullRequestWorktree(
	pi: ExtensionAPI,
	cwd: string,
	options: EnsurePullRequestWorktreeOptions,
): Promise<EnsurePullRequestWorktreeResult> {
	const repo = await getRepoContext(pi, cwd);
	if (!repo) {
		return {
			ok: false,
			worktreePath: "",
			recovered: false,
			created: false,
			error: "Not inside a git repository.",
		};
	}

	validatePullRequestNumber(options.prNumber);
	const headSha = validateHeadSha(options.headSha);
	const worktreePath = buildPullRequestWorktreePath(repo, options.prNumber);
	const existing = await findPullRequestWorktree(pi, repo, worktreePath);
	if (existing === null) {
		return {
			ok: false,
			worktreePath,
			repoContext: repo,
			recovered: false,
			created: false,
			error: "Could not inspect git worktrees for this repository.",
		};
	}

	if (existing) {
		const dirtyState = await inspectWorktreeDirtyState(pi, worktreePath);
		if (!dirtyState.ok) {
			return {
				ok: false,
				worktreePath,
				repoContext: repo,
				recovered: true,
				created: false,
				error: `Could not inspect existing PR review worktree ${worktreePath}: ${dirtyState.error}`,
			};
		}

		if (dirtyState.dirty) {
			return {
				ok: false,
				worktreePath,
				repoContext: repo,
				recovered: true,
				created: false,
				error: `Existing PR review worktree ${worktreePath} has uncommitted changes. Clean it up manually before retrying /review-pr.`,
			};
		}

		if (!existing.isMain && existing.detached && existing.head === headSha && fs.existsSync(worktreePath)) {
			return {
				ok: true,
				worktreePath,
				repoContext: repo,
				recovered: true,
				created: false,
			};
		}

		const removed = await removeWorktree(pi, cwd, worktreePath);
		if (!removed.ok) {
			return {
				ok: false,
				worktreePath,
				repoContext: repo,
				recovered: true,
				created: false,
				error: `Failed to recover existing PR review worktree ${worktreePath}: ${removed.error ?? "Failed to remove worktree."}`,
			};
		}
	} else if (fs.existsSync(worktreePath)) {
		return {
			ok: false,
			worktreePath,
			repoContext: repo,
			recovered: false,
			created: false,
			error: `PR review worktree path ${worktreePath} already exists outside git's worktree list. Remove it manually before retrying /review-pr.`,
		};
	}

	fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
	const addResult = await git(pi, repo.gitRoot, ["worktree", "add", "--detach", worktreePath, headSha]);
	if (addResult.code !== 0) {
		return {
			ok: false,
			worktreePath,
			repoContext: repo,
			recovered: Boolean(existing),
			created: false,
			error: addResult.stderr.trim() || addResult.stdout.trim() || `Failed to create PR review worktree ${worktreePath}.`,
		};
	}

	return {
		ok: true,
		worktreePath,
		repoContext: repo,
		recovered: Boolean(existing),
		created: true,
	};
}

export async function cleanupPullRequestWorktree(
	pi: ExtensionAPI,
	cwd: string,
	options: CleanupPullRequestWorktreeOptions,
): Promise<CleanupPullRequestWorktreeResult> {
	const repo = await getRepoContext(pi, cwd);
	if (!repo) {
		return { ok: false, removed: false, worktreePath: "", error: "Not inside a git repository." };
	}

	validatePullRequestNumber(options.prNumber);
	const worktreePath = buildPullRequestWorktreePath(repo, options.prNumber);
	const existing = await findPullRequestWorktree(pi, repo, worktreePath);
	if (existing === null) {
		return { ok: false, removed: false, worktreePath, error: "Could not inspect git worktrees for this repository." };
	}

	if (!existing) {
		if (!fs.existsSync(worktreePath)) return { ok: true, removed: false, worktreePath };
		return {
			ok: false,
			removed: false,
			worktreePath,
			error: `PR review worktree path ${worktreePath} exists but is not registered as a git worktree. Remove it manually.`,
		};
	}

	const removed = await removeWorktree(pi, cwd, worktreePath);
	if (!removed.ok) {
		return {
			ok: false,
			removed: false,
			worktreePath,
			error: `Failed to remove PR review worktree ${worktreePath}: ${removed.error ?? "Failed to remove worktree."}`,
		};
	}

	return { ok: true, removed: true, worktreePath };
}
