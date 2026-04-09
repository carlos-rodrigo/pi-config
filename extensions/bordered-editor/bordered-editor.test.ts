import test from "node:test";
import assert from "node:assert/strict";

import { pickPrimaryExtensionStatus } from "./index.ts";

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
