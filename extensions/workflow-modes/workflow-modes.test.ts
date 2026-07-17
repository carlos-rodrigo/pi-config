import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { matchesKey, setKittyProtocolActive } from "@earendil-works/pi-tui";

import { appendArchiveRecord } from "../self-improvement-archive/index.ts";
import workflowModesExtension, { normalizeMode } from "./index.ts";

type ShortcutHandler = { description: string; handler: (...args: any[]) => unknown };
type PiEventHandler = (...args: any[]) => unknown;

function createPiHarness(options?: {
	workflowMode?: string;
	legacyFlagMode?: string;
	thinkingLevel?: string;
	tools?: Array<{ name: string }>;
	entries?: any[];
}) {
	const shortcuts = new Map<string, ShortcutHandler>();
	const commands = new Map<string, { description: string; handler: (...args: any[]) => unknown }>();
	const eventHandlers = new Map<string, PiEventHandler>();
	let activeTools: string[] = [];
	let thinkingLevel: string | undefined = options?.thinkingLevel;
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
			getThinkingLevel() {
				return thinkingLevel;
			},
			setThinkingLevel(level: string) {
				thinkingLevel = level;
			},
			appendEntry() {},
			getFlag(name: string) {
				if (name === "workflow-mode") return options?.workflowMode;
				if (name === "mode") return options?.legacyFlagMode;
				return undefined;
			},
		},
	};
}

function createContext(options?: {
	availableModels?: Set<string>;
	entries?: any[];
	currentModel?: { provider: string; id: string };
}) {
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses: Array<{ key: string; value: string }> = [];
	const editorTexts: string[] = [];
	const themeColors: string[] = [];

	return {
		notifications,
		statuses,
		editorTexts,
		themeColors,
		ctx: {
			cwd: process.cwd(),
			hasUI: true,
			ui: {
				setStatus(key: string, value: string) {
					statuses.push({ key, value });
				},
				setEditorText(text: string) {
					editorTexts.push(text);
				},
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
				theme: {
					fg(color: string, text: string) {
						themeColors.push(color);
						return text;
					},
				},
				async select() {
					return undefined;
				},
			},
			model: options?.currentModel,
			modelRegistry: {
				find(provider: string, model: string) {
					const key = `${provider}/${model}`;
					if (options?.availableModels && !options.availableModels.has(key)) return undefined;
					return { provider, model };
				},
			},
			sessionManager: {
				getEntries() {
					return options?.entries ?? [];
				},
			},
		},
	};
}

test("normalizeMode accepts fast/smart/deep3/max aliases and rejects deleted Deep²", () => {
	assert.equal(normalizeMode("fast"), "fast");
	assert.equal(normalizeMode("rush"), "fast");
	assert.equal(normalizeMode("smart"), "smart");
	assert.equal(normalizeMode("S"), "smart");
	assert.equal(normalizeMode("deep"), "deep3");
	assert.equal(normalizeMode("D"), "deep3");
	assert.equal(normalizeMode("deep3"), "deep3");
	assert.equal(normalizeMode("D3"), "deep3");
	assert.equal(normalizeMode("max"), "max");
	assert.equal(normalizeMode("maximum"), "max");
	assert.equal(normalizeMode("deep1"), undefined);
	assert.equal(normalizeMode("deep2"), undefined);
	assert.equal(normalizeMode("deep²"), undefined);
	assert.equal(normalizeMode("D2"), undefined);
	assert.equal(normalizeMode("unknown"), undefined);
});

test("workflow-modes registers only ctrl+shift+m for cycling", () => {
	const { shortcuts, pi } = createPiHarness();

	workflowModesExtension(pi as any);

	const shortcut = shortcuts.get("ctrl+shift+m");

	assert.ok(shortcut);
	assert.equal(shortcut.description, "Cycle agent mode (Fast/Smart/Deep³/Max)");
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

test("ctrl+shift+m cycles through every mode from the Fast default", async () => {
	const { shortcuts, pi, getSelectedModel, getThinkingLevel } = createPiHarness();
	const { ctx, notifications, statuses, themeColors } = createContext();

	workflowModesExtension(pi as any);

	const shortcut = shortcuts.get("ctrl+shift+m");
	assert.ok(shortcut);

	await shortcut.handler(ctx as any);
	assert.deepEqual(getSelectedModel(), { provider: "openai-codex", model: "gpt-5.6-sol" });
	assert.equal(getThinkingLevel(), "high");
	assert.match(notifications.at(-1)?.message ?? "", /Switched to Mode: Smart/i);
	assert.match(statuses.at(-1)?.value ?? "", /mode: Smart/i);
	assert.equal(themeColors.at(-1), "thinkingHigh");

	await shortcut.handler(ctx as any);
	assert.deepEqual(getSelectedModel(), { provider: "openai-codex", model: "gpt-5.6-sol" });
	assert.equal(getThinkingLevel(), "xhigh");
	assert.match(notifications.at(-1)?.message ?? "", /Switched to Mode: Deep³/i);
	assert.match(statuses.at(-1)?.value ?? "", /mode: Deep³/i);
	assert.equal(themeColors.at(-1), "thinkingXhigh");

	await shortcut.handler(ctx as any);
	assert.deepEqual(getSelectedModel(), { provider: "openai-codex", model: "gpt-5.6-sol" });
	assert.equal(getThinkingLevel(), "max");
	assert.match(notifications.at(-1)?.message ?? "", /Switched to Mode: Max/i);
	assert.match(statuses.at(-1)?.value ?? "", /mode: Max/i);
	assert.equal(themeColors.at(-1), "thinkingMax");

	await shortcut.handler(ctx as any);
	assert.deepEqual(getSelectedModel(), { provider: "openai-codex", model: "gpt-5.6-sol" });
	assert.equal(getThinkingLevel(), "medium");
	assert.match(notifications.at(-1)?.message ?? "", /Switched to Mode: Fast/i);
	assert.match(statuses.at(-1)?.value ?? "", /mode: Fast/i);
	assert.equal(themeColors.at(-1), "thinkingMedium");
});

test("/fast /smart /deep /deep3 /max commands switch no-fallback Sol modes directly", async () => {
	const { commands, pi, getSelectedModel, getThinkingLevel } = createPiHarness();
	const { ctx, notifications } = createContext();

	workflowModesExtension(pi as any);

	const fastCommand = commands.get("fast");
	const smartCommand = commands.get("smart");
	const deepCommand = commands.get("deep");
	const deep3Command = commands.get("deep3");
	const maxCommand = commands.get("max");
	assert.ok(fastCommand);
	assert.ok(smartCommand);
	assert.ok(deepCommand);
	assert.ok(deep3Command);
	assert.ok(maxCommand);
	assert.equal(commands.has("deep1"), false);
	assert.equal(commands.has("deep2"), false);

	assert.match(fastCommand.description, /medium reasoning/i);
	assert.match(smartCommand.description, /high reasoning/i);
	assert.match(deepCommand.description, /xhigh reasoning/i);
	assert.match(deep3Command.description, /xhigh reasoning/i);
	assert.match(maxCommand.description, /max reasoning/i);

	await fastCommand.handler("", ctx as any);
	assert.deepEqual(getSelectedModel(), { provider: "openai-codex", model: "gpt-5.6-sol" });
	assert.equal(getThinkingLevel(), "medium");
	assert.match(notifications.at(-1)?.message ?? "", /Switched to Mode: Fast/i);

	await smartCommand.handler("", ctx as any);
	assert.deepEqual(getSelectedModel(), { provider: "openai-codex", model: "gpt-5.6-sol" });
	assert.equal(getThinkingLevel(), "high");
	assert.match(notifications.at(-1)?.message ?? "", /Switched to Mode: Smart/i);

	await deepCommand.handler("", ctx as any);
	assert.deepEqual(getSelectedModel(), { provider: "openai-codex", model: "gpt-5.6-sol" });
	assert.equal(getThinkingLevel(), "xhigh");
	assert.match(notifications.at(-1)?.message ?? "", /Switched to Mode: Deep³/i);

	await deep3Command.handler("", ctx as any);
	assert.deepEqual(getSelectedModel(), { provider: "openai-codex", model: "gpt-5.6-sol" });
	assert.equal(getThinkingLevel(), "xhigh");
	assert.match(notifications.at(-1)?.message ?? "", /Switched to Mode: Deep³/i);

	await maxCommand.handler("", ctx as any);
	assert.deepEqual(getSelectedModel(), { provider: "openai-codex", model: "gpt-5.6-sol" });
	assert.equal(getThinkingLevel(), "max");
	assert.match(notifications.at(-1)?.message ?? "", /Switched to Mode: Max/i);
});

test("modes do not fall back when GPT-5.6 Sol is unavailable", async () => {
	const { commands, pi, getSelectedModel, getThinkingLevel } = createPiHarness();
	const { ctx, notifications } = createContext({ availableModels: new Set(["openai-codex/gpt-5.5"]) });

	workflowModesExtension(pi as any);

	const fastCommand = commands.get("fast");
	assert.ok(fastCommand);

	await fastCommand.handler("", ctx as any);
	assert.equal(getSelectedModel(), undefined);
	assert.equal(getThinkingLevel(), "medium");
	assert.ok(notifications.some(({ message }) => /gpt-5\.6-sol.*not found/i.test(message)));
});

test("/mode command accepts aliases and rejects unknown values", async () => {
	const { commands, pi, getSelectedModel, getThinkingLevel } = createPiHarness();
	const { ctx, notifications } = createContext();

	workflowModesExtension(pi as any);

	const modeCommand = commands.get("mode");
	assert.ok(modeCommand);

	await modeCommand.handler("r", ctx as any);
	assert.deepEqual(getSelectedModel(), { provider: "openai-codex", model: "gpt-5.6-sol" });
	assert.equal(getThinkingLevel(), "medium");

	await modeCommand.handler("d", ctx as any);
	assert.equal(getThinkingLevel(), "xhigh");

	await modeCommand.handler("maximum", ctx as any);
	assert.equal(getThinkingLevel(), "max");

	await modeCommand.handler("deep2", ctx as any);
	assert.match(notifications.at(-1)?.message ?? "", /Unknown mode\. Use: fast, smart, deep3, or max/i);
});

test("/mode recommend reports archive-derived guidance without switching", async (t) => {
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-mode-recommend-"));
	t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
	appendArchiveRecord(fixture, {
		schemaVersion: 1,
		kind: "verification",
		timestamp: "2026-06-26T00:00:00.000Z",
		verification: { projectRoot: fixture, command: "bash scripts/verify.sh", status: "failed", trigger: "auto" },
	});

	const { commands, pi, getSelectedModel } = createPiHarness();
	const { ctx, notifications, editorTexts } = createContext();
	(ctx as any).cwd = fixture;
	workflowModesExtension(pi as any);

	const modeCommand = commands.get("mode");
	assert.ok(modeCommand);
	await modeCommand.handler("recommend", ctx as any);

	assert.equal(getSelectedModel(), undefined);
	assert.match(notifications.at(-1)?.message ?? "", /Recommended mode: Smart/i);
	assert.match(editorTexts.at(-1) ?? "", /Run \/smart to switch if you agree/);
});

test("session_start defaults to Fast with Sol medium", async () => {
	const { pi, eventHandlers, getSelectedModel, getThinkingLevel } = createPiHarness();
	const { ctx } = createContext();

	workflowModesExtension(pi as any);

	const sessionStart = eventHandlers.get("session_start");
	assert.ok(sessionStart);
	await sessionStart?.({}, ctx as any);

	assert.deepEqual(getSelectedModel(), { provider: "openai-codex", model: "gpt-5.6-sol" });
	assert.equal(getThinkingLevel(), "medium");
});

test("session_start applies workflow-mode flag and keeps edit/write tools active", async () => {
	const { pi, eventHandlers, getActiveTools, getSelectedModel, getThinkingLevel } = createPiHarness({ workflowMode: "fast" });
	const { ctx } = createContext();

	workflowModesExtension(pi as any);

	const sessionStart = eventHandlers.get("session_start");
	assert.ok(sessionStart);
	await sessionStart?.({}, ctx as any);

	assert.deepEqual(getSelectedModel(), { provider: "openai-codex", model: "gpt-5.6-sol" });
	assert.equal(getThinkingLevel(), "medium");
	assert.ok(getActiveTools().includes("edit"));
	assert.ok(getActiveTools().includes("write"));
	assert.ok(getActiveTools().includes("open_file"));
});

test("session_start preserves explicit CLI model selection", async () => {
	const originalArgv = process.argv;
	process.argv = [originalArgv[0] ?? "node", originalArgv[1] ?? "test", "--model", "openai-codex/gpt-5.5"];

	try {
		const { pi, eventHandlers, getActiveTools, getSelectedModel, getThinkingLevel } = createPiHarness();
		const { ctx } = createContext({ currentModel: { provider: "openai-codex", id: "gpt-5.5" } });

		workflowModesExtension(pi as any);

		const sessionStart = eventHandlers.get("session_start");
		assert.ok(sessionStart);
		await sessionStart?.({}, ctx as any);

		assert.equal(getSelectedModel(), undefined);
		assert.equal(getThinkingLevel(), undefined);
		assert.ok(getActiveTools().includes("edit"));
		assert.ok(getActiveTools().includes("write"));
		assert.ok(getActiveTools().includes("open_file"));
	} finally {
		process.argv = originalArgv;
	}
});

test("session_start infers Max status from an explicit Sol max selection", async () => {
	const originalArgv = process.argv;
	process.argv = [
		originalArgv[0] ?? "node",
		originalArgv[1] ?? "test",
		"--model",
		"openai-codex/gpt-5.6-sol",
		"--thinking",
		"max",
	];

	try {
		const { pi, eventHandlers, getSelectedModel, getThinkingLevel } = createPiHarness({ thinkingLevel: "max" });
		const { ctx, statuses } = createContext({ currentModel: { provider: "openai-codex", id: "gpt-5.6-sol" } });

		workflowModesExtension(pi as any);

		const sessionStart = eventHandlers.get("session_start");
		assert.ok(sessionStart);
		await sessionStart?.({}, ctx as any);

		assert.equal(getSelectedModel(), undefined);
		assert.equal(getThinkingLevel(), "max");
		assert.match(statuses.at(-1)?.value ?? "", /mode: Max/i);
	} finally {
		process.argv = originalArgv;
	}
});

test("session_start workflow-mode flag overrides explicit CLI model selection", async () => {
	const originalArgv = process.argv;
	process.argv = [originalArgv[0] ?? "node", originalArgv[1] ?? "test", "--model", "openai-codex/gpt-5.5"];

	try {
		const { pi, eventHandlers, getSelectedModel, getThinkingLevel } = createPiHarness({ workflowMode: "fast" });
		const { ctx } = createContext({ currentModel: { provider: "openai-codex", id: "gpt-5.5" } });

		workflowModesExtension(pi as any);

		const sessionStart = eventHandlers.get("session_start");
		assert.ok(sessionStart);
		await sessionStart?.({}, ctx as any);

		assert.deepEqual(getSelectedModel(), { provider: "openai-codex", model: "gpt-5.6-sol" });
		assert.equal(getThinkingLevel(), "medium");
	} finally {
		process.argv = originalArgv;
	}
});

test("legacy workflow behavior hooks are removed", () => {
	const { pi, eventHandlers } = createPiHarness();
	workflowModesExtension(pi as any);

	assert.equal(eventHandlers.has("before_agent_start"), false);
	assert.equal(eventHandlers.has("tool_call"), false);
	assert.equal(eventHandlers.has("input"), false);
	assert.equal(eventHandlers.has("session_shutdown"), true);
});
