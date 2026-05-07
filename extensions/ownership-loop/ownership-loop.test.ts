import test from "node:test";
import assert from "node:assert/strict";

import ownershipLoopExtension, {
	buildOwnPrompt,
	buildOwnershipCardPath,
	buildOwnershipStatus,
	buildOwnershipSystemPrompt,
	buildRememberPrompt,
	buildReownPrompt,
	normalizeOwnershipMode,
	normalizeOwnershipState,
	parseOwnershipMemoryReply,
	restoreOwnershipState,
	shouldBlockStrictWrite,
	shouldTrackToolCall,
	slugifyOwnershipTitle,
} from "./index.ts";

type Handler = (...args: any[]) => unknown;

function createHarness(entries: any[] = [], options?: { idle?: boolean }) {
	const commands = new Map<string, { description: string; handler: Handler }>();
	const eventHandlers = new Map<string, Handler>();
	const busHandlers = new Map<string, Handler>();
	const appended: Array<{ type: string; data: any }> = [];
	const sentUserMessages: Array<{ content: string; options?: any }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses: Array<{ key: string; value: string | undefined }> = [];
	let editorText = "";

	const pi = {
		registerCommand(name: string, definition: { description: string; handler: Handler }) {
			commands.set(name, definition);
		},
		on(name: string, handler: Handler) {
			eventHandlers.set(name, handler);
		},
		events: {
			on(name: string, handler: Handler) {
				busHandlers.set(name, handler);
			},
			emit() {},
		},
		appendEntry(type: string, data: any) {
			appended.push({ type, data });
		},
		sendUserMessage(content: string, options?: any) {
			sentUserMessages.push({ content, options });
		},
	};

	const ctx = {
		cwd: "/repo",
		hasUI: true,
		isIdle: () => options?.idle ?? true,
		ui: {
			setEditorText(text: string) {
				editorText = text;
			},
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
			setStatus(key: string, value: string | undefined) {
				statuses.push({ key, value });
			},
			theme: {
				fg(_color: string, text: string) {
					return text;
				},
			},
		},
		sessionManager: {
			getSessionId: () => "session-a",
			getEntries: () => entries,
		},
	};

	return {
		pi,
		ctx,
		commands,
		eventHandlers,
		busHandlers,
		appended,
		sentUserMessages,
		notifications,
		statuses,
		getEditorText: () => editorText,
	};
}

test("ownership defaults to passive idle when no session state exists", () => {
	const state = normalizeOwnershipState(undefined);

	assert.equal(state.active, true);
	assert.equal(state.mode, "passive");
	assert.equal(state.phase, "idle");
	assert.match(buildOwnershipStatus(state), /Ownership mode: passive/);
});

test("buildOwnPrompt creates an approval-gated initial story prompt", () => {
	const prompt = buildOwnPrompt("change workflow modes");

	assert.match(prompt, /Initial Change Story/i);
	assert.match(prompt, /Do not edit files yet/i);
	assert.match(prompt, /verification_plan/);
	assert.match(prompt, /Business\/workflow rule/i);
	assert.match(prompt, /Approval checkpoint/i);
	assert.match(prompt, /Do not implement until I approve/i);
});

test("buildReownPrompt compares story to diff and verification evidence", () => {
	const prompt = buildReownPrompt("workflow modes", {
		active: true,
		mode: "passive",
		task: "workflow modes",
		phase: "changes-detected",
		changedSinceStory: true,
		touchedPaths: ["extensions/workflow-modes/index.ts"],
	});

	assert.match(prompt, /git status\/diff/i);
	assert.match(prompt, /Initial Change Story/i);
	assert.match(prompt, /Business\/workflow rule now/i);
	assert.match(prompt, /Story comparison/i);
	assert.match(prompt, /planned-but-not-run/i);
	assert.match(prompt, /Ownership path/i);
	assert.match(prompt, /Memory recommendation/i);
	assert.match(prompt, /docs\/ownership\/workflow-modes\.md/);
	assert.match(prompt, /save it/);
	assert.match(prompt, /extensions\/workflow-modes\/index\.ts/);
});

test("ownership system prompt makes passive mode always-live without blocking", () => {
	const prompt = buildOwnershipSystemPrompt("passive", normalizeOwnershipState(undefined));

	assert.match(prompt, /Ownership loop is active/i);
	assert.match(prompt, /current flow → intended flow → proof/i);
	assert.match(prompt, /docs\/ownership\//i);
	assert.match(prompt, /search docs\/ownership\/ first/i);
	assert.match(prompt, /Passive mode: do not block execution/i);
});

test("ownership memory card prompt targets docs/ownership", () => {
	assert.equal(slugifyOwnershipTitle("Workflow Modes: Deep¹/Deep²"), "workflow-modes-deep-deep");
	assert.equal(buildOwnershipCardPath("Workflow Modes"), "docs/ownership/workflow-modes.md");
	const prompt = buildRememberPrompt("Workflow Modes", normalizeOwnershipState({ task: "Workflow Modes" }));

	assert.match(prompt, /docs\/ownership\/workflow-modes\.md/);
	assert.match(prompt, /semantic_search/i);
	assert.match(prompt, /How to explain it back/i);
});

test("parseOwnershipMemoryReply handles conversational memory decisions", () => {
	assert.deepEqual(parseOwnershipMemoryReply("save it"), { action: "save" });
	assert.deepEqual(parseOwnershipMemoryReply("remember this."), { action: "save" });
	assert.deepEqual(parseOwnershipMemoryReply("revise title: Workflow Modes"), { action: "save", title: "Workflow Modes" });
	assert.deepEqual(parseOwnershipMemoryReply("skip"), { action: "skip" });
	assert.equal(parseOwnershipMemoryReply("what changed?"), undefined);
});

test("restoreOwnershipState reads latest ownership-loop session entry", () => {
	const restored = restoreOwnershipState([
		{ type: "custom", customType: "ownership-loop", data: { active: true, mode: "passive", task: "old", phase: "story-requested" } },
		{ type: "custom", customType: "ownership-loop", data: { active: true, mode: "strict", task: "new", phase: "changes-detected", changedSinceStory: true } },
	]);

	assert.equal(restored.task, "new");
	assert.equal(restored.mode, "strict");
	assert.equal(restored.phase, "changes-detected");
	assert.equal(restored.changedSinceStory, true);
});

test("ownership commands start, approve, report, and stop session state", async () => {
	const harness = createHarness();
	ownershipLoopExtension(harness.pi as any);

	await harness.commands.get("own")?.handler("change workflow modes", harness.ctx as any);

	assert.equal(harness.appended.at(-1)?.type, "ownership-loop");
	assert.equal(harness.appended.at(-1)?.data.task, "change workflow modes");
	assert.equal(harness.appended.at(-1)?.data.phase, "story-requested");
	assert.match(harness.sentUserMessages.at(-1)?.content ?? "", /Initial Change Story/i);
	assert.match(harness.statuses.at(-1)?.value ?? "", /own: story/i);

	await harness.commands.get("own-approve")?.handler("", harness.ctx as any);
	assert.equal(harness.appended.at(-1)?.data.phase, "story-approved");
	assert.equal(harness.appended.at(-1)?.data.storyApproved, true);
	assert.match(harness.statuses.at(-1)?.value ?? "", /own: approved/i);

	await harness.commands.get("own-status")?.handler("", harness.ctx as any);
	assert.match(harness.getEditorText(), /Ownership loop: story-approved/i);

	await harness.commands.get("own-off")?.handler("", harness.ctx as any);
	assert.equal(harness.appended.at(-1)?.data.active, false);
	assert.equal(harness.appended.at(-1)?.data.mode, "off");
	assert.equal(harness.statuses.at(-1)?.value, undefined);
});

test("passive ownership queues re-own prompt after tracked edits even without /own", async () => {
	const harness = createHarness();
	ownershipLoopExtension(harness.pi as any);

	await harness.eventHandlers.get("tool_call")?.({ toolName: "edit", input: { path: "extensions/workflow-modes/index.ts" } }, harness.ctx as any);

	assert.equal(harness.appended.at(-1)?.data.mode, "passive");
	assert.equal(harness.appended.at(-1)?.data.phase, "changes-detected");
	assert.equal(harness.appended.at(-1)?.data.changedSinceStory, true);

	await harness.eventHandlers.get("agent_end")?.({}, harness.ctx as any);

	assert.equal(harness.appended.at(-1)?.data.phase, "reown-requested");
	assert.equal(harness.appended.at(-1)?.data.reownRequested, true);
	assert.equal(harness.appended.at(-1)?.data.memoryCardPending, true);
	assert.match(harness.sentUserMessages.at(-1)?.content ?? "", /re-own the completed change/i);
	assert.match(harness.sentUserMessages.at(-1)?.content ?? "", /If there was no Initial Change Story/i);
	assert.match(harness.sentUserMessages.at(-1)?.content ?? "", /save it/);
});

test("manual /reown prevents duplicate automatic re-own prompt until another edit", async () => {
	const harness = createHarness();
	ownershipLoopExtension(harness.pi as any);

	await harness.commands.get("own")?.handler("change workflow modes", harness.ctx as any);
	await harness.commands.get("reown")?.handler("workflow modes", harness.ctx as any);
	const messageCountAfterCommand = harness.sentUserMessages.length;

	await harness.eventHandlers.get("agent_end")?.({}, harness.ctx as any);
	assert.equal(harness.sentUserMessages.length, messageCountAfterCommand);
});

test("pending memory card can be saved conversationally without a slash command", async () => {
	const harness = createHarness();
	ownershipLoopExtension(harness.pi as any);

	await harness.commands.get("reown")?.handler("Workflow Modes", harness.ctx as any);
	assert.equal(harness.appended.at(-1)?.data.memoryCardPending, true);

	const result = await harness.eventHandlers.get("input")?.({ text: "save it", source: "interactive", images: [] }, harness.ctx as any) as any;

	assert.equal(result.action, "transform");
	assert.match(result.text, /Create an ownership memory card for: Workflow Modes/);
	assert.match(result.text, /docs\/ownership\/workflow-modes\.md/);
	assert.equal(harness.appended.at(-1)?.data.memoryCardPending, false);
	assert.equal(harness.appended.at(-1)?.data.memoryCardWriteRequested, true);
});

test("pending memory card can be skipped conversationally", async () => {
	const harness = createHarness();
	ownershipLoopExtension(harness.pi as any);

	await harness.commands.get("reown")?.handler("Workflow Modes", harness.ctx as any);
	const result = await harness.eventHandlers.get("input")?.({ text: "skip", source: "interactive", images: [] }, harness.ctx as any) as any;

	assert.equal(result.action, "handled");
	assert.equal(harness.appended.at(-1)?.data.memoryCardPending, false);
	assert.match(harness.notifications.at(-1)?.message ?? "", /skipped/i);
});

test("ownership card writes do not trigger another automatic re-own", async () => {
	const harness = createHarness();
	ownershipLoopExtension(harness.pi as any);

	await harness.commands.get("reown")?.handler("Workflow Modes", harness.ctx as any);
	await harness.eventHandlers.get("input")?.({ text: "save it", source: "interactive", images: [] }, harness.ctx as any);
	const messageCount = harness.sentUserMessages.length;

	await harness.eventHandlers.get("tool_call")?.({ toolName: "write", input: { path: "docs/ownership/workflow-modes.md" } }, harness.ctx as any);
	assert.equal(harness.appended.at(-1)?.data.memoryCardWriteObserved, true);

	await harness.eventHandlers.get("agent_end")?.({}, harness.ctx as any);
	assert.equal(harness.sentUserMessages.length, messageCount);
	assert.equal(harness.appended.at(-1)?.data.phase, "idle");
	assert.equal(harness.appended.at(-1)?.data.changedSinceStory, false);
});

test("ownership card writes are allowed in strict mode after conversational save", async () => {
	const harness = createHarness();
	ownershipLoopExtension(harness.pi as any);

	await harness.commands.get("own-mode")?.handler("strict", harness.ctx as any);
	await harness.commands.get("reown")?.handler("Workflow Modes", harness.ctx as any);
	await harness.eventHandlers.get("input")?.({ text: "save it", source: "interactive", images: [] }, harness.ctx as any);

	const allowed = await harness.eventHandlers.get("tool_call")?.({ toolName: "write", input: { path: "docs/ownership/workflow-modes.md" } }, harness.ctx as any);
	assert.equal(allowed, undefined);
	assert.equal(harness.appended.at(-1)?.data.memoryCardWriteObserved, true);
});

test("strict mode blocks writes until story approval", async () => {
	const harness = createHarness();
	ownershipLoopExtension(harness.pi as any);

	await harness.commands.get("own-mode")?.handler("strict", harness.ctx as any);
	const blocked = await harness.eventHandlers.get("tool_call")?.({ toolName: "edit", input: { path: "x.ts" } }, harness.ctx as any);
	assert.deepEqual(blocked, {
		block: true,
		reason: "Ownership strict mode blocks edit/write until an Initial Change Story is approved. Run /own <task>, review the story, then /own-approve.",
	});

	await harness.commands.get("own-approve")?.handler("", harness.ctx as any);
	const allowed = await harness.eventHandlers.get("tool_call")?.({ toolName: "edit", input: { path: "x.ts" } }, harness.ctx as any);
	assert.equal(allowed, undefined);
	assert.equal(harness.appended.at(-1)?.data.phase, "changes-detected");

	const secondAllowed = await harness.eventHandlers.get("tool_call")?.({ toolName: "write", input: { path: "y.ts" } }, harness.ctx as any);
	assert.equal(secondAllowed, undefined);
});

test("/own-mode handles missing and invalid inputs", async () => {
	const harness = createHarness();
	ownershipLoopExtension(harness.pi as any);

	await harness.commands.get("own-mode")?.handler("", harness.ctx as any);
	assert.match(harness.getEditorText(), /Usage: \/own-mode passive \| strict \| off/);

	await harness.commands.get("own-mode")?.handler("wat", harness.ctx as any);
	assert.match(harness.notifications.at(-1)?.message ?? "", /Unknown ownership mode/i);

	await harness.commands.get("own-mode")?.handler("off", harness.ctx as any);
	assert.equal(harness.appended.at(-1)?.data.mode, "off");
});

test("before_agent_start injects ownership guidance unless mode is off", async () => {
	const harness = createHarness();
	ownershipLoopExtension(harness.pi as any);

	const injected = await harness.eventHandlers.get("before_agent_start")?.({ systemPrompt: "Base", prompt: "Fix modes" }, harness.ctx as any);
	assert.match(injected.systemPrompt, /Base/);
	assert.match(injected.systemPrompt, /Ownership loop is active/);

	await harness.commands.get("own-mode")?.handler("off", harness.ctx as any);
	const offResult = await harness.eventHandlers.get("before_agent_start")?.({ systemPrompt: "Base", prompt: "Fix modes" }, harness.ctx as any);
	assert.equal(offResult, undefined);
});

test("/own-remember writes a memory-card prompt to the editor", async () => {
	const harness = createHarness();
	ownershipLoopExtension(harness.pi as any);

	await harness.commands.get("own-remember")?.handler("Workflow Modes", harness.ctx as any);

	assert.match(harness.getEditorText(), /Create an ownership memory card/i);
	assert.match(harness.getEditorText(), /docs\/ownership\/workflow-modes\.md/);
});

test("mode and tool helpers handle aliases and no-op cases", () => {
	assert.equal(normalizeOwnershipMode("auto"), "passive");
	assert.equal(normalizeOwnershipMode("strict"), "strict");
	assert.equal(normalizeOwnershipMode("disabled"), "off");
	assert.equal(normalizeOwnershipMode("unknown"), undefined);
	assert.equal(shouldTrackToolCall("read"), false);
	assert.equal(shouldTrackToolCall("bash"), false);
	assert.equal(shouldTrackToolCall("edit"), true);
	assert.equal(shouldTrackToolCall("write"), true);
	assert.equal(shouldBlockStrictWrite(normalizeOwnershipState({ mode: "strict", phase: "idle" }), "edit"), true);
	assert.equal(shouldBlockStrictWrite(normalizeOwnershipState({ mode: "strict", phase: "story-approved", storyApproved: true }), "edit"), false);
	assert.equal(buildOwnershipStatus(normalizeOwnershipState({ active: false, mode: "off" })), "Ownership loop: off");
});
