import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export const DEFAULT_BASE_BRANCH = "main";
export const DEFAULT_BRANCH_PREFIX = "feat/";

export interface RepoContext {
	gitRoot: string;
	repoName: string;
	parentDir: string;
}

export interface WorktreeInfo {
	path: string;
	head?: string;
	branch?: string;
	detached: boolean;
	isPrunable: boolean;
	isMain: boolean;
	dirty: boolean;
}

export interface CreateWorktreeResult {
	ok: boolean;
	slug: string;
	branch: string;
	worktreePath: string;
	repoContext?: RepoContext;
	error?: string;
}

export interface EnsureBranchResult {
	ok: boolean;
	branch: string;
	repoContext?: RepoContext;
	created: boolean;
	checkedOut: boolean;
	error?: string;
}

function normalizeInput(input: string): string {
	let text = input.trim();
	if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
		text = text.slice(1, -1).trim();
	}
	return text;
}

export function slugifyFeature(input: string): string {
	const normalized = normalizeInput(input)
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");

	if (normalized.length > 0) return normalized;
	return `feature-${Date.now()}`;
}

export function buildFeatureBranch(slug: string, prefix = DEFAULT_BRANCH_PREFIX): string {
	return `${prefix}${slug}`;
}

export function buildWorktreePath(repo: RepoContext, slug: string): string {
	return path.join(repo.parentDir, `${repo.repoName}-${slug}`);
}

export function buildWindowName(slug: string): string {
	const safe = slug.replace(/[^a-z0-9-]/gi, "-");
	if (safe.length <= 32) return safe;
	return safe.slice(0, 32);
}

export function shellQuote(input: string): string {
	return `'${input.replace(/'/g, `'"'"'`)}'`;
}

async function git(pi: ExtensionAPI, cwd: string, args: string[]) {
	return pi.exec("git", ["-C", cwd, ...args]);
}

export async function getRepoContext(pi: ExtensionAPI, cwd: string): Promise<RepoContext | null> {
	const rootResult = await git(pi, cwd, ["rev-parse", "--show-toplevel"]);
	if (rootResult.code !== 0) return null;
	const gitRoot = rootResult.stdout.trim();
	if (!gitRoot) return null;
	return {
		gitRoot,
		repoName: path.basename(gitRoot),
		parentDir: path.dirname(gitRoot),
	};
}

async function branchExists(pi: ExtensionAPI, gitRoot: string, branch: string): Promise<boolean> {
	const result = await git(pi, gitRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
	return result.code === 0;
}

async function isClean(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const result = await git(pi, cwd, ["status", "--porcelain"]);
	if (result.code !== 0) return true;
	return result.stdout.trim().length === 0;
}

function parseWorktreePorcelain(output: string): WorktreeInfo[] {
	const items: WorktreeInfo[] = [];
	let current: Partial<WorktreeInfo> | null = null;

	const pushCurrent = () => {
		if (!current?.path) return;
		items.push({
			path: current.path,
			head: current.head,
			branch: current.branch,
			detached: current.detached ?? false,
			isPrunable: current.isPrunable ?? false,
			isMain: false,
			dirty: false,
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
		} else if (line.startsWith("prunable")) {
			current.isPrunable = true;
		}
	}

	pushCurrent();
	return items;
}

export async function listWorktrees(pi: ExtensionAPI, cwd: string): Promise<{ repo: RepoContext; items: WorktreeInfo[] } | null> {
	const repo = await getRepoContext(pi, cwd);
	if (!repo) return null;

	const listResult = await git(pi, repo.gitRoot, ["worktree", "list", "--porcelain"]);
	if (listResult.code !== 0) return null;

	const parsed = parseWorktreePorcelain(listResult.stdout);
	const rootResolved = path.resolve(repo.gitRoot);

	for (const wt of parsed) {
		wt.isMain = path.resolve(wt.path) === rootResolved;
		wt.dirty = !(await isClean(pi, wt.path));
	}

	return { repo, items: parsed };
}

export function findFeatureWorktree(items: WorktreeInfo[], slug: string, prefix = DEFAULT_BRANCH_PREFIX): WorktreeInfo | undefined {
	const branch = buildFeatureBranch(slug, prefix);
	return items.find((item) => item.branch === branch || path.basename(item.path).endsWith(`-${slug}`));
}

export async function createFeatureWorktree(
	pi: ExtensionAPI,
	cwd: string,
	briefOrSlug: string,
	options?: { baseBranch?: string; branchPrefix?: string },
): Promise<CreateWorktreeResult> {
	const baseBranch = options?.baseBranch ?? DEFAULT_BASE_BRANCH;
	const branchPrefix = options?.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
	const slug = slugifyFeature(briefOrSlug);
	const branch = buildFeatureBranch(slug, branchPrefix);

	const repo = await getRepoContext(pi, cwd);
	if (!repo) {
		return { ok: false, slug, branch, worktreePath: "", error: "Not inside a git repository." };
	}

	const worktreePath = buildWorktreePath(repo, slug);
	if (fs.existsSync(worktreePath)) {
		return {
			ok: false,
			slug,
			branch,
			worktreePath,
			repoContext: repo,
			error: `Target path already exists: ${worktreePath}`,
		};
	}

	const hasBase = await git(pi, repo.gitRoot, ["rev-parse", "--verify", baseBranch]);
	if (hasBase.code !== 0) {
		return {
			ok: false,
			slug,
			branch,
			worktreePath,
			repoContext: repo,
			error: `Base branch '${baseBranch}' not found.`,
		};
	}

	if (await branchExists(pi, repo.gitRoot, branch)) {
		return {
			ok: false,
			slug,
			branch,
			worktreePath,
			repoContext: repo,
			error: `Branch '${branch}' already exists.`,
		};
	}

	const addResult = await git(pi, repo.gitRoot, ["worktree", "add", "-b", branch, worktreePath, baseBranch]);
	if (addResult.code !== 0) {
		return {
			ok: false,
			slug,
			branch,
			worktreePath,
			repoContext: repo,
			error: addResult.stderr.trim() || addResult.stdout.trim() || "Failed to create worktree.",
		};
	}

	return { ok: true, slug, branch, worktreePath, repoContext: repo };
}

export async function ensureFeatureBranchFromMain(
	pi: ExtensionAPI,
	cwd: string,
	briefOrSlug: string,
	options?: { baseBranch?: string; branchPrefix?: string },
): Promise<EnsureBranchResult> {
	const baseBranch = options?.baseBranch ?? DEFAULT_BASE_BRANCH;
	const branchPrefix = options?.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
	const slug = slugifyFeature(briefOrSlug);
	const branch = buildFeatureBranch(slug, branchPrefix);

	const repo = await getRepoContext(pi, cwd);
	if (!repo) return { ok: false, branch, created: false, checkedOut: false, error: "Not inside a git repository." };

	const hasBase = await git(pi, repo.gitRoot, ["rev-parse", "--verify", baseBranch]);
	if (hasBase.code !== 0) {
		return {
			ok: false,
			branch,
			repoContext: repo,
			created: false,
			checkedOut: false,
			error: `Base branch '${baseBranch}' not found.`,
		};
	}

	let created = false;
	if (!(await branchExists(pi, repo.gitRoot, branch))) {
		const createResult = await git(pi, repo.gitRoot, ["branch", branch, baseBranch]);
		if (createResult.code !== 0) {
			return {
				ok: false,
				branch,
				repoContext: repo,
				created: false,
				checkedOut: false,
				error: createResult.stderr.trim() || createResult.stdout.trim() || "Failed to create branch.",
			};
		}
		created = true;
	}

	if (!(await isClean(pi, repo.gitRoot))) {
		return {
			ok: true,
			branch,
			repoContext: repo,
			created,
			checkedOut: false,
			error: "Repository has uncommitted changes; branch created but not checked out.",
		};
	}

	const checkoutResult = await git(pi, repo.gitRoot, ["checkout", branch]);
	if (checkoutResult.code !== 0) {
		return {
			ok: false,
			branch,
			repoContext: repo,
			created,
			checkedOut: false,
			error: checkoutResult.stderr.trim() || checkoutResult.stdout.trim() || "Failed to checkout branch.",
		};
	}

	return { ok: true, branch, repoContext: repo, created, checkedOut: true };
}

export async function removeWorktree(
	pi: ExtensionAPI,
	cwd: string,
	worktreePath: string,
	force = false,
): Promise<{ ok: boolean; error?: string }> {
	const repo = await getRepoContext(pi, cwd);
	if (!repo) return { ok: false, error: "Not inside a git repository." };

	const result = await git(pi, repo.gitRoot, ["worktree", "remove", ...(force ? ["--force"] : []), worktreePath]);
	if (result.code !== 0) {
		return { ok: false, error: result.stderr.trim() || result.stdout.trim() || "Failed to remove worktree." };
	}
	return { ok: true };
}

export async function pruneWorktrees(pi: ExtensionAPI, cwd: string): Promise<{ ok: boolean; error?: string }> {
	const repo = await getRepoContext(pi, cwd);
	if (!repo) return { ok: false, error: "Not inside a git repository." };

	const result = await git(pi, repo.gitRoot, ["worktree", "prune"]);
	if (result.code !== 0) {
		return { ok: false, error: result.stderr.trim() || result.stdout.trim() || "Failed to prune worktrees." };
	}
	return { ok: true };
}

export async function launchPiInTmux(
	pi: ExtensionAPI,
	options: { cwd: string; windowName: string; initialPrompt?: string; continueSession?: boolean },
): Promise<{ ok: boolean; error?: string; fallbackCommand?: string }> {
	const tmuxVersion = await pi.exec("tmux", ["-V"]);
	if (tmuxVersion.code !== 0) {
		const fallbackCommand = options.initialPrompt
			? `cd ${shellQuote(options.cwd)} && pi ${shellQuote(options.initialPrompt)}`
			: `cd ${shellQuote(options.cwd)} && pi -c`;
		return { ok: false, error: "tmux is not available.", fallbackCommand };
	}

	const piCommand = options.continueSession
		? "pi -c"
		: options.initialPrompt
			? `pi ${shellQuote(options.initialPrompt)}`
			: "pi";

	const openResult = await pi.exec("tmux", ["new-window", "-n", options.windowName, "-c", options.cwd, piCommand]);
	if (openResult.code !== 0) {
		const fallbackCommand = options.initialPrompt
			? `cd ${shellQuote(options.cwd)} && pi ${shellQuote(options.initialPrompt)}`
			: `cd ${shellQuote(options.cwd)} && pi -c`;
		return {
			ok: false,
			error: openResult.stderr.trim() || openResult.stdout.trim() || "Failed to open tmux window.",
			fallbackCommand,
		};
	}

	return { ok: true };
}
