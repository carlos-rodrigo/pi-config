import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import {
	GitHubPullRequestError,
	ensureGitHubAuth,
	ensureLocalRepoMatchesPullRequestBase,
	fetchPullRequestFiles,
	fetchPullRequestMetadata,
	filterMarkdownPullRequestFiles,
	getLocalOriginRepoFullName,
	isPullRequestReviewInlineValidationFailure,
	parsePullRequestUrl,
	submitPullRequestReview,
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

const sampleReference = {
	owner: "acme",
	repo: "widgets",
	number: 42,
	url: "https://github.com/acme/widgets/pull/42",
} as const;

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

test("ensureGitHubAuth reports missing gh installation separately", async () => {
	const exec = createExec(() => ({ code: 1, stdout: "", stderr: "spawn gh ENOENT" }));

	await assert.rejects(
		() => ensureGitHubAuth(exec),
		(error) =>
			expectGitHubErrorMessage(
				error,
				"GitHub CLI (`gh`) is required for /review-pr. Install it, run `gh auth login`, and retry.",
			),
	);
});

test("fetchPullRequestMetadata normalizes the GitHub API response", async () => {
	const exec = createExec(() => ({
		code: 0,
		stdout: JSON.stringify({
			title: "Improve docs",
			state: "open",
			html_url: "https://github.com/acme/widgets/pull/42",
			head: { sha: "abc123", ref: "feature/docs", repo: { full_name: "Acme/Widgets" } },
			base: { sha: "def456", ref: "main", repo: { full_name: "acme/widgets" } },
		}),
		stderr: "",
	}));

	assert.deepEqual(await fetchPullRequestMetadata(exec, sampleReference), {
		...sampleReference,
		title: "Improve docs",
		state: "open",
		headSha: "abc123",
		baseSha: "def456",
		headRefName: "feature/docs",
		baseRefName: "main",
		headRepoFullName: "Acme/Widgets",
		baseRepoFullName: "acme/widgets",
	});
});

test("fetchPullRequestMetadata rejects malformed payloads", async () => {
	const exec = createExec(() => ({
		code: 0,
		stdout: JSON.stringify({ title: "Missing repos", state: "open", head: { sha: "abc123", ref: "feature/docs" } }),
		stderr: "",
	}));

	await assert.rejects(
		() => fetchPullRequestMetadata(exec, sampleReference),
		(error) =>
			expectGitHubErrorMessage(
				error,
				"GitHub API response is missing base.sha while normalizing pull request metadata.",
			),
	);
});

test("fetchPullRequestMetadata maps not-found failures to a user-facing error", async () => {
	const exec = createExec(() => ({ code: 1, stdout: "", stderr: "gh: HTTP 404 Not Found" }));

	await assert.rejects(
		() => fetchPullRequestMetadata(exec, sampleReference),
		(error) =>
			expectGitHubErrorMessage(
				error,
				"Pull request not found while fetching PR acme/widgets#42. Check the URL and your repository access, then retry.",
			),
	);
});

test("validatePullRequestForReview rejects closed pull requests", () => {
	assert.throws(
		() => validatePullRequestForReview(samplePullRequest({ state: "closed" })),
		(error) =>
			expectGitHubErrorMessage(
				error,
				"Pull request acme/widgets#42 is closed, so /review-pr can only review open pull requests.",
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

test("validatePullRequestForReview accepts same-repo pull requests even with mixed case", () => {
	assert.doesNotThrow(() =>
		validatePullRequestForReview(
			samplePullRequest({
				headRepoFullName: "Acme/Widgets",
				baseRepoFullName: "acme/widgets",
			}),
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

test("ensureLocalRepoMatchesPullRequestBase accepts mixed-case HTTPS GitHub remotes", async () => {
	const exec = createExec(() => ({ code: 0, stdout: "https://github.com/Acme/Widgets.git\n", stderr: "" }));

	await assert.doesNotReject(() =>
		ensureLocalRepoMatchesPullRequestBase(exec, "/repo", samplePullRequest({ baseRepoFullName: "acme/widgets" })),
	);
});

test("getLocalOriginRepoFullName supports ssh protocol GitHub remotes", async () => {
	const exec = createExec(() => ({ code: 0, stdout: "ssh://git@github.com/acme/widgets.git\n", stderr: "" }));

	assert.equal(await getLocalOriginRepoFullName(exec, "/repo"), "acme/widgets");
});

test("getLocalOriginRepoFullName rejects non-GitHub origins", async () => {
	const exec = createExec(() => ({ code: 0, stdout: "git@gitlab.com:acme/widgets.git\n", stderr: "" }));

	await assert.rejects(
		() => getLocalOriginRepoFullName(exec, "/repo"),
		(error) =>
			expectGitHubErrorMessage(
				error,
				"This checkout does not have a GitHub 'origin' remote, so /review-pr cannot verify the PR base repository match.",
			),
	);
});

test("getLocalOriginRepoFullName reports missing origin remotes", async () => {
	const exec = createExec(() => ({ code: 2, stdout: "", stderr: "error: No such remote 'origin'" }));

	await assert.rejects(
		() => getLocalOriginRepoFullName(exec, "/repo"),
		(error) =>
			expectGitHubErrorMessage(
				error,
				"Could not read git remote 'origin' for this checkout. Ensure you are inside the PR base repository and retry /review-pr.",
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

	const files = await fetchPullRequestFiles(exec, sampleReference);

	assert.equal(seenArgs[0], "api");
	assert.ok(seenArgs.includes("--paginate"));
	assert.ok(seenArgs.includes("--slurp"));
	assert.equal(files.length, 2);
	assert.equal(files[0]?.filename, "README.md");
	assert.equal(files[1]?.filename, "docs/guide.md");
});

test("fetchPullRequestFiles rejects unexpected payload shapes", async () => {
	const exec = createExec(() => ({ code: 0, stdout: JSON.stringify({ filename: "README.md" }), stderr: "" }));

	await assert.rejects(
		() => fetchPullRequestFiles(exec, sampleReference),
		(error) =>
			expectGitHubErrorMessage(
				error,
				"GitHub CLI returned an unexpected changed-files payload for the pull request.",
			),
	);
});

test("fetchPullRequestFiles maps auth failures to login guidance", async () => {
	const exec = createExec(() => ({ code: 1, stdout: "", stderr: "gh: HTTP 401 auth required" }));

	await assert.rejects(
		() => fetchPullRequestFiles(exec, sampleReference),
		(error) =>
			expectGitHubErrorMessage(
				error,
				"GitHub CLI authentication is required. Run `gh auth login` and retry /review-pr <url>.",
			),
	);
});

test("submitPullRequestReview posts one grouped GitHub review payload", async () => {
	let seenArgs: string[] = [];
	let seenPayload: unknown;
	const exec = createExec((_command, args) => {
		seenArgs = args;
		const inputPath = args[args.indexOf("--input") + 1];
		seenPayload = JSON.parse(fs.readFileSync(inputPath!, "utf-8"));
		return {
			code: 0,
			stdout: JSON.stringify({ id: 99, html_url: "https://github.com/acme/widgets/pull/42#pullrequestreview-99" }),
			stderr: "",
		};
	});

	assert.deepEqual(
		await submitPullRequestReview(
			exec,
			sampleReference,
			{
				commitId: "abc123",
				body: "### Fallback comments\n\n- Example",
				comments: [{ path: "docs/README.md", body: "Looks good", line: 12, side: "RIGHT" }],
			},
			"/repo",
		),
		{ id: 99, htmlUrl: "https://github.com/acme/widgets/pull/42#pullrequestreview-99" },
	);
	assert.equal(seenArgs[0], "api");
	assert.ok(seenArgs.includes("--method"));
	assert.ok(seenArgs.includes("POST"));
	assert.ok(seenArgs.includes("--input"));
	assert.ok(seenArgs.includes("/repos/acme/widgets/pulls/42/reviews"));
	assert.deepEqual(seenPayload, {
		commit_id: "abc123",
		event: "COMMENT",
		body: "### Fallback comments\n\n- Example",
		comments: [{ path: "docs/README.md", body: "Looks good", line: 12, side: "RIGHT" }],
	});
});

test("submitPullRequestReview marks 422 inline validation failures for fallback retry handling", async () => {
	const exec = createExec(() => ({
		code: 1,
		stdout: "",
		stderr: "gh: HTTP 422 Validation Failed ({\"message\":\"Validation Failed\",\"errors\":[{\"field\":\"comments.line\"}]})",
	}));

	await assert.rejects(
		() =>
			submitPullRequestReview(exec, sampleReference, {
				commitId: "abc123",
				comments: [{ path: "docs/README.md", body: "Looks good", line: 12, side: "RIGHT" }],
			}),
		(error) =>
			error instanceof GitHubPullRequestError &&
			error.message ===
				"GitHub rejected one or more inline PR review comments. Retrying without inline comments may preserve the feedback." &&
			isPullRequestReviewInlineValidationFailure(error),
	);
});
