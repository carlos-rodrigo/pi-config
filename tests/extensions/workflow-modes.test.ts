import test from "node:test";
import assert from "node:assert/strict";

import workflowModesExtension, {
	detectExplicitModeFromPrompt,
	detectModeFromPrompt,
	isSafeDesignCommand,
	normalizeMode,
} from "../../extensions/workflow-modes.ts";

type ShortcutHandler = { description: string; handler: (...args: any[]) => unknown };

function createPiHarness() {
	const shortcuts = new Map<string, ShortcutHandler>();
	return {
		shortcuts,
		pi: {
			registerFlag() {},
			registerShortcut(name: string, definition: ShortcutHandler) {
				shortcuts.set(name, definition);
			},
			registerCommand() {},
			on() {},
			events: {
				on() {},
				emit() {},
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
	assert.equal(isSafeDesignCommand("git add -A && git commit -m \"docs\" && git push"), false);
	assert.equal(isSafeDesignCommand("npm test"), true);
	assert.equal(isSafeDesignCommand("rm -rf .features"), false);
	assert.equal(isSafeDesignCommand("git checkout -b feature/design"), false);
	assert.equal(isSafeDesignCommand("printf 'hello' > notes.md"), false);
});

test("workflow-modes registers only ctrl+alt+m for cycle shortcut", () => {
	const { shortcuts, pi } = createPiHarness();

	workflowModesExtension(pi as any);

	const primaryShortcut = shortcuts.get("ctrl+alt+m");

	assert.ok(primaryShortcut);
	assert.equal(primaryShortcut.description, "Cycle workflow mode (Design/Implement)");
	assert.equal(shortcuts.has("ctrl+shift+m"), false);
	assert.equal(shortcuts.has("ctrl+tab"), false);
	assert.equal(shortcuts.has("ctrl+m"), false);
});
