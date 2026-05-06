import test from "node:test";
import assert from "node:assert/strict";

import dumbZoneExtension, { getContextPercent, getZoneLabel, getZoneStatus } from "./index.ts";

type PiEventHandler = (...args: any[]) => unknown;

function createHarness() {
	const eventHandlers = new Map<string, PiEventHandler>();
	const eventBusHandlers = new Map<string, ((data: unknown) => void)[]>();

	dumbZoneExtension({
		on(name: string, handler: PiEventHandler) {
			eventHandlers.set(name, handler);
		},
		events: {
			emit(name: string, data: unknown) {
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
	} as any);

	return { eventHandlers, emit(name: string, data?: unknown) { for (const handler of eventBusHandlers.get(name) ?? []) handler(data); } };
}

function createCtx(options?: { percent?: number; sessionId?: string; setStatus?: (key: string, value: string | undefined) => void }) {
	const percent = options?.percent ?? 50;
	const statuses: Array<{ key: string; value: string | undefined }> = [];
	const compactCalls: any[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const setStatus = options?.setStatus ?? ((key: string, value: string | undefined) => {
		statuses.push({ key, value });
	});

	return {
		statuses,
		compactCalls,
		notifications,
		ctx: {
			hasUI: true,
			ui: {
				theme: {
					fg(_color: string, text: string) {
						return text;
					},
				},
				setStatus,
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
			},
			getContextUsage() {
				return { percent, tokens: Math.round(percent * 10), contextWindow: 1000 };
			},
			sessionManager: {
				getSessionId() {
					return options?.sessionId ?? "session-a";
				},
			},
			compact(options?: any) {
				compactCalls.push(options);
			},
		},
	};
}

test("getContextPercent prefers provided percent and falls back to token ratio", () => {
	assert.equal(getContextPercent({ percent: 12, tokens: 500, contextWindow: 1000 }), 12);
	assert.equal(getContextPercent({ tokens: 450, contextWindow: 1000 }), 45);
});

test("getZoneLabel uses default threshold (101% = effectively disabled)", () => {
	assert.equal(getZoneLabel(10), "smart");
	assert.equal(getZoneLabel(50), "smart");
	assert.equal(getZoneLabel(100), "smart");
	assert.equal(getZoneLabel(101), "dumb");
});

test("getZoneLabel uses stricter thresholds for large context models (20% compaction)", () => {
	assert.equal(getZoneLabel(10, "claude-opus-4-6"), "smart");
	assert.equal(getZoneLabel(19, "claude-opus-4-6"), "smart");
	assert.equal(getZoneLabel(20, "claude-sonnet-4-6"), "dumb");
	assert.equal(getZoneLabel(25, "claude-opus-4-6"), "dumb");
});

test("getZoneLabel uses 40% threshold for Opus 4.5", () => {
	assert.equal(getZoneLabel(10, "claude-opus-4-5"), "smart");
	assert.equal(getZoneLabel(39, "claude-opus-4-5"), "smart");
	assert.equal(getZoneLabel(40, "claude-opus-4-5"), "dumb");
	assert.equal(getZoneLabel(50, "claude-opus-4-5"), "dumb");
});


test("getZoneStatus returns a single colored label for the active zone", () => {
	const theme = {
		fg(color: string, text: string) {
			return `<${color}>${text}</${color}>`;
		},
	};

	// Default: 101% (effectively disabled)
	assert.equal(getZoneStatus(10, theme), "<success>smart</success>");
	assert.equal(getZoneStatus(100, theme), "<success>smart</success>");

	// Large context models: 20% compaction
	assert.equal(getZoneStatus(10, theme, "claude-opus-4-6"), "<success>smart</success>");
	assert.equal(getZoneStatus(25, theme, "claude-opus-4-6"), "<error>dumb</error>");
});

test("turn_end updates status and triggers compaction once at threshold", async () => {
	const { eventHandlers } = createHarness();
	const turnEnd = eventHandlers.get("turn_end");
	assert.ok(turnEnd);

	// Default compaction threshold is 101% (effectively disabled), so use a large-context model
	const { statuses, compactCalls, ctx } = createCtx({ percent: 20 });
	(ctx as any).model = { id: "claude-opus-4-6" };

	await turnEnd!({}, ctx as any);
	await turnEnd!({}, ctx as any);

	assert.deepEqual(statuses.at(-1), { key: "dumb-zone", value: "dumb" });
	assert.equal(compactCalls.length, 1);
	assert.match(compactCalls[0].customInstructions, /active goal/);
});

test("session_switch resets compaction state and immediately restores the legend", async () => {
	const { eventHandlers } = createHarness();
	const turnEnd = eventHandlers.get("turn_end");
	const sessionSwitch = eventHandlers.get("session_switch");
	assert.ok(turnEnd);
	assert.ok(sessionSwitch);

	const { statuses, compactCalls, ctx } = createCtx({ percent: 25 });
	(ctx as any).model = { id: "claude-opus-4-6" };

	await turnEnd!({ model: { id: "claude-opus-4-6" } }, ctx as any);
	assert.equal(compactCalls.length, 1);

	await sessionSwitch!({}, ctx as any);
	await turnEnd!({}, ctx as any);

	assert.deepEqual(statuses.at(-1), { key: "dumb-zone", value: "dumb" });
	assert.equal(compactCalls.length, 2);
});

test("successful compaction resets the gate and marks the context as smart", async () => {
	const { eventHandlers } = createHarness();
	const turnEnd = eventHandlers.get("turn_end");
	assert.ok(turnEnd);

	const { statuses, compactCalls, notifications, ctx } = createCtx({ percent: 25, sessionId: "session-a" });
	(ctx as any).model = { id: "claude-opus-4-6" };

	await turnEnd!({ model: { id: "claude-opus-4-6" } }, ctx as any);
	assert.equal(compactCalls.length, 1);

	compactCalls[0].onComplete({});
	assert.deepEqual(statuses.at(-1), { key: "dumb-zone", value: "smart" });
	assert.deepEqual(notifications.at(-1), { message: "Compaction completed — continuing in this session.", level: "info" });

	await turnEnd!({}, ctx as any);
	assert.equal(compactCalls.length, 2);
});

test("failed compaction resets the gate so a later turn can retry", async () => {
	const { eventHandlers } = createHarness();
	const turnEnd = eventHandlers.get("turn_end");
	assert.ok(turnEnd);

	const { compactCalls, notifications, ctx } = createCtx({ percent: 25, sessionId: "session-a" });
	(ctx as any).model = { id: "claude-opus-4-6" };

	await turnEnd!({ model: { id: "claude-opus-4-6" } }, ctx as any);
	assert.equal(compactCalls.length, 1);

	compactCalls[0].onError(new Error("boom"));
	assert.deepEqual(notifications.at(-1), { message: "Compaction failed: boom", level: "error" });

	await turnEnd!({}, ctx as any);
	assert.equal(compactCalls.length, 2);
});

test("model_select updates status to reflect new context window", async () => {
	const { eventHandlers } = createHarness();
	const modelSelect = eventHandlers.get("model_select");
	assert.ok(modelSelect);

	const { statuses, ctx } = createCtx({ percent: 15, sessionId: "session-a" });
	await modelSelect!({}, ctx as any);

	assert.deepEqual(statuses.at(-1), { key: "dumb-zone", value: "smart" });
});

test("model_select resets compaction gate when new model drops below threshold", async () => {
	const { eventHandlers } = createHarness();
	const turnEnd = eventHandlers.get("turn_end");
	const modelSelect = eventHandlers.get("model_select");
	assert.ok(turnEnd);
	assert.ok(modelSelect);

	// Start above 20% threshold with large-context model
	const dumb = createCtx({ percent: 25, sessionId: "session-a" });
	(dumb.ctx as any).model = { id: "claude-opus-4-6" };
	await turnEnd!({ model: { id: "claude-opus-4-6" } }, dumb.ctx as any);
	assert.equal(dumb.compactCalls.length, 1);

	// Switch to model with larger context that drops below threshold
	const biggerModel = createCtx({ percent: 15, sessionId: "session-a" });
	await modelSelect!({}, biggerModel.ctx as any);
	assert.deepEqual(biggerModel.statuses.at(-1), { key: "dumb-zone", value: "smart" });

	await turnEnd!({}, dumb.ctx as any);
	assert.equal(dumb.compactCalls.length, 2);
});

test("model_select does not reset compaction gate when still above threshold", async () => {
	const { eventHandlers } = createHarness();
	const turnEnd = eventHandlers.get("turn_end");
	const modelSelect = eventHandlers.get("model_select");
	assert.ok(turnEnd);
	assert.ok(modelSelect);

	// Start above 20% threshold with large-context model
	const dumb = createCtx({ percent: 25, sessionId: "session-a" });
	(dumb.ctx as any).model = { id: "claude-opus-4-6" };
	await turnEnd!({ model: { id: "claude-opus-4-6" } }, dumb.ctx as any);
	assert.equal(dumb.compactCalls.length, 1);

	// Still above 20% threshold after model switch
	const stillDumb = createCtx({ percent: 22, sessionId: "session-a" });
	(stillDumb.ctx as any).model = { id: "claude-opus-4-6" };
	await modelSelect!({ model: { id: "claude-opus-4-6" } }, stillDumb.ctx as any);
	await turnEnd!({ model: { id: "claude-opus-4-6" } }, stillDumb.ctx as any);

	assert.equal(dumb.compactCalls.length, 1);
	assert.equal(stillDumb.compactCalls.length, 0);
});

test("session id drift resets the gate even without lifecycle events", async () => {
	const { eventHandlers } = createHarness();
	const turnEnd = eventHandlers.get("turn_end");
	assert.ok(turnEnd);

	const sessionA = createCtx({ percent: 25, sessionId: "session-a" });
	(sessionA.ctx as any).model = { id: "claude-opus-4-6" };
	await turnEnd!({ model: { id: "claude-opus-4-6" } }, sessionA.ctx as any);
	assert.equal(sessionA.compactCalls.length, 1);

	const sessionB = createCtx({ percent: 25, sessionId: "session-b" });
	(sessionB.ctx as any).model = { id: "claude-opus-4-6" };
	await turnEnd!({ model: { id: "claude-opus-4-6" } }, sessionB.ctx as any);
	assert.equal(sessionB.compactCalls.length, 1);
});

test("workflow:mode event updates status immediately", async () => {
	const { eventHandlers, emit } = createHarness();
	const turnEnd = eventHandlers.get("turn_end");
	assert.ok(turnEnd);

	const { statuses, ctx } = createCtx({ percent: 30, sessionId: "session-a" });
	await turnEnd!({}, ctx as any);
	const initialStatusCount = statuses.length;

	// Emitting workflow:mode should trigger status update
	emit("workflow:mode", { mode: "fast" });
	assert.ok(statuses.length > initialStatusCount);
});
