import test from "node:test";
import assert from "node:assert/strict";

import promptQueueExtension, {
	applyPromptQueueAction,
	createInitialState,
	createPromptQueueItem,
	formatQueueStatus,
	getNextQueuedItem,
	isPromptQueueAction,
} from "./index.ts";

test("prompt queue actions add, update, mark done, and clear completed prompts", () => {
	let state = createInitialState();
	const first = createPromptQueueItem(1, "Run tests", 100);
	const second = createPromptQueueItem(2, "Summarize changes", 200);

	state = applyPromptQueueAction(state, { action: "add", item: first });
	state = applyPromptQueueAction(state, { action: "add", item: second });
	state = applyPromptQueueAction(state, { action: "update", id: first.id, text: "Run focused tests", updatedAt: 300 });
	state = applyPromptQueueAction(state, { action: "status", id: first.id, status: "running", updatedAt: 400 });
	state = applyPromptQueueAction(state, { action: "status", id: first.id, status: "done", updatedAt: 500 });

	assert.equal(state.nextId, 3);
	assert.equal(state.activeId, undefined);
	assert.deepEqual(state.items.map((item) => ({ id: item.id, text: item.text, status: item.status })), [
		{ id: 1, text: "Run focused tests", status: "done" },
		{ id: 2, text: "Summarize changes", status: "queued" },
	]);
	assert.equal(getNextQueuedItem(state)?.id, 2);

	state = applyPromptQueueAction(state, { action: "clearDone", updatedAt: 600 });
	assert.deepEqual(state.items.map((item) => item.id), [2]);
});

test("formatQueueStatus exposes queued/running/draining state", () => {
	let state = createInitialState();
	assert.equal(formatQueueStatus(state), "queue: empty");

	state = applyPromptQueueAction(state, { action: "add", item: createPromptQueueItem(1, "One", 100) });
	state = applyPromptQueueAction(state, { action: "add", item: createPromptQueueItem(2, "Two", 200) });
	assert.equal(formatQueueStatus(state), "queue: 2 queued");

	state = applyPromptQueueAction(state, { action: "status", id: 1, status: "running", updatedAt: 300 });
	assert.equal(formatQueueStatus(state), "queue: 1 queued · running");

	state = applyPromptQueueAction(state, { action: "status", id: 1, status: "done", updatedAt: 400 });
	state.draining = true;
	assert.equal(formatQueueStatus(state), "queue: 1 queued · draining");
});

test("delete clears active prompt when the running item is removed", () => {
	let state = createInitialState();
	state = applyPromptQueueAction(state, { action: "add", item: createPromptQueueItem(1, "One", 100) });
	state = applyPromptQueueAction(state, { action: "status", id: 1, status: "running", updatedAt: 200 });
	state.draining = true;

	state = applyPromptQueueAction(state, { action: "delete", id: 1 });

	assert.equal(state.activeId, undefined);
	assert.equal(state.draining, false);
	assert.deepEqual(state.items, []);
});

test("interrupted running items can be recovered to queued", () => {
	let state = createInitialState();
	state = applyPromptQueueAction(state, { action: "add", item: createPromptQueueItem(1, "One", 100) });
	state = applyPromptQueueAction(state, { action: "status", id: 1, status: "running", updatedAt: 200 });
	state = applyPromptQueueAction(state, { action: "status", id: 1, status: "queued", updatedAt: 300 });

	assert.equal(state.activeId, undefined);
	assert.equal(state.items[0]?.status, "queued");
});

test("persisted queue actions require valid payloads", () => {
	assert.equal(isPromptQueueAction({ action: "add" }), false);
	assert.equal(isPromptQueueAction({ action: "status", id: 1, status: "bogus", updatedAt: 1 }), false);
	assert.equal(isPromptQueueAction({ action: "delete", id: Number.NaN }), false);
	assert.equal(isPromptQueueAction({ action: "add", item: createPromptQueueItem(1, "valid", 1) }), true);

	const state = applyPromptQueueAction(createInitialState(), { action: "status", id: 99, status: "running", updatedAt: 1 });
	assert.equal(state.activeId, undefined);
});

test("session reconstruction ignores malformed entries and persists interrupted recovery", async () => {
	const handlers = new Map<string, any>();
	const appended: any[] = [];
	const notifications: string[] = [];
	promptQueueExtension({
		registerCommand() {},
		registerShortcut() {},
		on(eventName: string, handler: any) {
			handlers.set(eventName, handler);
		},
		appendEntry(_type: string, data: unknown) {
			appended.push(data);
		},
		sendUserMessage() {},
	} as any);
	const item = createPromptQueueItem(1, "resume me", 1);
	await handlers.get("session_start")({}, {
		sessionManager: {
			getBranch: () => [
				{ type: "custom", customType: "prompt-queue", data: { action: "add" } },
				{ type: "custom", customType: "prompt-queue", data: { action: "add", item } },
				{ type: "custom", customType: "prompt-queue", data: { action: "status", id: 1, status: "running", updatedAt: 2 } },
			],
		},
		ui: {
			setStatus() {},
			notify(message: string) {
				notifications.push(message);
			},
		},
	});

	assert.deepEqual(appended, [{ action: "status", id: 1, status: "queued", updatedAt: appended[0].updatedAt }]);
	assert.match(notifications[0] ?? "", /Recovered 1 interrupted queued prompt/);
});

test("running queue items are represented by status then delete lifecycle", () => {
	let state = createInitialState();
	state = applyPromptQueueAction(state, { action: "add", item: createPromptQueueItem(1, "One", 100) });
	state = applyPromptQueueAction(state, { action: "status", id: 1, status: "running", updatedAt: 200 });

	assert.equal(state.activeId, 1);
	assert.equal(state.items[0]?.status, "running");

	state = applyPromptQueueAction(state, { action: "delete", id: 1 });
	assert.deepEqual(state.items, []);
	assert.equal(formatQueueStatus(state), "queue: empty");
});

test("extension registers queue commands, shortcut, and lifecycle hooks", () => {
	const commands: string[] = [];
	const shortcuts: string[] = [];
	const events: string[] = [];

	promptQueueExtension({
		registerCommand(name: string) {
			commands.push(name);
		},
		registerShortcut(shortcut: string) {
			shortcuts.push(shortcut);
		},
		on(eventName: string) {
			events.push(eventName);
		},
		appendEntry() {},
		sendUserMessage() {},
	} as any);

	assert.deepEqual(commands, ["queue", "queue-add", "queue-run", "queue-stop"]);
	assert.deepEqual(shortcuts, ["ctrl+q", "ctrl+shift+a"]);
	assert.deepEqual(events, ["session_start", "session_tree", "agent_settled"]);
});
