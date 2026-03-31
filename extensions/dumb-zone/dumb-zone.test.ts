import test from "node:test";
import assert from "node:assert/strict";

import dumbZoneExtension, { getContextPercent, getZoneLabel, getZoneStatus } from "./index.ts";
import { HANDOFF_SESSION_STARTED_EVENT } from "../handoff/events.ts";

type PiEventHandler = (...args: any[]) => unknown;

function createHarness() {
	const eventHandlers = new Map<string, PiEventHandler>();
	const sentMessages: Array<{ message: any; options: any }> = [];
	const eventBusHandlers = new Map<string, ((data: unknown) => void)[]>();

	dumbZoneExtension({
		on(name: string, handler: PiEventHandler) {
			eventHandlers.set(name, handler);
		},
		sendMessage(message: any, options: any) {
			sentMessages.push({ message, options });
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

	return { eventHandlers, sentMessages, emit(name: string, data?: unknown) { for (const handler of eventBusHandlers.get(name) ?? []) handler(data); } };
}

function createCtx(options?: { percent?: number; sessionId?: string; setStatus?: (key: string, value: string | undefined) => void }) {
	const percent = options?.percent ?? 50;
	const statuses: Array<{ key: string; value: string | undefined }> = [];
	const setStatus = options?.setStatus ?? ((key: string, value: string | undefined) => {
		statuses.push({ key, value });
	});

	return {
		statuses,
		ctx: {
			ui: {
				theme: {
					fg(_color: string, text: string) {
						return text;
					},
				},
				setStatus,
			},
			getContextUsage() {
				return { percent, tokens: Math.round(percent * 10), contextWindow: 1000 };
			},
			sessionManager: {
				getSessionId() {
					return options?.sessionId ?? "session-a";
				},
			},
		},
	};
}

test("getContextPercent prefers provided percent and falls back to token ratio", () => {
	assert.equal(getContextPercent({ percent: 12, tokens: 500, contextWindow: 1000 }), 12);
	assert.equal(getContextPercent({ tokens: 450, contextWindow: 1000 }), 45);
});

test("getZoneLabel uses model-specific thresholds (default: 40% handoff)", () => {
	assert.equal(getZoneLabel(10), "smart");
	assert.equal(getZoneLabel(39), "smart");
	assert.equal(getZoneLabel(40), "dumb");
	assert.equal(getZoneLabel(50), "dumb");
});

test("getZoneLabel uses stricter thresholds for large context models (20% handoff)", () => {
	assert.equal(getZoneLabel(10, "claude-opus-4-5"), "smart");
	assert.equal(getZoneLabel(19, "claude-opus-4-5"), "smart");
	assert.equal(getZoneLabel(20, "claude-sonnet-4-6"), "dumb");
	assert.equal(getZoneLabel(25, "claude-opus-4-5"), "dumb");
});

test("getZoneStatus returns a single colored label for the active zone", () => {
	const theme = {
		fg(color: string, text: string) {
			return `<${color}>${text}</${color}>`;
		},
	};

	// Default: 40% handoff
	assert.equal(getZoneStatus(10, theme), "<success>smart</success>");
	assert.equal(getZoneStatus(50, theme), "<error>dumb</error>");

	// Large context models: 20% handoff
	assert.equal(getZoneStatus(10, theme, "claude-opus-4-5"), "<success>smart</success>");
	assert.equal(getZoneStatus(25, theme, "claude-opus-4-5"), "<error>dumb</error>");
});

test("turn_end updates status and triggers handoff once at threshold", async () => {
	const { eventHandlers, sentMessages } = createHarness();
	const turnEnd = eventHandlers.get("turn_end");
	assert.ok(turnEnd);

	// Default handoff threshold is 40%
	const { statuses, ctx } = createCtx({ percent: 40 });

	await turnEnd!({}, ctx as any);
	await turnEnd!({}, ctx as any);

	assert.deepEqual(statuses.at(-1), { key: "dumb-zone", value: "dumb" });
	assert.equal(sentMessages.length, 1);
	assert.match(sentMessages[0].message.content, /MUST hand off immediately/i);
	assert.deepEqual(sentMessages[0].options, { deliverAs: "followUp", triggerTurn: true });
});

test("session_switch resets handoff state and immediately restores the legend", async () => {
	const { eventHandlers, sentMessages } = createHarness();
	const turnEnd = eventHandlers.get("turn_end");
	const sessionSwitch = eventHandlers.get("session_switch");
	assert.ok(turnEnd);
	assert.ok(sessionSwitch);

	const { statuses, ctx } = createCtx({ percent: 50 });

	await turnEnd!({}, ctx as any);
	assert.equal(sentMessages.length, 1);

	await sessionSwitch!({}, ctx as any);
	await turnEnd!({}, ctx as any);

	assert.deepEqual(statuses.at(-1), { key: "dumb-zone", value: "dumb" });
	assert.equal(sentMessages.length, 2);
});

test("handoff session-start event resets the gate and marks the fresh session as smart", async () => {
	const { eventHandlers, sentMessages, emit } = createHarness();
	const turnEnd = eventHandlers.get("turn_end");
	assert.ok(turnEnd);

	const { statuses, ctx } = createCtx({ percent: 50, sessionId: "session-a" });

	await turnEnd!({}, ctx as any);
	assert.equal(sentMessages.length, 1);

	emit(HANDOFF_SESSION_STARTED_EVENT, { mode: "tool" });
	assert.deepEqual(statuses.at(-1), { key: "dumb-zone", value: "smart" });

	await turnEnd!({}, ctx as any);
	assert.equal(sentMessages.length, 2);
});

test("model_select updates status to reflect new context window", async () => {
	const { eventHandlers } = createHarness();
	const modelSelect = eventHandlers.get("model_select");
	assert.ok(modelSelect);

	const { statuses, ctx } = createCtx({ percent: 15, sessionId: "session-a" });
	await modelSelect!({}, ctx as any);

	assert.deepEqual(statuses.at(-1), { key: "dumb-zone", value: "smart" });
});

test("model_select resets handoff gate when new model drops below threshold", async () => {
	const { eventHandlers, sentMessages } = createHarness();
	const turnEnd = eventHandlers.get("turn_end");
	const modelSelect = eventHandlers.get("model_select");
	assert.ok(turnEnd);
	assert.ok(modelSelect);

	// Start above default 40% threshold
	const dumb = createCtx({ percent: 50, sessionId: "session-a" });
	await turnEnd!({}, dumb.ctx as any);
	assert.equal(sentMessages.length, 1);

	// Switch to model with larger context that drops below threshold
	const biggerModel = createCtx({ percent: 15, sessionId: "session-a" });
	await modelSelect!({}, biggerModel.ctx as any);
	assert.deepEqual(biggerModel.statuses.at(-1), { key: "dumb-zone", value: "smart" });

	await turnEnd!({}, dumb.ctx as any);
	assert.equal(sentMessages.length, 2);
});

test("model_select does not reset handoff gate when still above threshold", async () => {
	const { eventHandlers, sentMessages } = createHarness();
	const turnEnd = eventHandlers.get("turn_end");
	const modelSelect = eventHandlers.get("model_select");
	assert.ok(turnEnd);
	assert.ok(modelSelect);

	// Start above default 40% threshold
	const dumb = createCtx({ percent: 50, sessionId: "session-a" });
	await turnEnd!({}, dumb.ctx as any);
	assert.equal(sentMessages.length, 1);

	// Still above 40% threshold after model switch
	const stillDumb = createCtx({ percent: 42, sessionId: "session-a" });
	await modelSelect!({}, stillDumb.ctx as any);
	await turnEnd!({}, stillDumb.ctx as any);

	assert.equal(sentMessages.length, 1);
});

test("session id drift resets the gate even without lifecycle events", async () => {
	const { eventHandlers, sentMessages } = createHarness();
	const turnEnd = eventHandlers.get("turn_end");
	assert.ok(turnEnd);

	const sessionA = createCtx({ percent: 50, sessionId: "session-a" });
	await turnEnd!({}, sessionA.ctx as any);
	assert.equal(sentMessages.length, 1);

	const sessionB = createCtx({ percent: 50, sessionId: "session-b" });
	await turnEnd!({}, sessionB.ctx as any);
	assert.equal(sentMessages.length, 2);
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
