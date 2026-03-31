import test from "node:test";
import assert from "node:assert/strict";

import { matchesKey, setKittyProtocolActive } from "@mariozechner/pi-tui";

import workflowModesExtension, { normalizeMode } from "./index.ts";

type ShortcutHandler = { description: string; handler: (...args: any[]) => unknown };
type PiEventHandler = (...args: any[]) => unknown;

function createPiHarness(options?: { flagMode?: string; tools?: Array<{ name: string }>; entries?: any[] }) {
	const shortcuts = new Map<string, ShortcutHandler>();
	const commands = new Map<string, { description: string; handler: (...args: any[]) => unknown }>();
	const eventHandlers = new Map<string, PiEventHandler>();
	let activeTools: string[] = [];
	let thinkingLevel: string | undefined;
	let selectedModel: { provider: string; model: string } | undefined;

	return {
		shortcuts,
		commands,
		eventHandlers,
		getActiveTools: () => activeTools,
		getThinkingLevel: () => thinkingLevel,
		getSelectedModel: () => selectedModel,
		pi: {
			registerFlag() {},
			registerShortcut(name: string, definition: ShortcutHandler) {
				shortcuts.set(name, definition);
			},
			registerCommand(name: string, definition: { description: string; handler: (...args: any[]) => unknown }) {
				commands.set(name, definition);
			},
			on(name: string, handler: PiEventHandler) {
				eventHandlers.set(name, handler);
			},
			events: {
				on() {},
				emit() {},
			},
			getAllTools() {
				return options?.tools ?? [
					{ name: "read" },
					{ name: "bash" },
					{ name: "edit" },
					{ name: "write" },
					{ name: "grep" },
					{ name: "find" },
					{ name: "ls" },
					{ name: "open_file" },
				];
			},
			setActiveTools(tools: string[]) {
				activeTools = tools;
			},
			async setModel(model: { provider: string; model: string }) {
				selectedModel = model;
				return true;
			},
			setThinkingLevel(level: string) {
				thinkingLevel = level;
			},
			appendEntry() {},
			getFlag(name: string) {
				return name === "mode" ? options?.flagMode : undefined;
			},
		},
	};
}

function createContext(options?: { availableModels?: Set<string> }) {
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses: Array<{ key: string; value: string }> = [];

	return {
		notifications,
		statuses,
		ctx: {
			hasUI: true,
			ui: {
				setStatus(key: string, value: string) {
					statuses.push({ key, value });
				},
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
				theme: {
					fg(_color: string, text: string) {
						return text;
					},
				},
				async select() {
					return undefined;
				},
			},
			modelRegistry: {
				find(provider: string, model: string) {
					const key = `${provider}/${model}`;
					if (options?.availableModels && !options.availableModels.has(key)) return undefined;
					return { provider, model };
				},
			},
			sessionManager: {
				getEntries() {
					return [];
				},
			},
		},
	};
}

test("normalizeMode accepts smart/deep/fast aliases", () => {
	assert.equal(normalizeMode("smart"), "smart");
	assert.equal(normalizeMode("S"), "smart");
	assert.equal(normalizeMode("deep"), "deep");
	assert.equal(normalizeMode("D"), "deep");
	assert.equal(normalizeMode("fast"), "fast");
	assert.equal(normalizeMode("rush"), "fast");
	assert.equal(normalizeMode("unknown"), undefined);
});

test("workflow-modes registers only ctrl+shift+m for cycling", () => {
	const { shortcuts, pi } = createPiHarness();

	workflowModesExtension(pi as any);

	const shortcut = shortcuts.get("ctrl+shift+m");

	assert.ok(shortcut);
	assert.equal(shortcut.description, "Cycle agent mode (Smart/Deep/Fast)");
	assert.equal(shortcuts.has("f6"), false);
	assert.equal(shortcuts.has("f7"), false);
	assert.equal(shortcuts.has("f8"), false);
	assert.equal(shortcuts.has("alt+w"), false);
	assert.equal(shortcuts.has("ctrl+alt+w"), false);
	assert.equal(shortcuts.has("ctrl+alt+m"), false);
	assert.equal(shortcuts.has("ctrl+m"), false);
	assert.equal(shortcuts.has("ctrl+tab"), false);
});

test("ctrl+shift+m matches csi-u input when kitty protocol is not active", () => {
	setKittyProtocolActive(false);
	assert.equal(matchesKey("\x1b[109;6u", "ctrl+shift+m"), true);
});

test("ctrl+shift+m cycles from smart to deep", async () => {
	const { shortcuts, pi, getSelectedModel, getThinkingLevel } = createPiHarness();
	const { ctx, notifications } = createContext();

	workflowModesExtension(pi as any);

	const shortcut = shortcuts.get("ctrl+shift+m");
	assert.ok(shortcut);

	await shortcut.handler(ctx as any);

	assert.deepEqual(getSelectedModel(), { provider: "openai-codex", model: "gpt-5.4" });
	assert.equal(getThinkingLevel(), "xhigh");
	assert.match(notifications.at(-1)?.message ?? "", /Switched to Mode: Deep/i);
});

test("/smart /deep /fast commands switch modes directly", async () => {
	const { commands, pi, getSelectedModel, getThinkingLevel } = createPiHarness();
	const { ctx, notifications } = createContext();

	workflowModesExtension(pi as any);

	const smartCommand = commands.get("smart");
	const deepCommand = commands.get("deep");
	const deep3Command = commands.get("deep3");
	const fastCommand = commands.get("fast");
	assert.ok(smartCommand);
	assert.ok(deepCommand);
	assert.ok(deep3Command);
	assert.ok(fastCommand);

	await smartCommand.handler("", ctx as any);
	assert.deepEqual(getSelectedModel(), { provider: "anthropic", model: "claude-opus-4-5" });
	assert.equal(getThinkingLevel(), "high");
	assert.match(notifications.at(-1)?.message ?? "", /Switched to Mode: Smart/i);

	await deepCommand.handler("", ctx as any);
	assert.deepEqual(getSelectedModel(), { provider: "openai-codex", model: "gpt-5.4" });
	assert.equal(getThinkingLevel(), "xhigh");
	assert.match(notifications.at(-1)?.message ?? "", /Switched to Mode: Deep/i);

	await deep3Command.handler("", ctx as any);
	assert.deepEqual(getSelectedModel(), { provider: "openai-codex", model: "gpt-5.4" });
	assert.equal(getThinkingLevel(), "xhigh");
	assert.match(notifications.at(-1)?.message ?? "", /Switched to Mode: Deep/i);

	await fastCommand.handler("", ctx as any);
	assert.deepEqual(getSelectedModel(), { provider: "anthropic", model: "claude-sonnet-4-6" });
	assert.equal(getThinkingLevel(), "off");
	assert.match(notifications.at(-1)?.message ?? "", /Switched to Mode: Fast/i);
});

test("deep mode falls back to gpt-5.3-codex when gpt-5.4 is unavailable", async () => {
	const { commands, pi, getSelectedModel, getThinkingLevel } = createPiHarness();
	const { ctx } = createContext({ availableModels: new Set(["openai-codex/gpt-5.3-codex"]) });

	workflowModesExtension(pi as any);

	const deepCommand = commands.get("deep");
	assert.ok(deepCommand);

	await deepCommand.handler("", ctx as any);
	assert.deepEqual(getSelectedModel(), { provider: "openai-codex", model: "gpt-5.3-codex" });
	assert.equal(getThinkingLevel(), "xhigh");
});

test("/mode command accepts aliases and rejects unknown values", async () => {
	const { commands, pi, getSelectedModel } = createPiHarness();
	const { ctx, notifications } = createContext();

	workflowModesExtension(pi as any);

	const modeCommand = commands.get("mode");
	assert.ok(modeCommand);

	await modeCommand.handler("r", ctx as any);
	assert.deepEqual(getSelectedModel(), { provider: "anthropic", model: "claude-sonnet-4-6" });

	await modeCommand.handler("invalid", ctx as any);
	assert.match(notifications.at(-1)?.message ?? "", /Unknown mode\. Use: smart, deep, or fast/i);
});

test("session_start applies flag mode and keeps edit/write tools active", async () => {
	const { pi, eventHandlers, getActiveTools, getSelectedModel, getThinkingLevel } = createPiHarness({ flagMode: "fast" });
	const { ctx } = createContext();

	workflowModesExtension(pi as any);

	const sessionStart = eventHandlers.get("session_start");
	assert.ok(sessionStart);
	await sessionStart?.({}, ctx as any);

	assert.deepEqual(getSelectedModel(), { provider: "anthropic", model: "claude-sonnet-4-6" });
	assert.equal(getThinkingLevel(), "off");
	assert.ok(getActiveTools().includes("edit"));
	assert.ok(getActiveTools().includes("write"));
	assert.ok(getActiveTools().includes("open_file"));
});

test("legacy workflow behavior hooks are removed", () => {
	const { pi, eventHandlers } = createPiHarness();
	workflowModesExtension(pi as any);

	assert.equal(eventHandlers.has("before_agent_start"), false);
	assert.equal(eventHandlers.has("tool_call"), false);
	assert.equal(eventHandlers.has("input"), false);
});
