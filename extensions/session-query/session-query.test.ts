import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "@mariozechner/pi-coding-agent";

import sessionQueryExtension from "./index.ts";

function createHarness() {
	const tools = new Map<string, any>();

	sessionQueryExtension({
		registerTool(definition: any) {
			tools.set(definition.name, definition);
		},
	} as any);

	return { tools };
}

function makeMessages() {
	return {
		user(text: string) {
			return {
				role: "user" as const,
				content: text,
				timestamp: Date.now(),
			};
		},
		assistant(text: string) {
			return {
				role: "assistant" as const,
				content: [{ type: "text" as const, text }],
				api: "anthropic-messages" as const,
				provider: "anthropic",
				model: "test-model",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop" as const,
				timestamp: Date.now(),
			};
		},
	};
}

test("session_query rejects non-jsonl paths", async () => {
	const { tools } = createHarness();

	const result = await tools.get("session_query").execute(
		"tool-call-1",
		{ sessionPath: "/tmp/not-a-session.txt", question: "What happened?" },
		undefined,
		undefined,
		{} as any,
	);

	assert.match(result.content[0].text, /Expected a \.jsonl file/i);
	assert.equal(result.details.error, true);
});

test("session_query returns empty-session message without needing a model", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-session-query-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	const sessionFile = join(dir, "empty-session.jsonl");
	writeFileSync(
		sessionFile,
		JSON.stringify({
			type: "session",
			version: 3,
			id: "session-1",
			timestamp: new Date().toISOString(),
			cwd: dir,
		}) + "\n",
		"utf8",
	);

	const { tools } = createHarness();
	const result = await tools.get("session_query").execute(
		"tool-call-1",
		{ sessionPath: sessionFile, question: "What happened?" },
		undefined,
		undefined,
		{} as any,
	);

	assert.equal(result.content[0].text, "Session is empty - no messages found.");
	assert.equal(result.details.empty, true);
});

test("session_query reports when no model is available for a non-empty session", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-session-query-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	const messages = makeMessages();
	const sessionManager = SessionManager.create(dir);
	sessionManager.appendMessage(messages.user("Refactor the auth flow"));
	sessionManager.appendMessage(messages.assistant("We moved token parsing into src/auth.ts."));
	const sessionFile = sessionManager.getSessionFile();

	const { tools } = createHarness();
	const result = await tools.get("session_query").execute(
		"tool-call-1",
		{ sessionPath: sessionFile, question: "What changed?" },
		undefined,
		undefined,
		{ model: null } as any,
	);

	assert.match(result.content[0].text, /no model available/i);
	assert.equal(result.details.error, true);
});
