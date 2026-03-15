import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd", ".mdx"]);

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type GitHubCliExecutor = (command: string, args: string[], cwd?: string) => Promise<ExecResult>;

export interface PullRequestReference {
	owner: string;
	repo: string;
	number: number;
	url: string;
}

export interface PullRequestMetadata extends PullRequestReference {
	title: string;
	state: string;
	headSha: string;
	baseSha: string;
	headRefName: string;
	baseRefName: string;
	headRepoFullName: string;
	baseRepoFullName: string;
}

export interface PullRequestFile {
	filename: string;
	status?: string;
	patch?: string;
	previous_filename?: string;
}

export interface PullRequestReviewComment {
	path: string;
	body: string;
	line: number;
	side: "RIGHT";
}

export interface SubmitPullRequestReviewInput {
	commitId: string;
	body?: string;
	comments?: PullRequestReviewComment[];
}

export interface SubmitPullRequestReviewResult {
	id?: number;
	htmlUrl?: string;
}

interface PullRequestReviewApiResponse {
	id?: number;
	html_url?: string;
}

interface PullRequestApiResponse {
	number?: number;
	title?: string;
	state?: string;
	html_url?: string;
	head?: {
		sha?: string;
		ref?: string;
		repo?: {
			full_name?: string;
		};
	};
	base?: {
		sha?: string;
		ref?: string;
		repo?: {
			full_name?: string;
		};
	};
}

export class GitHubPullRequestError extends Error {
	readonly code: string;
	readonly hint?: string;
	readonly details?: Record<string, unknown>;

	constructor(message: string, options?: { code?: string; hint?: string; details?: Record<string, unknown> }) {
		super(message);
		this.name = "GitHubPullRequestError";
		this.code = options?.code ?? "PR_REVIEW_ERROR";
		this.hint = options?.hint;
		this.details = options?.details;
	}
}

function trimTrailingGit(url: string): string {
	return url.replace(/\.git$/i, "");
}

function normalizeRepoFullName(fullName: string): string {
	return fullName.trim().toLowerCase();
}

function normalizePullRequestUrl(owner: string, repo: string, number: number): string {
	return `https://github.com/${owner}/${repo}/pull/${number}`;
}

function extractGitHubRepoFullName(remoteUrl: string): string | null {
	const trimmed = trimTrailingGit(remoteUrl.trim());
	if (!trimmed) return null;

	const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
	if (sshMatch) {
		return `${sshMatch[1]}/${sshMatch[2]}`;
	}

	const sshProtocolMatch = trimmed.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/i);
	if (sshProtocolMatch) {
		return `${sshProtocolMatch[1]}/${sshProtocolMatch[2]}`;
	}

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return null;
	}

	if (!GITHUB_HOSTS.has(parsed.hostname.toLowerCase())) return null;
	const parts = parsed.pathname.split("/").filter(Boolean);
	if (parts.length < 2) return null;
	return `${parts[0]}/${parts[1]}`;
}

function createReviewPayloadTempFile(payload: Record<string, unknown>): string {
	const tempFile = path.join(
		os.tmpdir(),
		`pi-pr-review-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
	);
	fs.writeFileSync(tempFile, JSON.stringify(payload), "utf-8");
	return tempFile;
}

function parseJson<T>(raw: string, context: string): T {
	try {
		return JSON.parse(raw) as T;
	} catch (error) {
		throw new GitHubPullRequestError(`GitHub CLI returned invalid JSON while ${context}.`, {
			code: "GITHUB_INVALID_JSON",
			details: { error: error instanceof Error ? error.message : String(error) },
		});
	}
}

function normalizeErrorText(stderr: string, stdout: string): string {
	return stderr.trim() || stdout.trim() || "Unknown gh CLI error.";
}

function assertNonEmptyString(value: unknown, field: string, context: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new GitHubPullRequestError(`GitHub API response is missing ${field} while ${context}.`, {
			code: "GITHUB_INVALID_RESPONSE",
		});
	}
	return value;
}

function handleGitHubApiFailure(action: string, result: ExecResult, details?: Record<string, unknown>): never {
	const message = normalizeErrorText(result.stderr, result.stdout);
	if (/auth/i.test(message) || /login/i.test(message) || /401/.test(message)) {
		throw new GitHubPullRequestError("GitHub CLI authentication is required. Run `gh auth login` and retry /review-pr <url>.", {
			code: "GITHUB_AUTH_REQUIRED",
			details,
		});
	}
	if (/404/.test(message) || /not found/i.test(message)) {
		throw new GitHubPullRequestError(`Pull request not found while ${action}. Check the URL and your repository access, then retry.`, {
			code: "PULL_REQUEST_NOT_FOUND",
			details,
		});
	}
	throw new GitHubPullRequestError(`GitHub CLI failed while ${action}: ${message}`, {
		code: "GITHUB_API_FAILED",
		details,
	});
}

function handleReviewSubmitFailure(result: ExecResult, details?: Record<string, unknown>): never {
	const message = normalizeErrorText(result.stderr, result.stdout);
	if (/422/.test(message) && /validation/i.test(message)) {
		throw new GitHubPullRequestError(
			"GitHub rejected one or more inline PR review comments. Retrying without inline comments may preserve the feedback.",
			{
				code: "GITHUB_REVIEW_INLINE_VALIDATION_FAILED",
				details: { ...details, stderr: result.stderr.trim(), stdout: result.stdout.trim() },
			},
		);
	}
	handleGitHubApiFailure("submitting the pull request review", result, details);
}

export function isPullRequestReviewInlineValidationFailure(error: unknown): boolean {
	return error instanceof GitHubPullRequestError && error.code === "GITHUB_REVIEW_INLINE_VALIDATION_FAILED";
}

export function parsePullRequestUrl(input: string): PullRequestReference {
	let parsed: URL;
	try {
		parsed = new URL(input.trim());
	} catch {
		throw new GitHubPullRequestError(
			"Unsupported PR URL: expected a GitHub pull request URL like https://github.com/<owner>/<repo>/pull/<number>.",
			{ code: "INVALID_PULL_REQUEST_URL" },
		);
	}

	if (!GITHUB_HOSTS.has(parsed.hostname.toLowerCase())) {
		throw new GitHubPullRequestError(
			"Unsupported PR URL: expected a GitHub pull request URL like https://github.com/<owner>/<repo>/pull/<number>.",
			{ code: "INVALID_PULL_REQUEST_URL" },
		);
	}

	const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/i);
	if (!match) {
		throw new GitHubPullRequestError(
			"Unsupported PR URL: expected a GitHub pull request URL like https://github.com/<owner>/<repo>/pull/<number>.",
			{ code: "INVALID_PULL_REQUEST_URL" },
		);
	}

	const owner = match[1]!;
	const repo = match[2]!;
	const number = Number.parseInt(match[3]!, 10);
	return { owner, repo, number, url: normalizePullRequestUrl(owner, repo, number) };
}

export async function ensureGitHubAuth(exec: GitHubCliExecutor, cwd?: string): Promise<void> {
	const result = await exec("gh", ["auth", "status"], cwd);
	if (result.code === 0) return;

	const message = normalizeErrorText(result.stderr, result.stdout);
	if (/enoent/i.test(message) || /command not found/i.test(message) || /not recognized/i.test(message)) {
		throw new GitHubPullRequestError("GitHub CLI (`gh`) is required for /review-pr. Install it, run `gh auth login`, and retry.", {
			code: "GITHUB_CLI_MISSING",
			hint: "gh auth login",
			details: { stderr: result.stderr.trim(), stdout: result.stdout.trim() },
		});
	}

	throw new GitHubPullRequestError("GitHub CLI authentication is required. Run `gh auth login` and retry /review-pr <url>.", {
		code: "GITHUB_AUTH_REQUIRED",
		hint: "gh auth login",
		details: { stderr: result.stderr.trim(), stdout: result.stdout.trim() },
	});
}

export async function fetchPullRequestMetadata(
	exec: GitHubCliExecutor,
	pr: PullRequestReference,
	cwd?: string,
): Promise<PullRequestMetadata> {
	const result = await exec("gh", ["api", `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`], cwd);
	if (result.code !== 0) {
		handleGitHubApiFailure(`fetching PR ${pr.owner}/${pr.repo}#${pr.number}`, result, { pr });
	}

	const data = parseJson<PullRequestApiResponse>(result.stdout, `fetching PR ${pr.owner}/${pr.repo}#${pr.number}`);
	return {
		owner: pr.owner,
		repo: pr.repo,
		number: pr.number,
		url: assertNonEmptyString(data.html_url ?? pr.url, "html_url", "normalizing pull request metadata"),
		title: assertNonEmptyString(data.title, "title", "normalizing pull request metadata"),
		state: assertNonEmptyString(data.state, "state", "normalizing pull request metadata"),
		headSha: assertNonEmptyString(data.head?.sha, "head.sha", "normalizing pull request metadata"),
		baseSha: assertNonEmptyString(data.base?.sha, "base.sha", "normalizing pull request metadata"),
		headRefName: assertNonEmptyString(data.head?.ref, "head.ref", "normalizing pull request metadata"),
		baseRefName: assertNonEmptyString(data.base?.ref, "base.ref", "normalizing pull request metadata"),
		headRepoFullName: assertNonEmptyString(data.head?.repo?.full_name, "head.repo.full_name", "normalizing pull request metadata"),
		baseRepoFullName: assertNonEmptyString(data.base?.repo?.full_name, "base.repo.full_name", "normalizing pull request metadata"),
	};
}

export async function fetchPullRequestFiles(
	exec: GitHubCliExecutor,
	pr: PullRequestReference,
	cwd?: string,
): Promise<PullRequestFile[]> {
	const result = await exec("gh", ["api", "--paginate", "--slurp", `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/files`], cwd);
	if (result.code !== 0) {
		handleGitHubApiFailure(`fetching changed files for PR ${pr.owner}/${pr.repo}#${pr.number}`, result, { pr });
	}

	const data = parseJson<unknown>(result.stdout, `fetching changed files for PR ${pr.owner}/${pr.repo}#${pr.number}`);
	if (!Array.isArray(data)) {
		throw new GitHubPullRequestError("GitHub CLI returned an unexpected changed-files payload for the pull request.", {
			code: "GITHUB_INVALID_RESPONSE",
		});
	}

	const pages = data.every(Array.isArray) ? (data as PullRequestFile[][]) : [data as PullRequestFile[]];
	return pages.flat().filter((item): item is PullRequestFile => typeof item?.filename === "string" && item.filename.length > 0);
}

export async function submitPullRequestReview(
	exec: GitHubCliExecutor,
	pr: PullRequestReference,
	input: SubmitPullRequestReviewInput,
	cwd?: string,
): Promise<SubmitPullRequestReviewResult> {
	const payload: Record<string, unknown> = {
		commit_id: assertNonEmptyString(input.commitId, "commitId", "submitting the pull request review"),
		event: "COMMENT",
	};
	if (typeof input.body === "string" && input.body.trim().length > 0) {
		payload.body = input.body;
	}
	if (Array.isArray(input.comments)) {
		payload.comments = input.comments;
	}

	const tempFile = createReviewPayloadTempFile(payload);
	try {
		const result = await exec(
			"gh",
			["api", "--method", "POST", "--input", tempFile, `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`],
			cwd,
		);
		if (result.code !== 0) {
			handleReviewSubmitFailure(result, { pr, payload });
		}

		if (!result.stdout.trim()) return {};
		const data = parseJson<PullRequestReviewApiResponse>(result.stdout, `submitting PR ${pr.owner}/${pr.repo}#${pr.number} review`);
		return {
			id: typeof data.id === "number" ? data.id : undefined,
			htmlUrl: typeof data.html_url === "string" ? data.html_url : undefined,
		};
	} finally {
		fs.rmSync(tempFile, { force: true });
	}
}

export function filterMarkdownPullRequestFiles<T extends { filename: string }>(files: readonly T[]): T[] {
	return files.filter((file) => MARKDOWN_EXTENSIONS.has(path.extname(file.filename).toLowerCase()));
}

export function validatePullRequestForReview(pr: PullRequestMetadata): void {
	if (pr.state.toLowerCase() !== "open") {
		throw new GitHubPullRequestError(
			`Pull request ${pr.owner}/${pr.repo}#${pr.number} is ${pr.state}, so /review-pr can only review open pull requests.`,
			{ code: "PULL_REQUEST_NOT_OPEN" },
		);
	}

	if (normalizeRepoFullName(pr.headRepoFullName) !== normalizeRepoFullName(pr.baseRepoFullName)) {
		throw new GitHubPullRequestError(
			"Fork pull requests are not supported for /review-pr yet. Open the PR from its base repository checkout and try again once fork support lands.",
			{ code: "FORK_PULL_REQUEST_UNSUPPORTED" },
		);
	}
}

export async function getLocalOriginRepoFullName(exec: GitHubCliExecutor, cwd: string): Promise<string> {
	const result = await exec("git", ["remote", "get-url", "origin"], cwd);
	if (result.code !== 0) {
		throw new GitHubPullRequestError(
			"Could not read git remote 'origin' for this checkout. Ensure you are inside the PR base repository and retry /review-pr.",
			{
				code: "LOCAL_REPO_ORIGIN_UNAVAILABLE",
				details: { stderr: result.stderr.trim(), stdout: result.stdout.trim(), cwd },
			},
		);
	}

	const fullName = extractGitHubRepoFullName(result.stdout);
	if (!fullName) {
		throw new GitHubPullRequestError(
			"This checkout does not have a GitHub 'origin' remote, so /review-pr cannot verify the PR base repository match.",
			{ code: "LOCAL_REPO_NOT_GITHUB", details: { origin: result.stdout.trim(), cwd } },
		);
	}

	return fullName;
}

export async function ensureLocalRepoMatchesPullRequestBase(
	exec: GitHubCliExecutor,
	cwd: string,
	pr: Pick<PullRequestMetadata, "baseRepoFullName">,
): Promise<void> {
	const localRepoFullName = await getLocalOriginRepoFullName(exec, cwd);
	if (normalizeRepoFullName(localRepoFullName) === normalizeRepoFullName(pr.baseRepoFullName)) return;
	throw new GitHubPullRequestError(
		`This checkout points at GitHub repo ${localRepoFullName}, but the PR targets ${pr.baseRepoFullName}. Open the matching base repository checkout and retry /review-pr.`,
		{
			code: "LOCAL_REPO_MISMATCH",
			details: { localRepoFullName, baseRepoFullName: pr.baseRepoFullName, cwd },
		},
	);
}
