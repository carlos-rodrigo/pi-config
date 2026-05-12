import test from "node:test";
import assert from "node:assert/strict";

import {
	formatBackgroundJobIndicator,
	formatBottomLeftUsage,
	formatTokenCount,
	formatWorkflowModeLabel,
	getAssistantUsageTotals,
	getWorkflowModeColor,
	pickPrimaryExtensionStatus,
} from "./index.ts";

test("pickPrimaryExtensionStatus prefers active auto-prompt status over ambient statuses", () => {
	const statuses = new Map<string, string>([
		["workflow-mode", "mode: Smart"],
		["prompt-queue", "queue: 2 queued"],
		["auto-prompt", "Improving prompt…"],
	]);

	assert.equal(pickPrimaryExtensionStatus(statuses), "Improving prompt…");
});

test("pickPrimaryExtensionStatus prefers review over prompt queue", () => {
	const statuses = new Map<string, string>([
		["review", "reviewing"],
		["prompt-queue", "queue: 2 queued"],
	]);

	assert.equal(pickPrimaryExtensionStatus(statuses), "reviewing");
});

test("pickPrimaryExtensionStatus falls back to ambient workflow mode status", () => {
	assert.equal(pickPrimaryExtensionStatus(new Map<string, string>([["workflow-mode", "mode: Smart"]])), "mode: Smart");
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

test("formatWorkflowModeLabel displays all workflow modes", () => {
	assert.equal(formatWorkflowModeLabel("smart"), "Smart");
	assert.equal(formatWorkflowModeLabel("deep1"), "Deep¹");
	assert.equal(formatWorkflowModeLabel("deep"), "Deep²");
	assert.equal(formatWorkflowModeLabel("deep2"), "Deep²");
	assert.equal(formatWorkflowModeLabel("deep3"), "Deep³");
	assert.equal(formatWorkflowModeLabel("fast"), "Fast");
	assert.equal(formatWorkflowModeLabel(null), null);
});

test("getWorkflowModeColor colors deep levels as deep mode", () => {
	assert.equal(getWorkflowModeColor("Smart"), "success");
	assert.equal(getWorkflowModeColor("Deep¹"), "error");
	assert.equal(getWorkflowModeColor("Deep²"), "error");
	assert.equal(getWorkflowModeColor("Deep³"), "error");
	assert.equal(getWorkflowModeColor("Fast"), "warning");
});

test("formatBackgroundJobIndicator only appears for running jobs", () => {
	assert.equal(formatBackgroundJobIndicator(0), null);
	assert.equal(formatBackgroundJobIndicator(1), "1 bg job");
	assert.equal(formatBackgroundJobIndicator(2), "2 bg jobs");
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

	assert.deepEqual(getAssistantUsageTotals(entries), { cost: 0.46, tokensBurned: 1460 });
});

test("formatBottomLeftUsage includes context percent, context tokens, burned tokens, and cost", () => {
	assert.equal(
		formatBottomLeftUsage({ percent: 42.4, tokens: 84_200, contextWindow: 200_000 }, { cost: 1.14, tokensBurned: 1_250_000 }),
		"42% of 200k · 84k ctx · 1.3M burned · $1.14",
	);
	assert.equal(formatBottomLeftUsage(undefined, { cost: 0, tokensBurned: 0 }), "— of — · — ctx · 0 burned · $0.00");
});
