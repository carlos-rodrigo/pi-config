import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import borderedEditor, {
	formatBottomLeftUsage,
	formatTokenCount,
	getAssistantUsageTotals,
	pickPrimaryExtensionStatus,
} from "./index.ts";

test("pickPrimaryExtensionStatus prefers foreground semantic search over ambient statuses", () => {
	const statuses = new Map<string, string>([
		["prompt-queue", "queue: 2 queued"],
		["semantic-search", "searching…"],
	]);

	assert.equal(pickPrimaryExtensionStatus(statuses), "searching…");
});

test("pickPrimaryExtensionStatus prefers review over prompt queue", () => {
	const statuses = new Map<string, string>([
		["review", "reviewing"],
		["prompt-queue", "queue: 2 queued"],
	]);

	assert.equal(pickPrimaryExtensionStatus(statuses), "reviewing");
});

test("pickPrimaryExtensionStatus avoids duplicating mode and background index state", () => {
	const statuses = new Map<string, string>([
		["workflow-mode", "mode: Deep"],
		["semantic-search", "idx: embedding 60% · ~11s"],
	]);

	assert.equal(pickPrimaryExtensionStatus(statuses), null);
});

test("pickPrimaryExtensionStatus still surfaces foreground semantic search status", () => {
	const statuses = new Map<string, string>([
		["workflow-mode", "mode: Smart"],
		["semantic-search", "embedding…"],
	]);

	assert.equal(pickPrimaryExtensionStatus(statuses), "embedding…");
});

test("pickPrimaryExtensionStatus omits mode metadata from the bottom border", () => {
	assert.equal(pickPrimaryExtensionStatus(new Map<string, string>([["workflow-mode", "mode: Smart"]])), null);
	assert.equal(pickPrimaryExtensionStatus(new Map()), null);
});

test("pickPrimaryExtensionStatus prefers prompt queue over ambient mode status", () => {
	assert.equal(
		pickPrimaryExtensionStatus(new Map<string, string>([
			["workflow-mode", "mode: Smart"],
			["prompt-queue", "queue: 2 queued"],
		])),
		"queue: 2 queued",
	);
});

test("composer restores workflow mode, live model and effort while preserving operational chrome", async () => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const events = new EventEmitter();
	let editorFactory: ((tui: unknown, theme: unknown, keybindings: unknown) => { render: (width: number) => string[] }) | undefined;
	let thinking = "xhigh";
	events.on("workflow:request-mode", () => events.emit("workflow:mode", { mode: "deep", label: "Deep" }));
	borderedEditor({
		getThinkingLevel: () => thinking,
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
		events,
	} as never);
	const theme = { borderColor: (text: string) => text, bold: (text: string) => text, fg: (_color: string, text: string) => text };
	const ctx = {
		cwd: "/tmp/project",
		model: { id: "gpt-6-astra", name: "GPT-6 Astra" },
		getContextUsage: () => ({ percent: 25, tokens: 10, contextWindow: 200_000 }),
		sessionManager: { getBranch: () => [] },
		ui: {
			theme,
			setFooter: () => {},
			setEditorComponent: (factory: typeof editorFactory) => { editorFactory = factory; },
		},
	} as unknown as ExtensionContext;
	events.emit("agent-jobs:running-count", { count: 2 });
	events.emit("loop-jobs:running-count", { count: 3 });
	events.emit("semantic-search:rebuild-status", { indicator: "idx: embedding 60% · ~11s" });
	await handlers.get("session_start")!({}, ctx);
	const editor = editorFactory!({ terminal: { rows: 40 }, requestRender() {} }, theme, { matches: () => false });
	const rendered = editor.render(180).join("\n");
	assert.match(rendered, /mode:deep/);
	assert.match(rendered, /GPT-6 Astra · xhigh/);
	assert.match(rendered, /idx: embedding 60% · ~11s/);
	assert.doesNotMatch(rendered, /bg jobs?|\d+ loops?/);
	events.emit("agent-jobs:running-count", { count: 7 });
	events.emit("loop-jobs:running-count", { count: 5 });
	assert.equal(editor.render(180).join("\n"), rendered, "job/loop events no longer change the composer");
	events.emit("semantic-search:rebuild-status", { indicator: "idx: done" });
	assert.match(editor.render(180).join("\n"), /idx: done/);
	events.emit("semantic-search:rebuild-status", { indicator: null });
	assert.doesNotMatch(editor.render(180).join("\n"), /idx:/);
	thinking = "medium";
	events.emit("workflow:mode", { mode: "smart", label: "Smart" });
	assert.match(editor.render(100)[0], /mode:smart.*GPT-6 Astra · medium/);
	for (const width of [10, 20, 40]) {
		assert.ok(visibleWidth(editor.render(width)[0]) <= width);
	}
	assert.match(rendered, /25% of 200k/);
	assert.match(rendered, /\/tmp\/project/);
});

test("formatTokenCount keeps token totals compact", () => {
	assert.equal(formatTokenCount(999), "999");
	assert.equal(formatTokenCount(1250), "1.3k");
	assert.equal(formatTokenCount(12_500), "13k");
	assert.equal(formatTokenCount(1_250_000), "1.3M");
});

test("getAssistantUsageTotals sums assistant token burn and cost", () => {
	const entries = [
		{ type: "message", message: { role: "user", content: [] } },
		{
			type: "message",
			message: {
				role: "assistant",
				usage: {
					input: 100,
					output: 20,
					cacheRead: 300,
					cacheWrite: 40,
					cost: { total: 0.12 },
				},
			},
		},
		{
			type: "message",
			message: {
				role: "assistant",
				usage: {
					totalTokens: 1000,
					input: 1,
					output: 1,
					cost: { total: 0.34 },
				},
			},
		},
	];

	assert.deepEqual(getAssistantUsageTotals(entries), {
		cost: 0.46,
		tokensBurned: 1460,
	});
});

test("formatBottomLeftUsage keeps only context capacity, cumulative burn, and cost", () => {
	assert.equal(
		formatBottomLeftUsage(
			{ percent: 42.4, tokens: 84_200, contextWindow: 200_000 },
			{ cost: 1.14, tokensBurned: 1_250_000 },
		),
		"42% of 200k · 1.3M burned · $1.14",
	);
});

test("formatBottomLeftUsage handles missing context without restoring removed metrics", () => {
	assert.equal(
		formatBottomLeftUsage(undefined, { cost: 0, tokensBurned: 0 }),
		"— of — · 0 burned · $0.00",
	);
});
