import test from "node:test";
import assert from "node:assert/strict";

import { formatWorkflowModeLabel, getWorkflowModeColor, pickPrimaryExtensionStatus } from "./index.ts";

test("pickPrimaryExtensionStatus prefers active auto-prompt status over ambient statuses", () => {
	const statuses = new Map<string, string>([
		["workflow-mode", "mode: Smart"],
		["dumb-zone", "smart"],
		["auto-prompt", "Improving prompt…"],
	]);

	assert.equal(pickPrimaryExtensionStatus(statuses), "Improving prompt…");
});

test("pickPrimaryExtensionStatus prefers review over dumb-zone", () => {
	const statuses = new Map<string, string>([
		["review", "reviewing"],
		["dumb-zone", "handoff now"],
	]);

	assert.equal(pickPrimaryExtensionStatus(statuses), "reviewing");
});

test("pickPrimaryExtensionStatus falls back to ambient statuses when nothing else is active", () => {
	assert.equal(pickPrimaryExtensionStatus(new Map<string, string>([["dumb-zone", "handoff now"]])), "handoff now");
	assert.equal(pickPrimaryExtensionStatus(new Map<string, string>([["workflow-mode", "mode: Smart"]])), "mode: Smart");
	assert.equal(pickPrimaryExtensionStatus(new Map()), null);
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
