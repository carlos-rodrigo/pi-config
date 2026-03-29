import test from "node:test";
import assert from "node:assert/strict";

import { pickPrimaryExtensionStatus } from "./index.ts";

test("pickPrimaryExtensionStatus prefers dumb-zone over other statuses", () => {
	const statuses = new Map<string, string>([
		["review", "reviewing"],
		["dumb-zone", "handoff now"],
	]);

	assert.equal(pickPrimaryExtensionStatus(statuses), "handoff now");
});

test("pickPrimaryExtensionStatus falls back to the first available status", () => {
	const statuses = new Map<string, string>([["review", "reviewing"]]);
	assert.equal(pickPrimaryExtensionStatus(statuses), "reviewing");
	assert.equal(pickPrimaryExtensionStatus(new Map()), null);
});
