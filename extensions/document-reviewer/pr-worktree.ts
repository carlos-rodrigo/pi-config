import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	buildWorktreePath,
	getRepoContext,
	listWorktrees,
	removeWorktree,
	type RepoContext,
	type WorktreeInfo,
} from "../lib/worktree.js";

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

export interface CleanupPullRequestWorktreeResult {
	ok: boolean;
	removed: boolean;
	error?: string;
}

function normalizeResolvedPath(filePath: string): string {
	return path.resolve(filePath);
}

function matchesWorktreePath(item: WorktreeInfo, worktreePath: string): boolean {
	return normalizeResolvedPath(item.path) === normalizeResolvedPath(worktreePath);
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

export function buildPullRequestWorktreeSlug(prNumber: number): string {
	validatePullRequestNumber(prNumber);
	return `pr-${prNumber}`;
}

export function buildPullRequestWorktreePath(repo: RepoContext, prNumber: number): string {
	return buildWorktreePath(repo, buildPullRequestWorktreeSlug(prNumber));
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

	const prNumber = options.prNumber;
	validatePullRequestNumber(prNumber);
	const headSha = validateHeadSha(options.headSha);
	const worktreePath = buildPullRequestWorktreePath(repo, prNumber);

	const listing = await listWorktrees(pi, cwd);
	if (!listing) {
		return {
			ok: false,
			worktreePath,
			repoContext: repo,
			recovered: false,
			created: false,
			error: "Could not inspect git worktrees for this repository.",
		};
	}

	const existing = listing.items.find((item) => matchesWorktreePath(item, worktreePath));
	if (existing) {
		if (existing.dirty) {
			return {
				ok: false,
				worktreePath,
				repoContext: repo,
				recovered: true,
				created: false,
				error: `Existing PR review worktree ${worktreePath} has uncommitted changes. Clean it up manually before retrying /review-pr.`,
			};
		}

		if (existing.detached && existing.head === headSha && fs.existsSync(worktreePath)) {
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
	worktreePath: string,
): Promise<CleanupPullRequestWorktreeResult> {
	const repo = await getRepoContext(pi, cwd);
	if (!repo) {
		return { ok: false, removed: false, error: "Not inside a git repository." };
	}

	const listing = await listWorktrees(pi, cwd);
	if (!listing) {
		return { ok: false, removed: false, error: "Could not inspect git worktrees for this repository." };
	}

	const existing = listing.items.find((item) => matchesWorktreePath(item, worktreePath));
	if (!existing) {
		if (!fs.existsSync(worktreePath)) return { ok: true, removed: false };
		return {
			ok: false,
			removed: false,
			error: `PR review worktree path ${worktreePath} exists but is not registered as a git worktree. Remove it manually.`,
		};
	}

	const removed = await removeWorktree(pi, cwd, worktreePath);
	if (!removed.ok) {
		return {
			ok: false,
			removed: false,
			error: `Failed to remove PR review worktree ${worktreePath}: ${removed.error ?? "Failed to remove worktree."}`,
		};
	}

	return { ok: true, removed: true };
}
