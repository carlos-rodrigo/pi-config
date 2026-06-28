import test from "node:test";
import assert from "node:assert/strict";

import overseerExtension, { detectLargeMutation, detectRepeatedFailure } from "./index.ts";
import { WARNING_EVENT } from "../self-improvement-archive/index.ts";

function createHarness() {
	const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
	const commands = new Map<string, { description: string; handler: (...args: any[]) => unknown }>();
	const emittedEvents: Array<{ name: string; data: unknown }> = [];
	const pi = {
		on(name: string, handler: (...args: any[]) => unknown) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerCommand(name: string, definition: { description: string; handler: (...args: any[]) => unknown }) {
			commands.set(name, definition);
		},
		events: {
			emit(name: string, data: unknown) {
				emittedEvents.push({ name, data });
			},
		},
	};
	overseerExtension(pi as any);
	return {
		handlers,
		commands,
		emittedEvents,
		async emit(name: string, event: unknown, ctx: unknown) {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
	};
}

function createCtx(hasUI = true) {
	const notifications: Array<{ message: string; level: string }> = [];
	return {
		notifications,
		ctx: {
			hasUI,
			ui: {
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
			},
		},
	};
}

test("detectRepeatedFailure warns on the second identical tool error", () => {
	const counts = new Map<string, number>();
	const event = { toolName: "bash", isError: true, content: [{ text: "command not found" }] };
	assert.equal(detectRepeatedFailure(event, counts), undefined);
	const warning = detectRepeatedFailure(event, counts);
	assert.ok(warning);
	assert.equal(warning.type, "repeated-tool-error");
	assert.match(warning.message, /failed 2 times/);
});

test("detectLargeMutation warns for large write and edit inputs", () => {
	const writeWarning = detectLargeMutation({ toolName: "write", input: { path: "big.ts", content: "x".repeat(50_001) } });
	assert.equal(writeWarning?.type, "large-write");

	const editWarning = detectLargeMutation({ toolName: "edit", input: { path: "big.ts", edits: [{ oldText: "a", newText: "b".repeat(50_001) }] } });
	assert.equal(editWarning?.type, "large-edit");

	assert.equal(detectLargeMutation({ toolName: "write", input: { path: "small.ts", content: "ok" } }), undefined);
});

test("overseer is quiet for normal events and warning-only for repeated failures", async () => {
	const harness = createHarness();
	const context = createCtx(true);

	await harness.emit("session_start", {}, context.ctx);
	await harness.emit("tool_result", { toolName: "bash", isError: false, content: [{ text: "ok" }] }, context.ctx);
	assert.equal(context.notifications.length, 0);

	await harness.emit("tool_result", { toolName: "bash", isError: true, content: [{ text: "same error" }] }, context.ctx);
	assert.equal(context.notifications.length, 0);
	await harness.emit("tool_result", { toolName: "bash", isError: true, content: [{ text: "same error" }] }, context.ctx);
	assert.equal(context.notifications.length, 1);
	assert.equal(harness.emittedEvents[0].name, WARNING_EVENT);
	assert.equal((harness.emittedEvents[0].data as any).type, "repeated-tool-error");

	await harness.emit("tool_result", { toolName: "bash", isError: true, content: [{ text: "same error" }] }, context.ctx);
	assert.equal(context.notifications.length, 1, "warning should be rate limited");
});

test("overseer does not crash without UI and never blocks tool calls", async () => {
	const harness = createHarness();
	const context = createCtx(false);

	await harness.emit("tool_call", { toolName: "write", input: { path: "big.ts", content: "x".repeat(50_001) } }, context.ctx);
	assert.equal(context.notifications.length, 0);
	assert.equal(harness.emittedEvents[0].name, WARNING_EVENT);
});

test("overseer-status reports warning count", async () => {
	const harness = createHarness();
	const context = createCtx(true);
	const command = harness.commands.get("overseer-status");
	assert.ok(command);
	await command.handler("", context.ctx);
	assert.match(context.notifications[0].message, /warning-only mode/);
});
