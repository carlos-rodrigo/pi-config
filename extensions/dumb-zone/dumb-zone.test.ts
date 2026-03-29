import test from "node:test";
import assert from "node:assert/strict";

import dumbZoneExtension, { getContextPercent, getZoneLabel, getZoneStatus } from "./index.ts";

type PiEventHandler = (...args: any[]) => unknown;

test("getContextPercent prefers provided percent and falls back to token ratio", () => {
	assert.equal(getContextPercent({ percent: 12, tokens: 500, contextWindow: 1000 }), 12);
	assert.equal(getContextPercent({ tokens: 450, contextWindow: 1000 }), 45);
});

test("getZoneLabel uses aggressive 45 percent handoff threshold", () => {
	assert.equal(getZoneLabel(10), "smart");
	assert.equal(getZoneLabel(30), "caution");
	assert.equal(getZoneLabel(44), "caution");
	assert.equal(getZoneLabel(45), "dumb");
});

test("getZoneStatus returns a single colored label for the active zone", () => {
	const theme = {
		fg(color: string, text: string) {
			return `<${color}>${text}</${color}>`;
		},
	};

	assert.equal(getZoneStatus(10, theme), "<success>smart</success>");
	assert.equal(getZoneStatus(35, theme), "<syntaxNumber>caution</syntaxNumber>");
	assert.equal(getZoneStatus(50, theme), "<error>dumb</error>");
});

test("turn_end updates status and triggers handoff once at threshold", async () => {
	const eventHandlers = new Map<string, PiEventHandler>();
	const sentMessages: Array<{ message: any; options: any }> = [];
	const statuses: Array<{ key: string; value: string | undefined }> = [];

	dumbZoneExtension({
		on(name: string, handler: PiEventHandler) {
			eventHandlers.set(name, handler);
		},
		sendMessage(message: any, options: any) {
			sentMessages.push({ message, options });
		},
	} as any);

	const turnEnd = eventHandlers.get("turn_end");
	assert.ok(turnEnd);

	const ctx = {
		ui: {
			theme: {
				fg(_color: string, text: string) {
					return text;
				},
			},
			setStatus(key: string, value: string | undefined) {
				statuses.push({ key, value });
			},
		},
		getContextUsage() {
			return { percent: 45, tokens: 450, contextWindow: 1000 };
		},
	};

	await turnEnd({}, ctx as any);
	await turnEnd({}, ctx as any);

	assert.deepEqual(statuses.at(-1), { key: "dumb-zone", value: "dumb" });
	assert.equal(sentMessages.length, 1);
	assert.match(sentMessages[0].message.content, /MUST hand off immediately/i);
	assert.deepEqual(sentMessages[0].options, { deliverAs: "followUp", triggerTurn: true });
});

test("session_switch resets handoff state and immediately restores the legend", async () => {
	const eventHandlers = new Map<string, PiEventHandler>();
	const sentMessages: Array<{ message: any; options: any }> = [];
	const statuses: Array<{ key: string; value: string | undefined }> = [];

	dumbZoneExtension({
		on(name: string, handler: PiEventHandler) {
			eventHandlers.set(name, handler);
		},
		sendMessage(message: any, options: any) {
			sentMessages.push({ message, options });
		},
	} as any);

	const turnEnd = eventHandlers.get("turn_end");
	const sessionSwitch = eventHandlers.get("session_switch");
	assert.ok(turnEnd);
	assert.ok(sessionSwitch);

	const ctx = {
		ui: {
			theme: {
				fg(_color: string, text: string) {
					return text;
				},
			},
			setStatus(key: string, value: string | undefined) {
				statuses.push({ key, value });
			},
		},
		getContextUsage() {
			return { percent: 50, tokens: 500, contextWindow: 1000 };
		},
	};

	await turnEnd({}, ctx as any);
	assert.equal(sentMessages.length, 1);

	await sessionSwitch({}, ctx as any);
	await turnEnd({}, ctx as any);

	assert.deepEqual(statuses.at(-1), { key: "dumb-zone", value: "dumb" });
	assert.equal(sentMessages.length, 2);
});
