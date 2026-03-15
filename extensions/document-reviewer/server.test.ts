import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	DocumentReviewService,
	type PullRequestReviewContext,
} from "./server.js";

function makeTempMarkdown(content: string) {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "document-review-server-"));
	const filePath = path.join(tempRoot, "README.md");
	fs.writeFileSync(filePath, content, "utf-8");
	return {
		tempRoot,
		filePath,
		cleanup() {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		},
	};
}

async function postJson(url: string, body: Record<string, unknown>) {
	return fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

test("document sessions still expose markdown and finish by writing inline comments", async (t) => {
	const fixture = makeTempMarkdown("# Title\n\nHello world\n");
	const service = new DocumentReviewService();
	await service.start();
	t.after(async () => {
		await service.stop();
		fixture.cleanup();
	});

	const session = await service.createSession(fixture.filePath);
	const finishPromise = service.waitForFinish(session.sessionId);

	const documentResponse = await fetch(session.documentUrl);
	assert.equal(documentResponse.status, 200);
	assert.deepEqual(await documentResponse.json(), {
		mode: "document",
		title: "README.md",
		markdown: "# Title\n\nHello world\n",
		filePath: fixture.filePath,
		pullRequest: null,
	});

	const createCommentResponse = await postJson(`${new URL(session.documentUrl).origin}/api/${session.sessionId}/comments`, {
		selectedText: "Hello",
		comment: "Clarify greeting",
		offsetStart: 9,
		offsetEnd: 14,
	});
	assert.equal(createCommentResponse.status, 201);

	const finishResponse = await fetch(`${new URL(session.documentUrl).origin}/api/${session.sessionId}/finish`, { method: "POST" });
	assert.equal(finishResponse.status, 200);
	assert.deepEqual(await finishResponse.json(), {
		status: "finished",
		mode: "document",
		commentsWritten: 1,
		filePath: fixture.filePath,
	});

	const finishedComments = await finishPromise;
	assert.equal(finishedComments.length, 1);
	assert.match(fs.readFileSync(fixture.filePath, "utf-8"), /Hello <!-- REVIEW: Clarify greeting --> world/);
});

test("rejects invalid comment metadata without storing the draft", async (t) => {
	const fixture = makeTempMarkdown("# Title\n\nHello world\n");
	const service = new DocumentReviewService();
	await service.start();
	t.after(async () => {
		await service.stop();
		fixture.cleanup();
	});

	const session = await service.createSession(fixture.filePath);
	const apiBase = `${new URL(session.documentUrl).origin}/api/${session.sessionId}`;

	const createCommentResponse = await postJson(`${apiBase}/comments`, {
		selectedText: "Hello",
		comment: "Clarify greeting",
		offsetStart: -1,
		offsetEnd: 99,
	});
	assert.equal(createCommentResponse.status, 400);
	assert.deepEqual(await createCommentResponse.json(), {
		error: "Comment offsets must be finite integers within the source markdown bounds.",
	});

	const commentsResponse = await fetch(`${apiBase}/comments`);
	assert.equal(commentsResponse.status, 200);
	assert.deepEqual(await commentsResponse.json(), { comments: [] });
});

test("rejects cross-origin requests outside the local review origin", async (t) => {
	const fixture = makeTempMarkdown("# Title\n\nHello world\n");
	const service = new DocumentReviewService();
	await service.start();
	t.after(async () => {
		await service.stop();
		fixture.cleanup();
	});

	const session = await service.createSession(fixture.filePath);
	const response = await fetch(session.documentUrl, {
		headers: { Origin: "https://evil.example" },
	});

	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), { error: "Origin not allowed" });
});

test("pull request sessions expose PR metadata, store line hints, and finish via PR hook", async (t) => {
	const fixture = makeTempMarkdown("# Title\n\nHello world\n");
	const service = new DocumentReviewService();
	await service.start();
	t.after(async () => {
		await service.stop();
		fixture.cleanup();
	});

	const pullRequest: PullRequestReviewContext = {
		owner: "acme",
		repo: "widgets",
		number: 42,
		headSha: "abc123",
		baseSha: "def456",
		filePath: "docs/README.md",
		worktreePath: "/tmp/pr-42",
	};

	const published: Array<{ commentsCount: number; pullRequest: PullRequestReviewContext }> = [];
	const session = await service.createPullRequestSession({
		filePath: fixture.filePath,
		pullRequest,
		onPublishReview: async ({ comments, pullRequest: pr }) => {
			published.push({ commentsCount: comments.length, pullRequest: pr });
			return {
				status: "submitted",
				inlineComments: 1,
				fallbackComments: 0,
			};
		},
	});
	const finishPromise = service.waitForFinish(session.sessionId);
	const apiBase = `${new URL(session.documentUrl).origin}/api/${session.sessionId}`;

	const documentResponse = await fetch(session.documentUrl);
	assert.equal(documentResponse.status, 200);
	assert.deepEqual(await documentResponse.json(), {
		mode: "pull_request",
		title: "README.md",
		markdown: "# Title\n\nHello world\n",
		filePath: fixture.filePath,
		pullRequest,
	});

	const createCommentResponse = await postJson(`${apiBase}/comments`, {
		selectedText: "Hello",
		comment: "Looks good",
		offsetStart: 9,
		offsetEnd: 14,
		lineStart: 3,
		lineEnd: 3,
		inlineEligible: true,
	});
	assert.equal(createCommentResponse.status, 201);
	const createdCommentPayload = (await createCommentResponse.json()) as { comment: Record<string, unknown> };
	assert.equal(typeof createdCommentPayload.comment.id, "string");
	assert.equal(createdCommentPayload.comment.selectedText, "Hello");
	assert.equal(createdCommentPayload.comment.comment, "Looks good");
	assert.equal(createdCommentPayload.comment.offsetStart, 9);
	assert.equal(createdCommentPayload.comment.offsetEnd, 14);
	assert.equal(createdCommentPayload.comment.lineStart, 3);
	assert.equal(createdCommentPayload.comment.lineEnd, 3);
	assert.equal(createdCommentPayload.comment.inlineEligible, true);

	const commentsResponse = await fetch(`${apiBase}/comments`);
	assert.equal(commentsResponse.status, 200);
	const commentsPayload = (await commentsResponse.json()) as { comments: Array<Record<string, unknown>> };
	assert.equal(commentsPayload.comments.length, 1);
	assert.equal(commentsPayload.comments[0]?.lineStart, 3);
	assert.equal(commentsPayload.comments[0]?.lineEnd, 3);
	assert.equal(commentsPayload.comments[0]?.inlineEligible, true);

	const finishResponse = await fetch(`${apiBase}/finish`, { method: "POST" });
	assert.equal(finishResponse.status, 200);
	assert.deepEqual(await finishResponse.json(), {
		status: "finished",
		mode: "pull_request",
		commentsSubmitted: 1,
		inlineComments: 1,
		fallbackComments: 0,
		filePath: fixture.filePath,
		pullRequest,
	});

	assert.deepEqual(published, [{ commentsCount: 1, pullRequest }]);
	assert.equal(fs.readFileSync(fixture.filePath, "utf-8"), "# Title\n\nHello world\n");
	assert.equal((await finishPromise).length, 1);
});
