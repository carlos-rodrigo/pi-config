import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "@mariozechner/pi-coding-agent";

import handoffExtension, { filterHandoffContext, wrapWithParentSessionInfo } from "./index.ts";
import { HANDOFF_SESSION_STARTED_EVENT } from "./events.ts";

type PiEventHandler = (...args: any[]) => unknown;

function createHarness() {
	const eventHandlers = new Map<string, PiEventHandler[]>();
	const commands = new Map<string, { description: string; handler: (...args: any[]) => unknown }>();
	const tools = new Map<string, any>();
	const emittedEvents: Array<{ name: string; data: unknown }> = [];
	const eventBusHandlers = new Map<string, ((data: unknown) => void)[]>();

	const pi = {
		on(name: string, handler: PiEventHandler) {
			const handlers = eventHandlers.get(name) ?? [];
			handlers.push(handler);
			eventHandlers.set(name, handlers);
		},
		registerCommand(name: string, definition: { description: string; handler: (...args: any[]) => unknown }) {
			commands.set(name, definition);
		},
		registerTool(definition: any) {
			tools.set(definition.name, definition);
		},
		events: {
			emit(name: string, data: unknown) {
				emittedEvents.push({ name, data });
				for (const handler of eventBusHandlers.get(name) ?? []) {
					handler(data);
				}
			},
			on(name: string, handler: (data: unknown) => void) {
				const handlers = eventBusHandlers.get(name) ?? [];
				handlers.push(handler);
				eventBusHandlers.set(name, handlers);
				return () => {};
			},
		},
	};

	handoffExtension(pi as any);

	return { eventHandlers, commands, tools, emittedEvents };
}

function createMockUI(overrides: Record<string, any> = {}) {
	return {
		custom: async () => null,
		editor: async (_title: string, text: string) => text,
		setEditorText() {},
		notify() {},
		...overrides,
	};
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

function makeTempDir() {
	return mkdtempSync(join(tmpdir(), "pi-handoff-test-"));
}

test("wrapWithParentSessionInfo includes parent and ancestor session references", (t) => {
	const dir = makeTempDir();
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	const messages = makeMessages();

	const grandparentSession = SessionManager.create(dir);
	grandparentSession.appendMessage(messages.user("grandparent user"));
	grandparentSession.appendMessage(messages.assistant("grandparent assistant"));
	const grandparentFile = grandparentSession.getSessionFile();

	const parentSession = SessionManager.create(dir);
	parentSession.newSession({ parentSession: grandparentFile });
	parentSession.appendMessage(messages.user("parent user"));
	parentSession.appendMessage(messages.assistant("parent assistant"));
	const parentFile = parentSession.getSessionFile();

	const wrappedPrompt = wrapWithParentSessionInfo("## Objective\nContinue work", parentFile ?? null);

	assert.match(wrappedPrompt, /session_query/);
	assert.match(wrappedPrompt, /Parent session/);
	assert.ok(wrappedPrompt.includes(parentFile!));
	assert.match(wrappedPrompt, /Ancestor sessions/);
	assert.ok(wrappedPrompt.includes(grandparentFile!));
});

test("filterHandoffContext keeps only post-handoff messages", () => {
	const oldMessage = { role: "user", content: "old", timestamp: 10 };
	const newMessage = { role: "user", content: "new", timestamp: 20 };

	assert.deepEqual(filterHandoffContext([oldMessage, newMessage], 15), [newMessage]);
	assert.equal(filterHandoffContext([oldMessage], null), null);
	assert.equal(filterHandoffContext([oldMessage], 15), null);
});

test("/handoff creates a new session, preserves parent linkage, and seeds the editor", async (t) => {
	const dir = makeTempDir();
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	const { commands, emittedEvents } = createHarness();
	const sessionManager = SessionManager.create(dir);
	const messages = makeMessages();
	sessionManager.appendMessage(messages.user("Plan the auth refactor"));
	sessionManager.appendMessage(messages.assistant("Split it into two phases."));

	const originalSessionFile = sessionManager.getSessionFile();
	const editorTexts: string[] = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const newSessionCalls: Array<{ parentSession?: string }> = [];
	let oldContextStale = false;

	const ui = createMockUI({
		custom: async () => ({ type: "prompt", text: "## Objective\nImplement phase two" }),
		editor: async (_title: string, text: string) => text,
		setEditorText(text: string) {
			editorTexts.push(text);
		},
		notify(message: string, type?: string) {
			notifications.push({ message, type });
		},
	});

	const replacementCtx = {
		hasUI: true,
		model: { provider: "anthropic", id: "test-model" },
		modelRegistry: { getApiKeyForProvider: async () => "test-key" },
		sessionManager,
		ui,
	};

	const ctx = {
		get hasUI() {
			if (oldContextStale) throw new Error("old context used after newSession");
			return true;
		},
		get model() {
			if (oldContextStale) throw new Error("old context used after newSession");
			return { provider: "anthropic", id: "test-model" };
		},
		get modelRegistry() {
			if (oldContextStale) throw new Error("old context used after newSession");
			return { getApiKeyForProvider: async () => "test-key" };
		},
		get sessionManager() {
			if (oldContextStale) throw new Error("old context used after newSession");
			return sessionManager;
		},
		get ui() {
			if (oldContextStale) throw new Error("old context used after newSession");
			return ui;
		},
		async newSession(options?: { parentSession?: string; withSession?: (ctx: any) => Promise<void> }) {
			newSessionCalls.push({ parentSession: options?.parentSession });
			sessionManager.newSession({ parentSession: options?.parentSession });
			oldContextStale = true;
			await options?.withSession?.(replacementCtx);
			return { cancelled: false };
		},
	};

	await commands.get("handoff")!.handler("implement phase two", ctx as any);

	assert.deepEqual(newSessionCalls, [{ parentSession: originalSessionFile }]);
	assert.equal(editorTexts.length, 1);
	assert.match(editorTexts[0], /session_query/);
	assert.ok(editorTexts[0].includes(originalSessionFile!));
	assert.match(editorTexts[0], /## Objective\nImplement phase two/);
	assert.deepEqual(notifications, [{ message: "Handoff ready — submit to start the new session.", type: "info" }]);

	const handoffEvent = emittedEvents.find((event) => event.name === HANDOFF_SESSION_STARTED_EVENT);
	assert.ok(handoffEvent);
	assert.equal((handoffEvent!.data as any).mode, "command");
	assert.equal((handoffEvent!.data as any).parentSessionFile, originalSessionFile);
});

test("handoff tool auto-switches to a fresh session on agent_end and seeds the editor", async (t) => {
	const dir = makeTempDir();
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	const { eventHandlers, tools, emittedEvents } = createHarness();
	const sessionManager = SessionManager.create(dir);
	const messages = makeMessages();
	sessionManager.appendMessage(messages.user("Finish the migration"));
	sessionManager.appendMessage(messages.assistant("Done. We should hand off testing."));

	const originalSessionFile = sessionManager.getSessionFile();
	const editorTexts: string[] = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const progressUpdates: string[] = [];

	const ui = createMockUI({
		custom: async () => ({ type: "prompt", text: "## Next Step\nRun the verification pass" }),
		setEditorText(text: string) {
			editorTexts.push(text);
		},
		notify(message: string, type?: string) {
			notifications.push({ message, type });
		},
	});

	const ctx = {
		hasUI: true,
		model: { provider: "anthropic", id: "test-model" },
		modelRegistry: { getApiKeyForProvider: async () => "test-key" },
		sessionManager,
		ui,
	};

	const toolResult = await tools.get("handoff").execute(
		"tool-call-1",
		{ goal: "run the verification pass" },
		undefined,
		(update: any) => {
			progressUpdates.push(update.content[0].text);
		},
		ctx as any,
	);

	assert.match(toolResult.content[0].text, /fresh session will open automatically/i);
	assert.equal(sessionManager.getSessionFile(), originalSessionFile);
	assert.deepEqual(progressUpdates, ["Generating handoff prompt from conversation history..."]);

	for (const handler of eventHandlers.get("agent_end") ?? []) {
		await handler({}, ctx as any);
	}
	await new Promise((resolve) => setTimeout(resolve, 10));

	assert.notEqual(sessionManager.getSessionFile(), originalSessionFile);
	assert.equal(editorTexts.length, 1);
	assert.match(editorTexts[0], /session_query/);
	assert.ok(editorTexts[0].includes(originalSessionFile!));
	assert.match(editorTexts[0], /## Next Step\nRun the verification pass/);
	assert.deepEqual(notifications, [
		{ message: "Auto-handoff ready — review if needed, then press Enter to continue.", type: "info" },
	]);

	const handoffEvent = emittedEvents.find((event) => event.name === HANDOFF_SESSION_STARTED_EVENT);
	assert.ok(handoffEvent);
	assert.equal((handoffEvent!.data as any).mode, "tool");
	assert.equal((handoffEvent!.data as any).previousSessionFile, originalSessionFile);
	assert.equal((handoffEvent!.data as any).parentSessionFile, originalSessionFile);
});

test("handoff tool context filter drops pre-handoff messages after the raw session switch", async (t) => {
	const dir = makeTempDir();
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	const { eventHandlers, tools } = createHarness();
	const sessionManager = SessionManager.create(dir);
	const messages = makeMessages();
	sessionManager.appendMessage(messages.user("Investigate flaky test"));
	sessionManager.appendMessage(messages.assistant("It looks racey. Hand off the fix."));

	const ui = createMockUI({
		custom: async () => ({ type: "prompt", text: "## Objective\nFix the flaky test" }),
	});

	const ctx = {
		hasUI: true,
		model: { provider: "anthropic", id: "test-model" },
		modelRegistry: { getApiKeyForProvider: async () => "test-key" },
		sessionManager,
		ui,
	};

	await tools.get("handoff").execute("tool-call-1", { goal: "fix the flaky test" }, undefined, undefined, ctx as any);
	for (const handler of eventHandlers.get("agent_end") ?? []) {
		await handler({}, ctx as any);
	}

	const oldMessage = { role: "user", content: "old", timestamp: Date.now() - 60_000 };
	const newMessage = { role: "user", content: "new", timestamp: Date.now() + 1_000 };
	const contextHandler = eventHandlers.get("context")?.[0];
	assert.ok(contextHandler);

	const result = await contextHandler!({ messages: [oldMessage, newMessage] }, ctx as any);
	assert.deepEqual(result, { messages: [newMessage] });
});
