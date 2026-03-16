import test from "node:test";
import assert from "node:assert/strict";

import { matchesKey, setKittyProtocolActive } from "@mariozechner/pi-tui";

import workflowModesExtension, {
	detectExplicitModeFromPrompt,
	detectModeFromPrompt,
	isSafeDesignCommand,
	normalizeMode,
} from "../../extensions/workflow-modes.ts";

type ShortcutHandler = { description: string; handler: (...args: any[]) => unknown };
type PiEventHandler = (...args: any[]) => unknown;

function createPiHarness(options?: { flagMode?: string; tools?: Array<{ name: string }> }) {
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

function createContext() {
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

test("normalizeMode accepts documented aliases", () => {
	assert.equal(normalizeMode("design"), "design");
	assert.equal(normalizeMode("D"), "design");
	assert.equal(normalizeMode("implementation"), "implement");
	assert.equal(normalizeMode("build"), "implement");
	assert.equal(normalizeMode("unknown"), undefined);
});

test("detectExplicitModeFromPrompt handles explicit mode switch phrasing", () => {
	assert.equal(detectExplicitModeFromPrompt("switch to design mode"), "design");
	assert.equal(detectExplicitModeFromPrompt("change the mode to implement"), "implement");
	assert.equal(detectExplicitModeFromPrompt("mode: design"), "design");
	assert.equal(detectExplicitModeFromPrompt("implement: wire the handler"), "implement");
	assert.equal(detectExplicitModeFromPrompt("/mode design"), undefined);
});

test("detectModeFromPrompt recognizes conversational design and implement requests", () => {
	assert.equal(detectModeFromPrompt("Let's design a better solution before coding."), "design");
	assert.equal(detectModeFromPrompt("Please implement the fix and add the patch."), "implement");
	assert.equal(detectModeFromPrompt("Can you review the architecture options?"), "design");
	assert.equal(detectModeFromPrompt("Write the code and ship the patch."), "implement");
});

test("detectModeFromPrompt prioritizes explicit mode switches over generic keywords", () => {
	assert.equal(detectModeFromPrompt("change the mode to design"), "design");
	assert.equal(detectModeFromPrompt("switch workflow mode to implement"), "implement");
});

test("detectModeFromPrompt stays neutral for ambiguous requests", () => {
	assert.equal(detectModeFromPrompt("Please think about this."), undefined);
	assert.equal(detectModeFromPrompt("change the implementation details and compare options"), undefined);
});

test("design mode allows planning-safe repo commands but blocks destructive shell commands", () => {
	assert.equal(isSafeDesignCommand("cd /tmp/repo && git status"), true);
	assert.equal(isSafeDesignCommand('git add -A && git commit -m "docs" && git push'), false);
	assert.equal(isSafeDesignCommand("npm test"), true);
	assert.equal(isSafeDesignCommand("rm -rf .features"), false);
	assert.equal(isSafeDesignCommand("git checkout -b feature/design"), false);
	assert.equal(isSafeDesignCommand("printf 'hello' > notes.md"), false);
});

test("workflow-modes registers only ctrl+shift+m for cycling", () => {
	const { shortcuts, pi } = createPiHarness();

	workflowModesExtension(pi as any);

	const shortcut = shortcuts.get("ctrl+shift+m");

	assert.ok(shortcut);
	assert.equal(shortcut.description, "Cycle workflow mode (Design/Implement)");
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


test("ctrl+shift+m shortcut cycles from implement to design", async () => {
	const { shortcuts, pi, getSelectedModel, getThinkingLevel } = createPiHarness();
	const { ctx, notifications } = createContext();

	workflowModesExtension(pi as any);

	const shortcut = shortcuts.get("ctrl+shift+m");
	assert.ok(shortcut);

	await shortcut.handler(ctx as any);

	assert.deepEqual(getSelectedModel(), { provider: "anthropic", model: "claude-opus-4-6" });
	assert.equal(getThinkingLevel(), "xhigh");
	assert.match(notifications.at(-1)?.message ?? "", /Switched to Mode: Design/i);
});


test("/design and /implement commands switch modes directly", async () => {
	const { commands, pi, getSelectedModel, getThinkingLevel } = createPiHarness();
	const { ctx, notifications } = createContext();

	workflowModesExtension(pi as any);

	const designCommand = commands.get("design");
	const implementCommand = commands.get("implement");
	assert.ok(designCommand);
	assert.ok(implementCommand);

	await designCommand.handler("", ctx as any);
	assert.deepEqual(getSelectedModel(), { provider: "anthropic", model: "claude-opus-4-6" });
	assert.equal(getThinkingLevel(), "xhigh");
	assert.match(notifications.at(-1)?.message ?? "", /Switched to Mode: Design/i);

	await implementCommand.handler("", ctx as any);
	assert.deepEqual(getSelectedModel(), { provider: "openai-codex", model: "gpt-5.4" });
	assert.equal(getThinkingLevel(), "high");
	assert.match(notifications.at(-1)?.message ?? "", /Switched to Mode: Implement/i);
});

test("design mode keeps edit/write tools active for planning artifacts", async () => {
	const { pi, eventHandlers, getActiveTools, getSelectedModel, getThinkingLevel } = createPiHarness({ flagMode: "design" });
	const { ctx } = createContext();

	workflowModesExtension(pi as any);

	const sessionStart = eventHandlers.get("session_start");
	assert.ok(sessionStart);
	await sessionStart?.({}, ctx as any);

	assert.deepEqual(getSelectedModel(), { provider: "anthropic", model: "claude-opus-4-6" });
	assert.equal(getThinkingLevel(), "xhigh");
	assert.ok(getActiveTools().includes("edit"));
	assert.ok(getActiveTools().includes("write"));
	assert.ok(getActiveTools().includes("open_file"));

	const toolCall = eventHandlers.get("tool_call");
	assert.ok(toolCall);
	assert.equal(await toolCall?.({ toolName: "write", input: { path: ".features/test/prd.md", content: "# PRD" } }), undefined);
	assert.equal(
		await toolCall?.({ toolName: "edit", input: { path: ".features/test/prd.md", oldText: "PRD", newText: "Design" } }),
		undefined,
	);
	assert.deepEqual(await toolCall?.({ toolName: "bash", input: { command: "mkdir -p .features/test" } }), {
		block: true,
		reason: "Mode: Design allows read-only bash commands only. Blocked: mkdir -p .features/test",
	});
});

test("design mode prompt injection allows planning files but still avoids implementation", async () => {
	const { pi, eventHandlers } = createPiHarness({ flagMode: "design" });
	const { ctx } = createContext();

	workflowModesExtension(pi as any);
	await eventHandlers.get("session_start")?.({}, ctx as any);

	const beforeAgentStart = eventHandlers.get("before_agent_start");
	assert.ok(beforeAgentStart);
	const result = (await beforeAgentStart?.({
		prompt: "Create the PRD, technical design, research notes, and task files.",
		systemPrompt: "BASE SYSTEM",
	})) as {
		systemPrompt: string;
		message: { content: string };
	};

	assert.match(result.systemPrompt, /creating or updating planning files/i);
	assert.match(result.systemPrompt, /Do not implement product code changes/i);
	assert.match(result.message.content, /create or update planning artifacts when useful/i);
	assert.match(result.message.content, /avoid product code changes/i);
});
