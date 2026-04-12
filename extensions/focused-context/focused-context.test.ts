import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import focusedContextExtension, {
	buildFocusedCompactionSummary,
	createFocusedContextExtension,
	inferTopicFromTask,
	renderBriefEnsureText,
	serializeCompactionMessages,
} from "./index.ts";
import {collectRefreshSources, renderBriefDocument, refreshBrief, resolveRefreshModel} from "./brief-engine.ts";
import {computeStaleReasons, hasRepeatedExplorationLoop} from "./drift-monitor.ts";
import {renderLatestHandoffSource} from "./handoff-link.ts";
import {HANDOFF_SESSION_STARTED_EVENT} from "../handoff/events.ts";
import {findBriefByTopicOrAlias, loadBriefs, parseBriefDocument} from "./brief-store.ts";

type CommandDefinition = {description: string; handler: (...args: any[]) => unknown};
type EventHandler = (...args: any[]) => unknown;

function makeTempDir() {
	return mkdtempSync(join(tmpdir(), "pi-focused-context-test-"));
}

function writeBrief(dir: string, name: string, content: string) {
	mkdirSync(dir, {recursive: true});
	writeFileSync(join(dir, name), content, "utf8");
}

function sampleBrief(
	topic: string,
	title: string,
	sourceDetails?: {aliases?: string[]; updatedAt?: string; extraBody?: string},
) {
	const aliases = sourceDetails?.aliases ?? [];
	const updatedAt = sourceDetails?.updatedAt ?? "2026-04-10T00:00:00Z";
	const aliasLines = aliases.length > 0 ? `aliases:\n${aliases.map((alias) => `  - ${alias}`).join("\n")}` : "aliases:";
	return `---
topic: ${topic}
${aliasLines}
scope: project
updatedAt: ${updatedAt}
hotFiles:
  - src/${topic}.ts
hotDocs:
  - docs/${topic}.md
---
# ${title}

## Objective
${title} objective.

## Stable Facts
- Stable fact for ${topic}

## Hot Files
- src/${topic}.ts

## Common Commands
- npm test

## Gotchas
- Watch ${topic}

## Next Slice
Continue ${topic} work.

## Manual Notes
${sourceDetails?.extraBody ?? "Keep this note."}
`;
}

function createHarness(options?: {
	deps?: Parameters<typeof createFocusedContextExtension>[0];
}) {
	const commands = new Map<string, CommandDefinition>();
	const eventHandlers = new Map<string, EventHandler>();
	const tools = new Map<string, any>();
	const appendEntries: Array<{customType: string; data: unknown}> = [];
	const eventBusHandlers = new Map<string, ((data: unknown) => unknown)[]>();

	const extension = options?.deps ? createFocusedContextExtension(options.deps) : focusedContextExtension;
	extension({
		registerCommand(name: string, definition: CommandDefinition) {
			commands.set(name, definition);
		},
		registerTool(definition: any) {
			tools.set(definition.name, definition);
		},
		on(name: string, handler: EventHandler) {
			eventHandlers.set(name, handler);
		},
		appendEntry(customType: string, data: unknown) {
			appendEntries.push({customType, data});
		},
		events: {
			on(name: string, handler: (data: unknown) => unknown) {
				const handlers = eventBusHandlers.get(name) ?? [];
				handlers.push(handler);
				eventBusHandlers.set(name, handlers);
				return () => {};
			},
			emit(name: string, data: unknown) {
				for (const handler of eventBusHandlers.get(name) ?? []) {
					handler(data);
				}
			},
		},
	} as any);

	async function emitEvent(name: string, data: unknown) {
		for (const handler of eventBusHandlers.get(name) ?? []) {
			await handler(data);
		}
	}

	return {commands, eventHandlers, tools, appendEntries, emitEvent};
}

async function flushUiTimers() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function createCtx(
	cwd: string,
	options?: {
		entries?: any[];
		model?: {provider: string; id?: string; model?: string};
		modelRegistry?: any;
		sessionId?: string;
		sessionFile?: string;
		getBranch?: () => any[];
		getLeafId?: () => string;
	},
) {
	const editorTexts: string[] = [];
	const notifications: Array<{message: string; level: string}> = [];
	const statuses: Array<{key: string; value: string | undefined}> = [];

	return {
		editorTexts,
		notifications,
		statuses,
		ctx: {
			cwd,
			hasUI: true,
			model: options?.model,
			modelRegistry:
				options?.modelRegistry ??
				({
					find() {
						return undefined;
					},
					async getApiKeyForProvider() {
						return "test-key";
					},
				} as any),
			ui: {
				setEditorText(text: string) {
					editorTexts.push(text);
				},
				notify(message: string, level: string) {
					notifications.push({message, level});
				},
				setStatus(key: string, value: string | undefined) {
					statuses.push({key, value});
				},
				theme: {
					fg(_color: string, text: string) {
						return text;
					},
				},
			},
			sessionManager: {
				getEntries() {
					return options?.entries ?? [];
				},
				getSessionId() {
					return options?.sessionId ?? "session-1";
				},
				getSessionFile() {
					return options?.sessionFile;
				},
				getBranch() {
					return options?.getBranch ? options.getBranch() : [];
				},
				getLeafId() {
					return options?.getLeafId ? options.getLeafId() : "leaf-1";
				},
			},
		},
	};
}

test("parseBriefDocument reads required metadata from markdown frontmatter", () => {
	const parsed = parseBriefDocument(sampleBrief("billing", "Billing", {aliases: ["invoice-export"]}), "/tmp/billing.md", "project");
	assert.ok(parsed);
	assert.equal(parsed.topic, "billing");
	assert.deepEqual(parsed.aliases, ["invoice-export"]);
	assert.equal(parsed.source, "project");
	assert.equal(parsed.title, "Billing");
});

test("renderBriefDocument preserves the Manual Notes section while replacing generated sections", () => {
	const rendered = renderBriefDocument({
		topic: "billing",
		updatedAt: "2026-04-12T00:00:00Z",
		hotFiles: ["src/billing.ts"],
		hotDocs: ["docs/billing.md"],
		title: "Billing",
		existingBody: `# Billing\n\n## Objective\nOld objective\n\n## Manual Notes\nKeep this note intact.\n`,
		sections: {
			objective: "New objective.",
			stableFacts: "- Fact",
			hotFiles: "- src/billing.ts",
			commonCommands: "- npm test",
			gotchas: "- Watch out",
			openQuestions: "- None",
			nextSlice: "Refresh tests.",
		},
	});

	assert.match(rendered, /## Objective\nNew objective\./);
	assert.match(rendered, /## Manual Notes\nKeep this note intact\./);
	assert.doesNotMatch(rendered, /Old objective/);
});

test("resolveRefreshModel prefers a helper model when available", async () => {
	const result = await resolveRefreshModel({
		model: {provider: "anthropic", id: "claude-opus-4-5"},
		modelRegistry: {
			find(provider: string, model: string) {
				if (provider === "google" && model === "gemini-2.5-flash") return {provider, id: model};
				return undefined;
			},
			async getApiKeyForProvider(provider: string) {
				return provider === "google" ? "helper-key" : undefined;
			},
		},
	} as any);

	assert.deepEqual(result, {
		model: {provider: "google", id: "gemini-2.5-flash"},
		apiKey: "helper-key",
		source: "helper",
	});
});

test("resolveRefreshModel falls back to the active model when no helper model is usable", async () => {
	const result = await resolveRefreshModel({
		model: {provider: "anthropic", id: "claude-opus-4-5"},
		modelRegistry: {
			find() {
				return undefined;
			},
			async getApiKeyForProvider(provider: string) {
				return provider === "anthropic" ? "active-key" : undefined;
			},
		},
	} as any);

	assert.deepEqual(result, {
		model: {provider: "anthropic", id: "claude-opus-4-5"},
		apiKey: "active-key",
		source: "active",
	});
});

test("refreshBrief writes a new document, preserves manual notes, and records the refresh timestamp", async (t) => {
	const projectDir = makeTempDir();
	t.after(() => rmSync(projectDir, {recursive: true, force: true}));
	const briefDir = join(projectDir, ".pi", "briefs");
	writeBrief(briefDir, "billing.md", sampleBrief("billing", "Billing", {extraBody: "Do not lose this."}));
	const existing = parseBriefDocument(readFileSync(join(briefDir, "billing.md"), "utf8"), join(briefDir, "billing.md"), "project");
	assert.ok(existing);

	const result = await refreshBrief({
		ctx: {
			cwd: projectDir,
			model: {provider: "anthropic", id: "claude-opus-4-5"},
			modelRegistry: {
				find() {
					return undefined;
				},
				async getApiKeyForProvider() {
					return "test-key";
				},
			},
			sessionManager: {
				getEntries() {
					return [];
				},
			},
		} as any,
		topic: "billing",
		brief: existing!,
		now: new Date("2026-04-12T00:00:00Z"),
		completeFn: async () => ({
			stopReason: "stop",
			content: [
				{
					type: "text",
					text: `## Objective\nFresh objective.\n\n## Stable Facts\n- Stable fact\n\n## Hot Files\n- src/billing.ts\n\n## Common Commands\n- npm test\n\n## Gotchas\n- Edge case\n\n## Open Questions\n- None\n\n## Next Slice\nImplement the exporter.`,
				},
			],
		}) as any,
	});

	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.created, false);
	assert.equal(result.usedModel, "anthropic/claude-opus-4-5");
	assert.match(result.brief.raw, /updatedAt: 2026-04-12T00:00:00.000Z/);
	assert.match(result.brief.body, /## Manual Notes\nDo not lose this\./);
	assert.match(result.brief.body, /## Objective\nFresh objective\./);
});

test("inferTopicFromTask prefers existing brief aliases before deriving a new topic", () => {
	const briefs = [parseBriefDocument(sampleBrief("billing", "Billing", {aliases: ["invoice-export"]}), "/tmp/billing.md", "project")!];
	assert.equal(inferTopicFromTask("Implement invoice-export webhook handling", briefs), "billing");
});

test("inferTopicFromTask derives a slugged topic when no brief matches", () => {
	assert.equal(inferTopicFromTask("Investigate customer reference mapping", []), "customer-reference-mapping");
});

test("renderBriefEnsureText caps long output and reports truncation", () => {
	const hugeSection = Array.from({length: 20}, (_, index) => `- item ${index + 1}: ${"x".repeat(80)}`).join("\n");
	const brief = parseBriefDocument(
		renderBriefDocument({
			topic: "billing",
			updatedAt: "2026-04-12T00:00:00Z",
			title: "Billing",
			sections: {
				objective: "Long objective ".repeat(40),
				stableFacts: hugeSection,
				hotFiles: hugeSection,
				commonCommands: hugeSection,
				gotchas: hugeSection,
				openQuestions: hugeSection,
				nextSlice: "Continue billing work.",
			},
		}),
		"/tmp/billing.md",
		"project",
	)!;

	const rendered = renderBriefEnsureText({brief, action: "reused", freshness: "fresh", maxChars: 500});
	assert.ok(rendered.truncated);
	assert.ok(rendered.text.length <= 500);
	assert.match(rendered.text, /## Topic/);
	assert.match(rendered.text, /## Stable Facts/);
});

test("serializeCompactionMessages turns recent history into bounded readable text", () => {
	const text = serializeCompactionMessages([
		{role: "user", content: "Investigate billing exporter drift", timestamp: 1},
		{
			role: "assistant",
			content: [{type: "text", text: "I narrowed it down to src/billing.ts and exporter specs."}],
			timestamp: 2,
		},
	]);

	assert.match(text, /Investigate billing exporter drift/);
	assert.match(text, /src\/billing\.ts/);
});


test("buildFocusedCompactionSummary preserves durable brief context and recent delta", () => {
	const brief = parseBriefDocument(sampleBrief("billing", "Billing"), "/tmp/billing.md", "project")!;
	const summary = buildFocusedCompactionSummary({
		brief,
		reasons: ["R"],
		recentMessages: [
			{role: "user", content: "Add exporter coverage", timestamp: 1},
			{
				role: "assistant",
				content: [{type: "text", text: "Recent delta: touched billing specs and found a flaky edge case."}],
				timestamp: 2,
			},
		],
		previousSummary: "Previous summary: exporter work already started.",
		latestHandoffText: "Latest handoff context:\n- active topic: billing",
	});

	assert.match(summary, /## Durable Topic Context/);
	assert.match(summary, /selected: billing/);
	assert.match(summary, /## Previous Compaction Summary/);
	assert.match(summary, /Previous summary: exporter work already started/);
	assert.match(summary, /## Latest Handoff Context/);
	assert.match(summary, /active topic: billing/);
	assert.match(summary, /## Recent Delta/);
	assert.match(summary, /Add exporter coverage/);
	assert.doesNotMatch(summary, /## Manual Notes/);
});


test("computeStaleReasons returns ordered T/C/R/H markers", () => {
	assert.deepEqual(
		computeStaleReasons({
			turnsSinceRefresh: 3,
			changedHotPaths: ["src/billing.ts"],
			recentExplorationKeys: ["read:src/billing.ts", "read:src/billing.ts", "read:src/billing.ts"],
			topicTransitionCount: 1,
		}),
		["T", "C", "R", "H"],
	);
});

test("hasRepeatedExplorationLoop detects repeated reread windows", () => {
	assert.equal(
		hasRepeatedExplorationLoop([
			"read:src/billing.ts",
			"grep:.:*.ts:billing",
			"read:src/billing.ts",
			"read:src/billing.ts",
		]),
		true,
	);
	assert.equal(hasRepeatedExplorationLoop(["read:src/billing.ts", "grep:.:*.ts:billing"]), false);
});

test("loadBriefs prefers project-local briefs over global briefs with the same topic", async (t) => {
	const projectDir = makeTempDir();
	const globalDir = makeTempDir();
	const previousHome = process.env.HOME;
	process.env.HOME = globalDir;
	t.after(() => {
		process.env.HOME = previousHome;
		rmSync(projectDir, {recursive: true, force: true});
		rmSync(globalDir, {recursive: true, force: true});
	});

	writeBrief(join(globalDir, ".pi", "agent", "briefs"), "billing.md", sampleBrief("billing", "Global Billing"));
	writeBrief(join(globalDir, ".pi", "agent", "briefs"), "auth.md", sampleBrief("auth", "Global Auth"));
	writeBrief(join(projectDir, ".pi", "briefs"), "billing.md", sampleBrief("billing", "Project Billing"));

	const briefs = await loadBriefs(projectDir);

	assert.equal(briefs.length, 2);
	const billing = findBriefByTopicOrAlias(briefs, "billing");
	assert.ok(billing);
	assert.equal(billing.title, "Project Billing");
	assert.equal(billing.source, "project");
});

test("/brief-list writes available topics to the editor", async (t) => {
	const projectDir = makeTempDir();
	const globalDir = makeTempDir();
	const previousHome = process.env.HOME;
	process.env.HOME = globalDir;
	t.after(() => {
		process.env.HOME = previousHome;
		rmSync(projectDir, {recursive: true, force: true});
		rmSync(globalDir, {recursive: true, force: true});
	});

	writeBrief(join(projectDir, ".pi", "briefs"), "billing.md", sampleBrief("billing", "Billing", {aliases: ["invoice"]}));

	const {commands} = createHarness();
	const {ctx, editorTexts, notifications} = createCtx(projectDir);
	const command = commands.get("brief-list");
	assert.ok(command);

	await command.handler("", ctx as any);

	assert.match(editorTexts.at(-1) ?? "", /billing/);
	assert.match(editorTexts.at(-1) ?? "", /invoice/);
	assert.match(notifications.at(-1)?.message ?? "", /Listed 1 brief topic/);
});

test("/brief-pin persists canonical topic state and updates status", async (t) => {
	const projectDir = makeTempDir();
	const globalDir = makeTempDir();
	const previousHome = process.env.HOME;
	process.env.HOME = globalDir;
	t.after(() => {
		process.env.HOME = previousHome;
		rmSync(projectDir, {recursive: true, force: true});
		rmSync(globalDir, {recursive: true, force: true});
	});

	writeBrief(join(projectDir, ".pi", "briefs"), "billing.md", sampleBrief("billing", "Billing", {aliases: ["invoice-export"]}));

	const {commands, appendEntries} = createHarness();
	const {ctx, statuses, notifications} = createCtx(projectDir);
	const command = commands.get("brief-pin");
	assert.ok(command);

	await command.handler("invoice-export", ctx as any);

	assert.deepEqual(appendEntries.at(-1), {
		customType: "focused-context",
		data: {activeTopic: "billing", pinnedTopic: "billing"},
	});
	assert.deepEqual(statuses.at(-1), {key: "focused-context", value: "brief:billing · fresh"});
	assert.match(notifications.at(-1)?.message ?? "", /Pinned brief topic: billing/);
});

test("/brief-refresh uses the refresh engine result and updates the active topic state", async () => {
	const projectDir = makeTempDir();
	const {commands, appendEntries} = createHarness({
		deps: {
			refreshBriefForTopic: async ({topic}) => ({
				ok: true,
				created: true,
				usedModel: "google/gemini-2.5-flash",
				modelSource: "helper",
				brief: parseBriefDocument(sampleBrief(topic, "Billing"), join(projectDir, ".pi", "briefs", `${topic}.md`), "project")!,
			}),
		},
	});
	const {ctx, editorTexts, notifications, statuses} = createCtx(projectDir);
	const command = commands.get("brief-refresh");
	assert.ok(command);

	await command.handler("billing", ctx as any);

	assert.deepEqual(appendEntries.at(-1), {
		customType: "focused-context",
		data: {activeTopic: "billing", pinnedTopic: undefined},
	});
	assert.match(editorTexts.at(-1) ?? "", /# Brief: Billing/);
	assert.deepEqual(statuses.at(-1), {key: "focused-context", value: "brief:billing · fresh"});
	assert.match(notifications.at(-1)?.message ?? "", /Created brief for billing using google\/gemini-2.5-flash/);
	rmSync(projectDir, {recursive: true, force: true});
});

test("brief_ensure is registered, validates input, and returns structured errors", async () => {
	const projectDir = makeTempDir();
	const {tools} = createHarness();
	const tool = tools.get("brief_ensure");
	assert.ok(tool);
	const {ctx} = createCtx(projectDir);

	const emptyTask = await tool.execute("tool-call-1", {task: "   "}, undefined, undefined, ctx as any);
	assert.match(emptyTask.content[0].text, /task parameter is required/i);
	assert.equal(emptyTask.details.error, true);

	const invalidRefresh = await tool.execute(
		"tool-call-2",
		{task: "Implement billing export", refresh: "sometimes"},
		undefined,
		undefined,
		ctx as any,
	);
	assert.match(invalidRefresh.content[0].text, /refresh must be one of/i);
	assert.equal(invalidRefresh.details.error, true);

	rmSync(projectDir, {recursive: true, force: true});
});

test("brief_ensure reuses a fresh brief on if_stale without calling refresh", async (t) => {
	const projectDir = makeTempDir();
	const globalDir = makeTempDir();
	const previousHome = process.env.HOME;
	process.env.HOME = globalDir;
	t.after(() => {
		process.env.HOME = previousHome;
		rmSync(projectDir, {recursive: true, force: true});
		rmSync(globalDir, {recursive: true, force: true});
	});
	writeBrief(join(projectDir, ".pi", "briefs"), "billing.md", sampleBrief("billing", "Billing", {aliases: ["invoice-export"]}));

	let refreshCalls = 0;
	const {tools, appendEntries} = createHarness({
		deps: {
			refreshBriefForTopic: async () => {
				refreshCalls += 1;
				return {ok: false, error: "refresh should not be called"};
			},
		},
	});
	const tool = tools.get("brief_ensure");
	assert.ok(tool);
	const {ctx, statuses} = createCtx(projectDir);

	const result = await tool.execute(
		"tool-call-1",
		{task: "Implement invoice-export webhook handling", refresh: "if_stale"},
		undefined,
		undefined,
		ctx as any,
	);

	assert.equal(refreshCalls, 0);
	assert.equal(result.details.action, "reused");
	assert.equal(result.details.topic, "billing");
	assert.match(result.content[0].text, /selected: billing/);
	assert.deepEqual(appendEntries.at(-1), {
		customType: "focused-context",
		data: {activeTopic: "billing", pinnedTopic: undefined},
	});
	assert.deepEqual(statuses.at(-1), {key: "focused-context", value: "brief:billing · fresh"});
});

test("brief_ensure refreshes or creates a brief when policy requires it", async () => {
	const projectDir = makeTempDir();
	let refreshCalls: Array<{topic: string; hasBrief: boolean}> = [];
	const {tools, appendEntries} = createHarness({
		deps: {
			refreshBriefForTopic: async ({topic, brief}) => {
				refreshCalls.push({topic, hasBrief: Boolean(brief)});
				return {
					ok: true,
					created: !brief,
					usedModel: "google/gemini-2.5-flash",
					modelSource: "helper",
					brief: parseBriefDocument(sampleBrief(topic, "Billing"), join(projectDir, ".pi", "briefs", `${topic}.md`), "project")!,
				};
			},
		},
	});
	const tool = tools.get("brief_ensure");
	assert.ok(tool);
	const {ctx} = createCtx(projectDir);

	const result = await tool.execute(
		"tool-call-1",
		{task: "Build billing exporter", topic: "billing", refresh: "always"},
		undefined,
		undefined,
		ctx as any,
	);

	assert.deepEqual(refreshCalls, [{topic: "billing", hasBrief: false}]);
	assert.equal(result.details.action, "created");
	assert.equal(result.details.usedModel, "google/gemini-2.5-flash");
	assert.equal(result.details.modelSource, "helper");
	assert.deepEqual(appendEntries.at(-1), {
		customType: "focused-context",
		data: {activeTopic: "billing", pinnedTopic: undefined},
	});
	rmSync(projectDir, {recursive: true, force: true});
});

test("automatic topic preparation injects a compact brief slice for a clear match", async (t) => {
	const projectDir = makeTempDir();
	const globalDir = makeTempDir();
	const previousHome = process.env.HOME;
	process.env.HOME = globalDir;
	t.after(() => {
		process.env.HOME = previousHome;
		rmSync(projectDir, {recursive: true, force: true});
		rmSync(globalDir, {recursive: true, force: true});
	});
	writeBrief(join(projectDir, ".pi", "briefs"), "billing.md", sampleBrief("billing", "Billing", {aliases: ["invoice-export"]}));

	const {eventHandlers, appendEntries} = createHarness();
	const input = eventHandlers.get("input");
	const beforeAgentStart = eventHandlers.get("before_agent_start");
	const context = eventHandlers.get("context");
	const turnEnd = eventHandlers.get("turn_end");
	assert.ok(input);
	assert.ok(beforeAgentStart);
	assert.ok(context);
	assert.ok(turnEnd);
	const {ctx, statuses} = createCtx(projectDir);

	const inputResult = await input({text: "Implement invoice-export webhook handling", source: "interactive"}, ctx as any);
	assert.deepEqual(inputResult, {action: "continue"});
	await beforeAgentStart({prompt: "Implement invoice-export webhook handling"}, ctx as any);

	const contextResult = await context({messages: [{role: "user", content: "Implement invoice-export webhook handling", timestamp: 1}]}, ctx as any);
	assert.ok(contextResult);
	const injected = contextResult.messages.at(-1);
	assert.equal(injected.role, "custom");
	assert.equal(injected.customType, "focused-context-brief");
	assert.match(injected.content, /selected: billing/);
	assert.match(injected.content, /## Stable Facts/);
	assert.doesNotMatch(injected.content, /## Manual Notes/);
	assert.deepEqual(statuses.at(-1), {key: "focused-context", value: "brief:billing · fresh"});
	assert.deepEqual(appendEntries.at(-1), {
		customType: "focused-context",
		data: {activeTopic: "billing", pinnedTopic: undefined},
	});

	await turnEnd({}, ctx as any);
	const afterTurn = await context({messages: []}, ctx as any);
	assert.equal(afterTurn, undefined);
});


test("automatic topic preparation stays inactive for ambiguous matches", async (t) => {
	const projectDir = makeTempDir();
	const globalDir = makeTempDir();
	const previousHome = process.env.HOME;
	process.env.HOME = globalDir;
	t.after(() => {
		process.env.HOME = previousHome;
		rmSync(projectDir, {recursive: true, force: true});
		rmSync(globalDir, {recursive: true, force: true});
	});
	writeBrief(join(projectDir, ".pi", "briefs"), "billing.md", sampleBrief("billing", "Billing", {aliases: ["export"]}));
	writeBrief(join(projectDir, ".pi", "briefs"), "auth.md", sampleBrief("auth", "Auth", {aliases: ["export"]}));

	let refreshCalls = 0;
	const {eventHandlers, appendEntries} = createHarness({
		deps: {
			refreshBriefForTopic: async () => {
				refreshCalls += 1;
				return {ok: false, error: "should not refresh"};
			},
		},
	});
	const input = eventHandlers.get("input");
	const beforeAgentStart = eventHandlers.get("before_agent_start");
	const context = eventHandlers.get("context");
	assert.ok(input);
	assert.ok(beforeAgentStart);
	assert.ok(context);
	const {ctx} = createCtx(projectDir);

	await input({text: "Implement export", source: "interactive"}, ctx as any);
	await beforeAgentStart({prompt: "Implement export"}, ctx as any);
	const contextResult = await context({messages: []}, ctx as any);

	assert.equal(refreshCalls, 0);
	assert.equal(contextResult, undefined);
	assert.equal(appendEntries.length, 0);
});


test("pinned topic takes precedence over automatic matching", async (t) => {
	const projectDir = makeTempDir();
	const globalDir = makeTempDir();
	const previousHome = process.env.HOME;
	process.env.HOME = globalDir;
	t.after(() => {
		process.env.HOME = previousHome;
		rmSync(projectDir, {recursive: true, force: true});
		rmSync(globalDir, {recursive: true, force: true});
	});
	writeBrief(join(projectDir, ".pi", "briefs"), "billing.md", sampleBrief("billing", "Billing"));
	writeBrief(join(projectDir, ".pi", "briefs"), "auth.md", sampleBrief("auth", "Auth"));

	const {eventHandlers} = createHarness();
	const input = eventHandlers.get("input");
	const beforeAgentStart = eventHandlers.get("before_agent_start");
	const context = eventHandlers.get("context");
	assert.ok(input);
	assert.ok(beforeAgentStart);
	assert.ok(context);
	const {ctx} = createCtx(projectDir, {
		entries: [
			{
				type: "custom",
				customType: "focused-context",
				data: {activeTopic: "billing", pinnedTopic: "billing"},
			},
		],
	});

	await eventHandlers.get("session_start")!({}, ctx as any);
	await input({text: "Investigate auth issue", source: "interactive"}, ctx as any);
	await beforeAgentStart({prompt: "Investigate auth issue"}, ctx as any);
	const contextResult = await context({messages: []}, ctx as any);

	assert.ok(contextResult);
	assert.match(contextResult.messages.at(-1).content, /selected: billing/);
});


test("hot-file edits mark the active brief stale with C", async (t) => {
	const projectDir = makeTempDir();
	const globalDir = makeTempDir();
	const previousHome = process.env.HOME;
	process.env.HOME = globalDir;
	t.after(() => {
		process.env.HOME = previousHome;
		rmSync(projectDir, {recursive: true, force: true});
		rmSync(globalDir, {recursive: true, force: true});
	});
	writeBrief(join(projectDir, ".pi", "briefs"), "billing.md", sampleBrief("billing", "Billing"));

	const {eventHandlers} = createHarness();
	const sessionStart = eventHandlers.get("session_start");
	const toolCall = eventHandlers.get("tool_call");
	assert.ok(sessionStart);
	assert.ok(toolCall);
	const {ctx, statuses} = createCtx(projectDir, {
		entries: [
			{
				type: "custom",
				customType: "focused-context",
				data: {activeTopic: "billing", pinnedTopic: undefined},
			},
		],
	});

	await sessionStart({}, ctx as any);
	await toolCall({toolName: "edit", input: {path: "src/billing.ts"}}, ctx as any);

	assert.deepEqual(statuses.at(-1), {key: "focused-context", value: "brief:billing · stale:C"});
});


test("repeated exploration loops recommend a fresh session only once per drift window", async (t) => {
	const projectDir = makeTempDir();
	const globalDir = makeTempDir();
	const previousHome = process.env.HOME;
	process.env.HOME = globalDir;
	t.after(() => {
		process.env.HOME = previousHome;
		rmSync(projectDir, {recursive: true, force: true});
		rmSync(globalDir, {recursive: true, force: true});
	});
	writeBrief(join(projectDir, ".pi", "briefs"), "billing.md", sampleBrief("billing", "Billing"));

	const {eventHandlers} = createHarness();
	const sessionStart = eventHandlers.get("session_start");
	const toolCall = eventHandlers.get("tool_call");
	const turnEnd = eventHandlers.get("turn_end");
	assert.ok(sessionStart);
	assert.ok(toolCall);
	assert.ok(turnEnd);
	const {ctx, editorTexts, notifications, statuses} = createCtx(projectDir, {
		entries: [
			{
				type: "custom",
				customType: "focused-context",
				data: {activeTopic: "billing", pinnedTopic: undefined},
			},
		],
	});

	await sessionStart({}, ctx as any);
	await toolCall({toolName: "read", input: {path: "src/billing.ts"}}, ctx as any);
	await toolCall({toolName: "read", input: {path: "src/billing.ts"}}, ctx as any);
	await toolCall({toolName: "read", input: {path: "src/billing.ts"}}, ctx as any);
	await turnEnd({}, ctx as any);
	await flushUiTimers();

	assert.deepEqual(statuses.at(-1), {key: "focused-context", value: "brief:billing · stale:R · new-session?"});
	assert.match(editorTexts.at(-1) ?? "", /^\/handoff Continue billing in a fresh session\./);
	assert.match(notifications.at(-1)?.message ?? "", /Fresh session recommended for billing/);
	const editorCountAfterFirstRecommendation = editorTexts.length;
	const notificationCountAfterFirstRecommendation = notifications.length;

	await toolCall({toolName: "read", input: {path: "src/billing.ts"}}, ctx as any);
	await turnEnd({}, ctx as any);
	await flushUiTimers();

	assert.equal(editorTexts.length, editorCountAfterFirstRecommendation);
	assert.equal(notifications.length, notificationCountAfterFirstRecommendation);
});


test("collectRefreshSources includes latest handoff context as an automatic bounded source", async () => {
	const sources = await collectRefreshSources({
		cwd: "/tmp",
		latestHandoffText: renderLatestHandoffSource({
			mode: "command",
			activeTopic: "billing",
			previousSessionFile: "/tmp/old.jsonl",
			nextSessionFile: "/tmp/new.jsonl",
			capturedAt: "2026-04-10T00:00:00.000Z",
			promptText: "Continue billing with the exporter tests.",
		}),
	});

	assert.equal(sources.length, 1);
	assert.equal(sources[0].label, "latest-handoff");
	assert.match(sources[0].content, /Latest handoff context/);
	assert.match(sources[0].content, /Continue billing with the exporter tests/);
});


test("session_before_compact keeps the active brief in a durable compaction summary", async (t) => {
	const projectDir = makeTempDir();
	const globalDir = makeTempDir();
	const previousHome = process.env.HOME;
	process.env.HOME = globalDir;
	t.after(() => {
		process.env.HOME = previousHome;
		rmSync(projectDir, {recursive: true, force: true});
		rmSync(globalDir, {recursive: true, force: true});
	});
	writeBrief(join(projectDir, ".pi", "briefs"), "billing.md", sampleBrief("billing", "Billing"));

	const {eventHandlers} = createHarness();
	const sessionStart = eventHandlers.get("session_start");
	const beforeCompact = eventHandlers.get("session_before_compact");
	assert.ok(sessionStart);
	assert.ok(beforeCompact);
	const {ctx} = createCtx(projectDir, {
		entries: [
			{
				type: "custom",
				customType: "focused-context",
				data: {activeTopic: "billing", pinnedTopic: undefined},
			},
		],
	});

	await sessionStart({}, ctx as any);
	const result = await beforeCompact(
		{
			preparation: {
				messagesToSummarize: [
					{role: "user", content: "Add exporter specs", timestamp: 1},
					{
						role: "assistant",
						content: [{type: "text", text: "I updated the billing exporter tests and found a flaky edge case."}],
						timestamp: 2,
					},
				],
				turnPrefixMessages: [],
				previousSummary: "Previous summary: billing export path is partially covered.",
				firstKeptEntryId: "entry-42",
				tokensBefore: 1234,
			},
			customInstructions: "Focus on the latest exporter delta",
		},
		ctx as any,
	);

	assert.equal(result.compaction.firstKeptEntryId, "entry-42");
	assert.equal(result.compaction.tokensBefore, 1234);
	assert.equal(result.compaction.details.activeTopic, "billing");
	assert.match(result.compaction.summary, /## Durable Topic Context/);
	assert.match(result.compaction.summary, /selected: billing/);
	assert.match(result.compaction.summary, /## Previous Compaction Summary/);
	assert.match(result.compaction.summary, /partially covered/);
	assert.match(result.compaction.summary, /## Recent Delta/);
	assert.match(result.compaction.summary, /Add exporter specs/);
	assert.match(result.compaction.summary, /Focus on the latest exporter delta/);
});


test("handoff event restores the active topic into the next session", async (t) => {
	const projectDir = makeTempDir();
	const globalDir = makeTempDir();
	const previousHome = process.env.HOME;
	process.env.HOME = globalDir;
	t.after(() => {
		process.env.HOME = previousHome;
		rmSync(projectDir, {recursive: true, force: true});
		rmSync(globalDir, {recursive: true, force: true});
	});
	writeBrief(join(projectDir, ".pi", "briefs"), "billing.md", sampleBrief("billing", "Billing"));

	const {eventHandlers, appendEntries, emitEvent} = createHarness();
	const sessionStart = eventHandlers.get("session_start");
	const sessionSwitch = eventHandlers.get("session_switch");
	assert.ok(sessionStart);
	assert.ok(sessionSwitch);

	const oldSessionFile = "/tmp/focused-context-old.jsonl";
	const newSessionFile = "/tmp/focused-context-new.jsonl";
	const oldCtxBundle = createCtx(projectDir, {
		entries: [
			{
				type: "custom",
				customType: "focused-context",
				data: {activeTopic: "billing", pinnedTopic: undefined},
			},
		],
		sessionId: "session-old",
		sessionFile: oldSessionFile,
		getBranch() {
			throw new Error("restore should not inspect deep history");
		},
	});
	await sessionStart({}, oldCtxBundle.ctx as any);

	const newCtxBundle = createCtx(projectDir, {
		entries: [],
		sessionId: "session-new",
		sessionFile: newSessionFile,
		getBranch() {
			throw new Error("restore should not inspect deep history");
		},
	});
	await sessionSwitch({}, newCtxBundle.ctx as any);
	await emitEvent(HANDOFF_SESSION_STARTED_EVENT, {
		mode: "command",
		previousSessionFile: oldSessionFile,
		parentSessionFile: oldSessionFile,
		nextSessionFile: newSessionFile,
		nextSessionId: "session-new",
	});

	assert.deepEqual(newCtxBundle.statuses.at(-1), {key: "focused-context", value: "brief:billing · fresh"});
	const latestEntry = appendEntries.at(-1);
	assert.equal(latestEntry?.customType, "focused-context");
	assert.equal((latestEntry?.data as any).activeTopic, "billing");
	assert.equal((latestEntry?.data as any).latestHandoff.activeTopic, "billing");
	assert.equal((latestEntry?.data as any).latestHandoff.previousSessionFile, oldSessionFile);
	assert.equal((latestEntry?.data as any).latestHandoff.nextSessionId, "session-new");
});


test("refresh uses the latest handoff prompt as an automatic source in the new session", async (t) => {
	const projectDir = makeTempDir();
	const globalDir = makeTempDir();
	const previousHome = process.env.HOME;
	process.env.HOME = globalDir;
	t.after(() => {
		process.env.HOME = previousHome;
		rmSync(projectDir, {recursive: true, force: true});
		rmSync(globalDir, {recursive: true, force: true});
	});
	writeBrief(join(projectDir, ".pi", "briefs"), "billing.md", sampleBrief("billing", "Billing"));

	let capturedLatestHandoffText = "";
	const {eventHandlers, tools, emitEvent} = createHarness({
		deps: {
			refreshBriefForTopic: async ({topic, latestHandoffText}) => {
				capturedLatestHandoffText = latestHandoffText ?? "";
				return {
					ok: true,
					created: false,
					usedModel: "google/gemini-2.5-flash",
					modelSource: "helper",
					brief: parseBriefDocument(sampleBrief(topic, "Billing"), join(projectDir, ".pi", "briefs", `${topic}.md`), "project")!,
				};
			},
		},
	});
	const sessionStart = eventHandlers.get("session_start");
	const sessionSwitch = eventHandlers.get("session_switch");
	const input = eventHandlers.get("input");
	assert.ok(sessionStart);
	assert.ok(sessionSwitch);
	assert.ok(input);

	const oldSessionFile = "/tmp/focused-context-old.jsonl";
	const newSessionFile = "/tmp/focused-context-new.jsonl";
	const oldCtxBundle = createCtx(projectDir, {
		entries: [
			{
				type: "custom",
				customType: "focused-context",
				data: {activeTopic: "billing", pinnedTopic: undefined},
			},
		],
		sessionId: "session-old",
		sessionFile: oldSessionFile,
	});
	await sessionStart({}, oldCtxBundle.ctx as any);

	const newCtxBundle = createCtx(projectDir, {
		entries: [],
		sessionId: "session-new",
		sessionFile: newSessionFile,
	});
	await sessionSwitch({}, newCtxBundle.ctx as any);
	await emitEvent(HANDOFF_SESSION_STARTED_EVENT, {
		mode: "command",
		previousSessionFile: oldSessionFile,
		parentSessionFile: oldSessionFile,
		nextSessionFile: newSessionFile,
		nextSessionId: "session-new",
	});

	await input({text: "Continue billing work. Validate the exporter and close the remaining test gap.", source: "interactive"}, newCtxBundle.ctx as any);
	const tool = tools.get("brief_ensure");
	assert.ok(tool);
	await tool.execute(
		"tool-call-1",
		{task: "Continue billing work", topic: "billing", refresh: "always"},
		undefined,
		undefined,
		newCtxBundle.ctx as any,
	);

	assert.match(capturedLatestHandoffText, /Latest handoff context/);
	assert.match(capturedLatestHandoffText, /active topic: billing/);
	assert.match(capturedLatestHandoffText, /Submitted handoff prompt/);
	assert.match(capturedLatestHandoffText, /Validate the exporter/);
	assert.doesNotMatch(capturedLatestHandoffText, /Ancestor sessions/);
});


test("session_start restores pinned state from session entries and republishes status", async (t) => {
	const projectDir = makeTempDir();
	const globalDir = makeTempDir();
	const previousHome = process.env.HOME;
	process.env.HOME = globalDir;
	t.after(() => {
		process.env.HOME = previousHome;
		rmSync(projectDir, {recursive: true, force: true});
		rmSync(globalDir, {recursive: true, force: true});
	});

	writeBrief(join(projectDir, ".pi", "briefs"), "billing.md", sampleBrief("billing", "Billing"));

	const {eventHandlers} = createHarness();
	const sessionStart = eventHandlers.get("session_start");
	assert.ok(sessionStart);

	const {ctx, statuses} = createCtx(projectDir, {
		entries: [
			{
				type: "custom",
				customType: "focused-context",
				data: {activeTopic: "billing", pinnedTopic: "billing"},
			},
		],
	});

	await sessionStart({}, ctx as any);

	assert.deepEqual(statuses.at(-1), {key: "focused-context", value: "brief:billing · fresh"});
});

test("/brief shows a clear warning when no active topic is available", async () => {
	const projectDir = makeTempDir();
	const {commands} = createHarness();
	const {ctx, notifications} = createCtx(projectDir);
	const command = commands.get("brief");
	assert.ok(command);

	await command.handler("", ctx as any);

	assert.match(notifications.at(-1)?.message ?? "", /No active brief/);
	rmSync(projectDir, {recursive: true, force: true});
});
