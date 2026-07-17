import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DEFAULT_BASE_BRANCH = "main";
export const DEFAULT_BRANCH_PREFIX = "feat/";
export const DEFAULT_MAX_SLUG_LENGTH = 48;
export const DEFAULT_SLUG_WORD_LIMIT = 5;
export const DEFAULT_SLUG_DUPLICATE_ATTEMPTS = 20;

export interface RepoContext {
	gitRoot: string;
	currentRoot: string;
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

export interface WorktreeEnvironmentCopyResult {
	copied: string[];
	skipped: string[];
	warnings: string[];
}

export interface CreateWorktreeResult {
	ok: boolean;
	slug: string;
	branch: string;
	worktreePath: string;
	repoContext?: RepoContext;
	environmentCopy?: WorktreeEnvironmentCopyResult;
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

const SLUG_STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"but",
	"by",
	"can",
	"could",
	"first",
	"for",
	"from",
	"how",
	"i",
	"in",
	"into",
	"is",
	"it",
	"its",
	"let",
	"lets",
	"like",
	"make",
	"making",
	"modify",
	"modifying",
	"my",
	"need",
	"of",
	"on",
	"or",
	"our",
	"please",
	"second",
	"so",
	"that",
	"the",
	"their",
	"them",
	"then",
	"third",
	"this",
	"to",
	"try",
	"trying",
	"update",
	"updating",
	"want",
	"we",
	"with",
	"would",
	"you",
	"your",
]);

function normalizeSlugText(input: string): string {
	return input
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
}

function looksLikeSlug(input: string): boolean {
	return /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(input);
}

function stripLeadingIntent(text: string): string {
	const patterns = [
		/^\s*(?:first|second|third|fourth)\s*[,:-]?\s*/i,
		/^\s*(?:i|we)\s+(?:want|need|would\s+like|am\s+trying|are\s+trying)\s+to\s+/i,
		/^\s*(?:please|can\s+you|could\s+you)\s+/i,
		/^\s*let'?s\s+/i,
	];

	let current = text.trim();
	for (const pattern of patterns) current = current.replace(pattern, "").trim();
	return current;
}

function toWords(text: string): string[] {
	return normalizeSlugText(text).split("-").filter(Boolean);
}

function compactSlug(normalized: string, maxWords = DEFAULT_SLUG_WORD_LIMIT): string {
	if (!normalized) return normalized;
	const words = normalized.split("-").filter(Boolean);
	return words.slice(0, maxWords).join("-");
}

function truncateSlugWithHash(base: string, seed: string, maxLength: number): string {
	const hash = createHash("sha1").update(seed).digest("hex").slice(0, 8);
	const headLength = Math.max(1, maxLength - hash.length - 1);
	const head = base.slice(0, headLength).replace(/-+$/g, "");
	return `${head || "feature"}-${hash}`;
}

export function slugifyFeature(input: string, maxLength = DEFAULT_MAX_SLUG_LENGTH): string {
	const raw = normalizeInput(input);
	if (!raw) return `feature-${Date.now()}`;

	if (looksLikeSlug(raw)) {
		const normalizedSlug = normalizeSlugText(raw);
		if (!normalizedSlug) return `feature-${Date.now()}`;
		if (normalizedSlug.length <= maxLength) return normalizedSlug;
		return truncateSlugWithHash(normalizedSlug, normalizedSlug, maxLength);
	}

	const normalized = normalizeSlugText(raw);
	if (!normalized) return `feature-${Date.now()}`;

	const firstSentence = raw.split(/[\n.!?]/).map((part) => part.trim()).find(Boolean) ?? raw;
	const firstClause = firstSentence.split(/(?:\s+-\s+|,|;|\b(?:and\s+then|then|also|but)\b)/i)[0]?.trim() ?? firstSentence;
	const intentStripped = stripLeadingIntent(firstClause);

	const informativeWords: string[] = [];
	for (const word of toWords(intentStripped)) {
		if (word.length <= 2 || SLUG_STOPWORDS.has(word)) continue;
		if (!informativeWords.includes(word)) informativeWords.push(word);
		if (informativeWords.length >= DEFAULT_SLUG_WORD_LIMIT) break;
	}

	const base = (informativeWords.join("-") || compactSlug(normalized) || normalized).replace(/^-+|-+$/g, "");
	if (base.length <= maxLength) return base;
	return truncateSlugWithHash(base, normalized, maxLength);
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
	const currentRoot = rootResult.stdout.trim();
	if (!currentRoot) return null;

	// Git lists the primary worktree first. Using it keeps sibling naming and
	// local-environment copying stable even when /ws new runs in another worktree.
	const worktrees = await git(pi, currentRoot, ["worktree", "list", "--porcelain"]);
	const primaryRoot = worktrees.code === 0
		? worktrees.stdout.split("\n").find((line) => line.startsWith("worktree "))?.slice("worktree ".length).trim()
		: undefined;
	const gitRoot = primaryRoot || currentRoot;

	return {
		gitRoot,
		currentRoot,
		repoName: path.basename(gitRoot),
		parentDir: path.dirname(gitRoot),
	};
}

async function branchExists(pi: ExtensionAPI, gitRoot: string, branch: string): Promise<boolean> {
	const result = await git(pi, gitRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
	return result.code === 0;
}

async function reserveAvailableSlug(
	pi: ExtensionAPI,
	repo: RepoContext,
	baseSlug: string,
	branchPrefix: string,
	maxAttempts = DEFAULT_SLUG_DUPLICATE_ATTEMPTS,
): Promise<{ slug: string; branch: string; worktreePath: string } | null> {
	for (let i = 0; i < maxAttempts; i++) {
		const suffix = i === 0 ? "" : `-${i + 1}`;
		const slug = `${baseSlug}${suffix}`;
		const branch = buildFeatureBranch(slug, branchPrefix);
		const worktreePath = buildWorktreePath(repo, slug);
		if (fs.existsSync(worktreePath)) continue;
		if (await branchExists(pi, repo.gitRoot, branch)) continue;
		return { slug, branch, worktreePath };
	}

	return null;
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
	options?: { baseBranch?: string; branchPrefix?: string; copyLocalEnvironment?: boolean; signal?: AbortSignal },
): Promise<CreateWorktreeResult> {
	const baseBranch = options?.baseBranch ?? DEFAULT_BASE_BRANCH;
	const branchPrefix = options?.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
	const requestedSlug = slugifyFeature(briefOrSlug);

	const repo = await getRepoContext(pi, cwd);
	if (!repo) {
		return { ok: false, slug: requestedSlug, branch: buildFeatureBranch(requestedSlug, branchPrefix), worktreePath: "", error: "Not inside a git repository." };
	}

	const hasBase = await git(pi, repo.gitRoot, ["rev-parse", "--verify", baseBranch]);
	if (hasBase.code !== 0) {
		const branch = buildFeatureBranch(requestedSlug, branchPrefix);
		const worktreePath = buildWorktreePath(repo, requestedSlug);
		return {
			ok: false,
			slug: requestedSlug,
			branch,
			worktreePath,
			repoContext: repo,
			error: `Base branch '${baseBranch}' not found.`,
		};
	}

	const reserved = await reserveAvailableSlug(pi, repo, requestedSlug, branchPrefix);
	if (!reserved) {
		const branch = buildFeatureBranch(requestedSlug, branchPrefix);
		const worktreePath = buildWorktreePath(repo, requestedSlug);
		return {
			ok: false,
			slug: requestedSlug,
			branch,
			worktreePath,
			repoContext: repo,
			error: `Could not reserve a unique slug for '${requestedSlug}' after ${DEFAULT_SLUG_DUPLICATE_ATTEMPTS} attempts.`,
		};
	}

	const { slug, branch, worktreePath } = reserved;
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

	let environmentCopy: WorktreeEnvironmentCopyResult | undefined;
	if (options?.copyLocalEnvironment ?? true) {
		environmentCopy = { copied: [], skipped: [], warnings: [] };
		const mergeCopy = (source: string, sourceCopy: WorktreeEnvironmentCopyResult) => {
			environmentCopy!.copied.push(...sourceCopy.copied);
			environmentCopy!.skipped.push(...sourceCopy.skipped);
			environmentCopy!.warnings.push(...sourceCopy.warnings.map((warning) => `${source}: ${warning}`));
		};

		if (repo.currentRoot === repo.gitRoot) {
			mergeCopy(repo.gitRoot, await copyWorktreeEnvironment(repo.gitRoot, worktreePath, options?.signal));
		} else {
			// Current task/skill context wins, while the primary index matches the
			// main-based checkout. Fall back to the current index only if primary has none.
			mergeCopy(
				repo.currentRoot,
				await copyWorktreeEnvironment(repo.currentRoot, worktreePath, options?.signal, { includeSemanticIndex: false }),
			);
			mergeCopy(repo.gitRoot, await copyWorktreeEnvironment(repo.gitRoot, worktreePath, options?.signal));
			if (!fs.existsSync(path.join(worktreePath, ".pi", "semantic-search", "index.json"))) {
				mergeCopy(
					repo.currentRoot,
					await copyWorktreeEnvironment(repo.currentRoot, worktreePath, options?.signal, { includeRootArtifacts: false }),
				);
			}
		}
		environmentCopy.copied = [...new Set(environmentCopy.copied)].sort();
		environmentCopy.skipped = [...new Set(environmentCopy.skipped)].sort();
	}
	if (environmentCopy?.copied.length) {
		const warning = await excludeCopiedEnvironmentFromGit(pi, repo.gitRoot, environmentCopy.copied);
		if (warning) environmentCopy.warnings.push(warning);
	}

	return { ok: true, slug, branch, worktreePath, repoContext: repo, environmentCopy };
}

function gitExcludePattern(relativePath: string): string {
	const normalized = relativePath.split(path.sep).join("/");
	return `/${normalized.replace(/([\\ \t#*!?\[\]])/g, "\\$1")}`;
}

async function excludeCopiedEnvironmentFromGit(
	pi: ExtensionAPI,
	repoRoot: string,
	copiedPaths: string[],
): Promise<string | undefined> {
	const gitPath = await git(pi, repoRoot, ["rev-parse", "--git-path", "info/exclude"]);
	if (gitPath.code !== 0 || !gitPath.stdout.trim()) return "Could not locate .git/info/exclude for copied local files";

	const excludePath = path.resolve(repoRoot, gitPath.stdout.trim());
	try {
		let existing = "";
		try {
			existing = await fsp.readFile(excludePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const existingLines = new Set(existing.split("\n"));
		const patterns = copiedPaths.map(gitExcludePattern).filter((pattern) => !existingLines.has(pattern));
		if (patterns.length === 0) return undefined;

		await fsp.mkdir(path.dirname(excludePath), { recursive: true });
		const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
		const marker = existing.includes("# pi worktree-manager local environment")
			? ""
			: "# pi worktree-manager local environment\n";
		await fsp.appendFile(excludePath, `${prefix}${marker}${patterns.join("\n")}\n`, "utf8");
		return undefined;
	} catch (error) {
		return `Could not exclude copied local files from Git status: ${(error as Error).message}`;
	}
}

const EXCLUDED_ROOT_DOT_ENTRIES = new Set([
	".git",
	".cache",
	".DS_Store",
	".ruby-lsp",
	".solargraph-cache",
	".yardoc",
]);

const PI_ENVIRONMENT_FILES = new Set([
	"semantic-search/index.json",
	"semantic-search/summaries.json",
]);

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const error = new Error("Worktree environment copy aborted");
	error.name = "AbortError";
	throw error;
}

async function copyLocalEntry(
	sourceRoot: string,
	targetRoot: string,
	relativePath: string,
	result: WorktreeEnvironmentCopyResult,
	signal?: AbortSignal,
): Promise<void> {
	throwIfAborted(signal);
	const sourcePath = path.join(sourceRoot, relativePath);
	const targetPath = path.join(targetRoot, relativePath);
	const sourceStat = await fsp.lstat(sourcePath);

	try {
		const targetStat = await fsp.lstat(targetPath);
		if (!(sourceStat.isDirectory() && targetStat.isDirectory())) {
			result.skipped.push(relativePath);
			return;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	if (sourceStat.isDirectory()) {
		await fsp.mkdir(targetPath, { recursive: true, mode: sourceStat.mode });
		const entries = await fsp.readdir(sourcePath, { withFileTypes: true });
		for (const entry of entries) {
			await copyLocalEntry(sourceRoot, targetRoot, path.join(relativePath, entry.name), result, signal);
		}
		return;
	}

	await fsp.mkdir(path.dirname(targetPath), { recursive: true });
	if (sourceStat.isSymbolicLink()) {
		await fsp.symlink(await fsp.readlink(sourcePath), targetPath);
		result.copied.push(relativePath);
		return;
	}
	if (sourceStat.isFile()) {
		await fsp.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_FICLONE);
		result.copied.push(relativePath);
		return;
	}

	result.skipped.push(relativePath);
}

/**
 * Copy local root dotfiles and dot-directories into a new worktree without
 * overwriting checked-out files. Pi runtime histories stay local to their
 * originating worktree; only the reusable semantic index crosses over.
 */
export async function copyWorktreeEnvironment(
	sourceDir: string,
	targetDir: string,
	signal?: AbortSignal,
	options: { includeRootArtifacts?: boolean; includeSemanticIndex?: boolean } = {},
): Promise<WorktreeEnvironmentCopyResult> {
	const result: WorktreeEnvironmentCopyResult = { copied: [], skipped: [], warnings: [] };
	let entries: fs.Dirent[];
	try {
		entries = await fsp.readdir(sourceDir, { withFileTypes: true });
	} catch (error) {
		result.warnings.push(`Could not read local environment source: ${(error as Error).message}`);
		return result;
	}

	const includeRootArtifacts = options.includeRootArtifacts ?? true;
	const includeSemanticIndex = options.includeSemanticIndex ?? true;
	for (const entry of entries) {
		if (!entry.name.startsWith(".") || EXCLUDED_ROOT_DOT_ENTRIES.has(entry.name)) continue;
		try {
			if (entry.name === ".pi") {
				if (!includeSemanticIndex) continue;
				for (const relativePath of PI_ENVIRONMENT_FILES) {
					const sourcePath = path.join(sourceDir, ".pi", relativePath);
					try {
						await fsp.access(sourcePath);
						await copyLocalEntry(sourceDir, targetDir, path.join(".pi", relativePath), result, signal);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					}
				}
				continue;
			}
			if (includeRootArtifacts) await copyLocalEntry(sourceDir, targetDir, entry.name, result, signal);
		} catch (error) {
			if ((error as Error).name === "AbortError") throw error;
			result.warnings.push(`${entry.name}: ${(error as Error).message}`);
		}
	}

	result.copied.sort();
	result.skipped.sort();
	return result;
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

export type TmuxLaunchMode = "pane" | "window";

export async function launchPiInTmux(
	pi: ExtensionAPI,
	options: {
		cwd: string;
		windowName: string;
		initialPrompt?: string;
		continueSession?: boolean;
		launchMode?: TmuxLaunchMode;
	},
): Promise<{ ok: boolean; error?: string; fallbackCommand?: string }> {
	const launchMode = options.launchMode ?? "pane";

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

	const tmuxArgs =
		launchMode === "window"
			? ["new-window", "-n", options.windowName, "-c", options.cwd, piCommand]
			: ["split-window", "-h", "-c", options.cwd, piCommand];

	const openResult = await pi.exec("tmux", tmuxArgs);
	if (openResult.code !== 0) {
		const fallbackCommand = options.initialPrompt
			? `cd ${shellQuote(options.cwd)} && pi ${shellQuote(options.initialPrompt)}`
			: `cd ${shellQuote(options.cwd)} && pi -c`;
		return {
			ok: false,
			error:
				openResult.stderr.trim() ||
				openResult.stdout.trim() ||
				(launchMode === "window" ? "Failed to open tmux window." : "Failed to open tmux pane."),
			fallbackCommand,
		};
	}

	return { ok: true };
}
