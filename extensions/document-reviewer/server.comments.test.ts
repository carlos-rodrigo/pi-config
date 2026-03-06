import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DocumentReviewService } from "./server.ts";

async function createHarness() {
	const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "document-reviewer-"));
	const docPath = path.join(rootDir, "sample.md");
	await fs.writeFile(docPath, "# Sample\n\nHello threaded comments\n", "utf8");

	const service = new DocumentReviewService({ rootDir });
	await service.ensureStarted();

	const cleanup = async () => {
		await service.stop();
		await fs.rm(rootDir, { recursive: true, force: true });
	};

	return { service, rootDir, docPath, cleanup };
}

function sessionApiBase(documentUrl: string, sessionId: string): string {
	const url = new URL(documentUrl);
	return `${url.origin}/api/review/session/${encodeURIComponent(sessionId)}`;
}

function sessionJsonHeaders(contentType = "application/json") {
	return {
		"content-type": contentType,
	};
}

async function sessionFetch(
	session: { documentUrl: string; sessionId: string; apiToken: string },
	routeSuffix: string,
	init: RequestInit = {},
): Promise<Response> {
	const apiBase = sessionApiBase(session.documentUrl, session.sessionId);
	const normalizedSuffix = String(routeSuffix).replace(/^\/+/, "");
	const url = `${apiBase}/${normalizedSuffix}`;
	const extraHeaders = (init.headers ?? {}) as Record<string, string>;
	return fetch(url, {
		...init,
		headers: {
			accept: "application/json",
			"x-review-session-token": session.apiToken,
			...extraHeaders,
		},
		cache: "no-store",
	});
}

async function listThreads(session: { documentUrl: string; sessionId: string; apiToken: string }) {
	const response = await sessionFetch(session, "comments");
	assert.equal(response.status, 200);
	const payload = (await response.json()) as {
		threads: Array<Record<string, unknown>>;
	};
	return payload.threads;
}

async function findSingleSidecarPath(rootDir: string): Promise<string> {
	const sidecarDir = path.join(rootDir, ".review");
	const files = await fs.readdir(sidecarDir);
	assert.equal(files.length, 1);
	return path.join(sidecarDir, files[0]);
}

test("rejects requests without a valid session token", async (t) => {
	const harness = await createHarness();
	t.after(harness.cleanup);

	const session = await harness.service.createSession(harness.docPath);
	const apiBase = sessionApiBase(session.documentUrl, session.sessionId);

	const missingTokenResponse = await fetch(`${apiBase}/comments`, {
		headers: { accept: "application/json" },
		cache: "no-store",
	});
	assert.equal(missingTokenResponse.status, 401);

	const invalidTokenResponse = await fetch(`${apiBase}/comments`, {
		headers: {
			accept: "application/json",
			"x-review-session-token": "invalid-token",
		},
		cache: "no-store",
	});
	assert.equal(invalidTokenResponse.status, 401);

	const validTokenResponse = await sessionFetch(session, "comments");
	assert.equal(validTokenResponse.status, 200);
});

test("rejects tokens issued for a different review session", async (t) => {
	const harness = await createHarness();
	t.after(harness.cleanup);

	const firstSession = await harness.service.createSession(harness.docPath);
	const secondSession = await harness.service.createSession(harness.docPath);
	const secondApiBase = sessionApiBase(secondSession.documentUrl, secondSession.sessionId);

	const response = await fetch(`${secondApiBase}/comments`, {
		headers: {
			accept: "application/json",
			"x-review-session-token": firstSession.apiToken,
		},
		cache: "no-store",
	});

	assert.equal(response.status, 401);
});

test("creates threads and appends replies in order", async (t) => {
	const harness = await createHarness();
	t.after(harness.cleanup);

	const session = await harness.service.createSession(harness.docPath);
	const createResponse = await sessionFetch(session, "comments", {
		method: "POST",
		headers: sessionJsonHeaders(),
		body: JSON.stringify({
			anchor: {
				quote: "Hello threaded comments",
				startOffset: 8,
				endOffset: 31,
			},
			body: "C1",
		}),
	});

	assert.equal(createResponse.status, 201);
	const createdPayload = (await createResponse.json()) as {
		thread: { threadId: string; comments: Array<{ body: string }> };
	};
	assert.equal(createdPayload.thread.comments.length, 1);
	assert.equal(createdPayload.thread.comments[0].body, "C1");

	const replyResponse = await sessionFetch(session, `comments/${encodeURIComponent(createdPayload.thread.threadId)}/replies`, {
		method: "POST",
		headers: sessionJsonHeaders(),
		body: JSON.stringify({ body: "C1.1" }),
	});
	assert.equal(replyResponse.status, 201);

	const listResponse = await sessionFetch(session, "comments");
	assert.equal(listResponse.status, 200);
	const listPayload = (await listResponse.json()) as {
		threads: Array<{ comments: Array<{ body: string }> }>;
	};
	assert.equal(listPayload.threads.length, 1);
	assert.deepEqual(
		listPayload.threads[0].comments.map((comment) => comment.body),
		["C1", "C1.1"],
	);
});

test("rejects empty comments with clear validation", async (t) => {
	const harness = await createHarness();
	t.after(harness.cleanup);

	const session = await harness.service.createSession(harness.docPath);
	const response = await sessionFetch(session, "comments", {
		method: "POST",
		headers: sessionJsonHeaders(),
		body: JSON.stringify({
			anchor: {
				quote: "Hello",
				startOffset: 0,
				endOffset: 5,
			},
			body: "   ",
		}),
	});

	assert.equal(response.status, 400);
	const payload = (await response.json()) as { error: string };
	assert.match(payload.error, /cannot be empty/i);
});

test("rejects classification fields in comment payload", async (t) => {
	const harness = await createHarness();
	t.after(harness.cleanup);

	const session = await harness.service.createSession(harness.docPath);
	const response = await sessionFetch(session, "comments", {
		method: "POST",
		headers: sessionJsonHeaders(),
		body: JSON.stringify({
			anchor: {
				quote: "Hello",
				startOffset: 0,
				endOffset: 5,
			},
			body: "C1",
			severity: "high",
		}),
	});

	assert.equal(response.status, 400);
	const payload = (await response.json()) as { error: string };
	assert.match(payload.error, /classification field/i);
});

test("rejects reply validation errors and unknown thread ids", async (t) => {
	const harness = await createHarness();
	t.after(harness.cleanup);

	const session = await harness.service.createSession(harness.docPath);

	const createResponse = await sessionFetch(session, "comments", {
		method: "POST",
		headers: sessionJsonHeaders(),
		body: JSON.stringify({
			anchor: {
				quote: "Hello",
				startOffset: 0,
				endOffset: 5,
			},
			body: "C1",
		}),
	});
	assert.equal(createResponse.status, 201);
	const createdPayload = (await createResponse.json()) as { thread: { threadId: string } };

	const emptyReplyResponse = await sessionFetch(session, `comments/${encodeURIComponent(createdPayload.thread.threadId)}/replies`, {
		method: "POST",
		headers: sessionJsonHeaders(),
		body: JSON.stringify({ body: "   " }),
	});
	assert.equal(emptyReplyResponse.status, 400);
	const emptyReplyPayload = (await emptyReplyResponse.json()) as { error: string };
	assert.match(emptyReplyPayload.error, /cannot be empty/i);

	const classifiedReplyResponse = await sessionFetch(
		session,
		`comments/${encodeURIComponent(createdPayload.thread.threadId)}/replies`,
		{
			method: "POST",
			headers: sessionJsonHeaders(),
			body: JSON.stringify({ body: "C1.1", status: "todo" }),
		},
	);
	assert.equal(classifiedReplyResponse.status, 400);
	const classifiedReplyPayload = (await classifiedReplyResponse.json()) as { error: string };
	assert.match(classifiedReplyPayload.error, /classification field/i);

	const missingThreadResponse = await sessionFetch(session, "comments/missing-thread/replies", {
		method: "POST",
		headers: sessionJsonHeaders(),
		body: JSON.stringify({ body: "C1.1" }),
	});
	assert.equal(missingThreadResponse.status, 404);
	const missingThreadPayload = (await missingThreadResponse.json()) as { error: string };
	assert.match(missingThreadPayload.error, /thread not found/i);
});

test("rejects non-object comment payloads with 400", async (t) => {
	const harness = await createHarness();
	t.after(harness.cleanup);

	const session = await harness.service.createSession(harness.docPath);
	const response = await sessionFetch(session, "comments", {
		method: "POST",
		headers: sessionJsonHeaders(),
		body: "null",
	});

	assert.equal(response.status, 400);
	const payload = (await response.json()) as { error: string };
	assert.match(payload.error, /json object/i);
});

test("rejects anchors that cannot map to the current document", async (t) => {
	const harness = await createHarness();
	t.after(harness.cleanup);

	const session = await harness.service.createSession(harness.docPath);
	const response = await sessionFetch(session, "comments", {
		method: "POST",
		headers: sessionJsonHeaders(),
		body: JSON.stringify({
			anchor: {
				exact: "This text does not exist",
			},
			body: "C1",
		}),
	});

	assert.equal(response.status, 400);
	const payload = (await response.json()) as { error: string };
	assert.match(payload.error, /could not be mapped/i);

	const threads = await listThreads(session);
	assert.equal(threads.length, 0);
});

test("enforces JSON content-type and valid JSON payload shape", async (t) => {
	const harness = await createHarness();
	t.after(harness.cleanup);

	const session = await harness.service.createSession(harness.docPath);

	const wrongType = await sessionFetch(session, "comments", {
		method: "POST",
		headers: sessionJsonHeaders("text/plain"),
		body: JSON.stringify({ body: "C1" }),
	});
	assert.equal(wrongType.status, 415);

	const malformedJson = await sessionFetch(session, "comments", {
		method: "POST",
		headers: sessionJsonHeaders(),
		body: "{not-json",
	});
	assert.equal(malformedJson.status, 400);

	const missingBody = await sessionFetch(session, "comments", {
		method: "POST",
		headers: sessionJsonHeaders(),
	});
	assert.equal(missingBody.status, 400);
});

test("persists threads to sidecar and reloads across new sessions", async (t) => {
	const harness = await createHarness();
	t.after(harness.cleanup);

	const firstSession = await harness.service.createSession(harness.docPath);
	const createResponse = await sessionFetch(firstSession, "comments", {
		method: "POST",
		headers: sessionJsonHeaders(),
		body: JSON.stringify({
			anchor: {
				exact: "Hello threaded comments",
				startOffset: 10,
				endOffset: 33,
			},
			body: "Persist me",
		}),
	});
	assert.equal(createResponse.status, 201);

	const sidecarPath = await findSingleSidecarPath(harness.rootDir);
	const sidecarText = await fs.readFile(sidecarPath, "utf8");
	assert.match(sidecarText, /"threads"\s*:\s*\[/i);
	assert.match(sidecarText, /"Persist me"/);

	const secondSession = await harness.service.createSession(harness.docPath);
	const threads = await listThreads(secondSession);
	assert.equal(threads.length, 1);
	assert.equal(threads[0].stale, false);
	assert.equal((threads[0].comments as Array<{ body: string }>)[0].body, "Persist me");
});

test("marks unmatched anchors as stale after document edits", async (t) => {
	const harness = await createHarness();
	t.after(harness.cleanup);

	const firstSession = await harness.service.createSession(harness.docPath);
	const createResponse = await sessionFetch(firstSession, "comments", {
		method: "POST",
		headers: sessionJsonHeaders(),
		body: JSON.stringify({
			anchor: {
				exact: "Hello threaded comments",
				startOffset: 10,
				endOffset: 33,
			},
			body: "Will become stale",
		}),
	});
	assert.equal(createResponse.status, 201);

	await fs.writeFile(harness.docPath, "# Sample\n\nAnchor content removed\n", "utf8");

	const secondSession = await harness.service.createSession(harness.docPath);
	const threads = await listThreads(secondSession);
	assert.equal(threads.length, 1);
	assert.equal(threads[0].stale, true);
});

test("loads legacy sidecar entries and ignores unknown metadata fields", async (t) => {
	const harness = await createHarness();
	t.after(harness.cleanup);

	const seedSession = await harness.service.createSession(harness.docPath);
	const createResponse = await sessionFetch(seedSession, "comments", {
		method: "POST",
		headers: sessionJsonHeaders(),
		body: JSON.stringify({
			anchor: {
				exact: "Hello threaded comments",
				startOffset: 10,
				endOffset: 33,
			},
			body: "Legacy-safe",
		}),
	});
	assert.equal(createResponse.status, 201);

	const sidecarPath = await findSingleSidecarPath(harness.rootDir);
	const sidecar = JSON.parse(await fs.readFile(sidecarPath, "utf8")) as Record<string, unknown>;
	const threads = Array.isArray(sidecar.threads) ? sidecar.threads : [];
	assert.equal(threads.length, 1);
	const thread = threads[0] as Record<string, unknown>;
	thread.legacyCustomField = { keep: "ignored" };
	(thread.anchor as Record<string, unknown>).quote = (thread.anchor as Record<string, unknown>).exact;
	delete (thread.anchor as Record<string, unknown>).exact;
	(thread.comments as Array<Record<string, unknown>>)[0].legacy = true;
	sidecar.unknownEnvelope = { nested: [1, 2, 3] };

	await fs.writeFile(sidecarPath, `${JSON.stringify(sidecar, null, "\t")}\n`, "utf8");

	const reloadSession = await harness.service.createSession(harness.docPath);
	const loadedThreads = await listThreads(reloadSession);
	assert.equal(loadedThreads.length, 1);
	assert.equal(loadedThreads[0].stale, false);
	assert.equal((loadedThreads[0].anchor as { exact: string }).exact, "Hello threaded comments");
	assert.equal((loadedThreads[0].comments as Array<{ body: string }>)[0].body, "Legacy-safe");
});

test("exports plain-text bullets with context snippets", async (t) => {
	const harness = await createHarness();
	t.after(harness.cleanup);

	const session = await harness.service.createSession(harness.docPath);
	const createResponse = await sessionFetch(session, "comments", {
		method: "POST",
		headers: sessionJsonHeaders(),
		body: JSON.stringify({
			anchor: {
				exact: "Hello threaded comments",
				startOffset: 8,
				endOffset: 31,
			},
			body: "C1",
		}),
	});
	assert.equal(createResponse.status, 201);
	const createdPayload = (await createResponse.json()) as { thread: { threadId: string } };

	const replyResponse = await sessionFetch(session, `comments/${encodeURIComponent(createdPayload.thread.threadId)}/replies`, {
		method: "POST",
		headers: sessionJsonHeaders(),
		body: JSON.stringify({ body: "C1.1" }),
	});
	assert.equal(replyResponse.status, 201);

	const exportResponse = await sessionFetch(session, "export", {
		method: "POST",
		headers: sessionJsonHeaders(),
		body: JSON.stringify({ format: "plain" }),
	});
	assert.equal(exportResponse.status, 200);

	const exportPayload = (await exportResponse.json()) as {
		ok: boolean;
		format: string;
		text: string;
		count: number;
	};
	assert.equal(exportPayload.ok, true);
	assert.equal(exportPayload.format, "plain");
	assert.equal(exportPayload.count, 2);
	assert.match(exportPayload.text, /- \[anchor: Hello threaded comments\] C1/);
	assert.match(exportPayload.text, /- \[anchor: Hello threaded comments\] C1\.1/);
});

test("returns empty export text when there are no comments", async (t) => {
	const harness = await createHarness();
	t.after(harness.cleanup);

	const session = await harness.service.createSession(harness.docPath);
	const exportResponse = await sessionFetch(session, "export", {
		method: "POST",
		headers: sessionJsonHeaders(),
		body: JSON.stringify({ format: "plain" }),
	});
	assert.equal(exportResponse.status, 200);

	const exportPayload = (await exportResponse.json()) as {
		ok: boolean;
		format: string;
		text: string;
		count: number;
	};
	assert.equal(exportPayload.ok, true);
	assert.equal(exportPayload.format, "plain");
	assert.equal(exportPayload.count, 0);
	assert.match(exportPayload.text, /no comments to export/i);
});

test("rejects unsupported export formats", async (t) => {
	const harness = await createHarness();
	t.after(harness.cleanup);

	const session = await harness.service.createSession(harness.docPath);
	const response = await sessionFetch(session, "export", {
		method: "POST",
		headers: sessionJsonHeaders(),
		body: JSON.stringify({ format: "markdown" }),
	});

	assert.equal(response.status, 400);
	const payload = (await response.json()) as { error: string };
	assert.match(payload.error, /plain/i);
});

test("rejects non-object export payloads", async (t) => {
	const harness = await createHarness();
	t.after(harness.cleanup);

	const session = await harness.service.createSession(harness.docPath);
	const response = await sessionFetch(session, "export", {
		method: "POST",
		headers: sessionJsonHeaders(),
		body: "null",
	});

	assert.equal(response.status, 400);
	const payload = (await response.json()) as { error: string };
	assert.match(payload.error, /json object/i);
});
