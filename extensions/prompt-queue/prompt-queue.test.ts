import test from "node:test";
import assert from "node:assert/strict";

import promptQueueExtension, {
	applyPromptQueueAction,
	createInitialState,
	createPromptQueueItem,
	formatQueueStatus,
	getNextQueuedItem,
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
	assert.deepEqual(shortcuts, ["ctrl+q", "alt+q"]);
	assert.deepEqual(events, ["session_start", "session_tree", "agent_end"]);
});
