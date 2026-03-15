import test from "node:test";
import assert from "node:assert/strict";
import {
	GitHubPullRequestError,
	ensureGitHubAuth,
	ensureLocalRepoMatchesPullRequestBase,
	fetchPullRequestFiles,
	filterMarkdownPullRequestFiles,
	parsePullRequestUrl,
	validatePullRequestForReview,
	type ExecResult,
	type GitHubCliExecutor,
	type PullRequestMetadata,
} from "./github-pr.js";

function createExec(handler: (command: string, args: string[], cwd?: string) => ExecResult | Promise<ExecResult>): GitHubCliExecutor {
	return async (command, args, cwd) => handler(command, args, cwd);
}

function expectGitHubErrorMessage(error: unknown, message: string): boolean {
	if (!(error instanceof GitHubPullRequestError)) return false;
	return error.message === message;
}

function samplePullRequest(overrides: Partial<PullRequestMetadata> = {}): PullRequestMetadata {
	return {
		owner: "acme",
		repo: "widgets",
		number: 42,
		url: "https://github.com/acme/widgets/pull/42",
		title: "Improve docs",
		state: "open",
		headSha: "abc123",
		baseSha: "def456",
		headRefName: "feature/docs",
		baseRefName: "main",
		headRepoFullName: "acme/widgets",
		baseRepoFullName: "acme/widgets",
		...overrides,
	};
}

test("parsePullRequestUrl extracts owner, repo, and number from GitHub PR URLs", () => {
	assert.deepEqual(parsePullRequestUrl("https://github.com/acme/widgets/pull/123?diff=split"), {
		owner: "acme",
		repo: "widgets",
		number: 123,
		url: "https://github.com/acme/widgets/pull/123",
	});
});

test("parsePullRequestUrl rejects unsupported URLs with actionable guidance", () => {
	assert.throws(
		() => parsePullRequestUrl("https://example.com/acme/widgets/pull/123"),
		(error) =>
			expectGitHubErrorMessage(
				error,
				"Unsupported PR URL: expected a GitHub pull request URL like https://github.com/<owner>/<repo>/pull/<number>.",
			),
	);
});

test("ensureGitHubAuth returns gh auth login guidance on auth failure", async () => {
	const exec = createExec(() => ({ code: 1, stdout: "", stderr: "not logged in" }));

	await assert.rejects(
		() => ensureGitHubAuth(exec),
		(error) =>
			expectGitHubErrorMessage(
				error,
				"GitHub CLI authentication is required. Run `gh auth login` and retry /review-pr <url>.",
			),
	);
});

test("validatePullRequestForReview rejects fork pull requests in v1", () => {
	assert.throws(
		() =>
			validatePullRequestForReview(
				samplePullRequest({
					headRepoFullName: "contrib/widgets",
					baseRepoFullName: "acme/widgets",
				}),
			),
		(error) =>
			expectGitHubErrorMessage(
				error,
				"Fork pull requests are not supported for /review-pr yet. Open the PR from its base repository checkout and try again once fork support lands.",
			),
	);
});

test("ensureLocalRepoMatchesPullRequestBase reports origin mismatch", async () => {
	const exec = createExec(() => ({ code: 0, stdout: "git@github.com:other/repo.git\n", stderr: "" }));

	await assert.rejects(
		() => ensureLocalRepoMatchesPullRequestBase(exec, "/repo", samplePullRequest({ baseRepoFullName: "acme/widgets" })),
		(error) =>
			expectGitHubErrorMessage(
				error,
				"This checkout points at GitHub repo other/repo, but the PR targets acme/widgets. Open the matching base repository checkout and retry /review-pr.",
			),
	);
});

test("filterMarkdownPullRequestFiles keeps supported markdown extensions only", () => {
	const files = [
		{ filename: "README.md" },
		{ filename: "docs/guide.MDX" },
		{ filename: "src/index.ts" },
		{ filename: "notes.txt" },
	];

	assert.deepEqual(filterMarkdownPullRequestFiles(files), [
		{ filename: "README.md" },
		{ filename: "docs/guide.MDX" },
	]);
});

test("fetchPullRequestFiles paginates gh api responses and flattens pages", async () => {
	let seenArgs: string[] = [];
	const exec = createExec((_command, args) => {
		seenArgs = args;
		return {
			code: 0,
			stdout: JSON.stringify([
				[
					{ filename: "README.md", status: "modified", patch: "@@ -1 +1 @@" },
					{ filename: "docs/guide.md", status: "added", patch: "@@ -0,0 +1 @@" },
				],
			]),
			stderr: "",
		};
	});

	const files = await fetchPullRequestFiles(exec, {
		owner: "acme",
		repo: "widgets",
		number: 42,
		url: "https://github.com/acme/widgets/pull/42",
	});

	assert.equal(seenArgs[0], "api");
	assert.ok(seenArgs.includes("--paginate"));
	assert.ok(seenArgs.includes("--slurp"));
	assert.equal(files.length, 2);
	assert.equal(files[0]?.filename, "README.md");
	assert.equal(files[1]?.filename, "docs/guide.md");
});
