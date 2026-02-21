import test from "node:test";
import assert from "node:assert/strict";
import {
	PRODUCT_AGENT_STATE_ENTRY_TYPE,
	createWorkflowStateSnapshot,
	findLatestWorkflowFeatureName,
	restoreWorkflowStateFromEntriesWithWarnings,
} from "./state-service.js";
import { createDefaultProductShellState, type ProductRunState } from "../types.js";

function createStateEntry(data: unknown) {
	return {
		type: "custom",
		customType: PRODUCT_AGENT_STATE_ENTRY_TYPE,
		data,
	};
}

function createRunState(params: {
	status?: ProductRunState["status"];
	events?: ProductRunState["timeline"];
} = {}): ProductRunState {
	return {
		status: params.status ?? "idle",
		timeline: params.events ?? [],
	};
}

test("findLatestWorkflowFeatureName skips malformed state snapshots", () => {
	const alphaState = createDefaultProductShellState("alpha");
	const alphaSnapshot = createWorkflowStateSnapshot(alphaState, "2026-02-20T10:00:00.000Z");

	const malformedSnapshot = {
		version: 1,
		featureName: "../invalid",
		currentStage: "plan",
		approvals: {},
		taskView: "list",
		runState: createRunState(),
		updatedAt: "2026-02-20T11:00:00.000Z",
	};

	const latest = findLatestWorkflowFeatureName([
		createStateEntry(alphaSnapshot),
		createStateEntry(malformedSnapshot),
	]);

	assert.equal(latest, "alpha");
});

test("restoreWorkflowStateFromEntriesWithWarnings replays metadata and reports malformed entries", () => {
	const firstState = createDefaultProductShellState("product-agent-ui");
	firstState.currentStage = "tasks";
	firstState.run = createRunState({
		status: "paused",
		events: [
			{
				id: "event-1",
				at: "2026-02-20T12:00:00.000Z",
				type: "info",
				message: "first event",
				taskId: "001",
			},
		],
	});

	const secondState = createDefaultProductShellState("product-agent-ui");
	secondState.currentStage = "review";
	secondState.taskView = "board";
	secondState.run = createRunState({
		status: "blocked",
		events: [
			{
				id: "event-1",
				at: "2026-02-20T12:00:00.000Z",
				type: "info",
				message: "updated first event",
				taskId: "001",
			},
			{
				id: "event-2",
				at: "2026-02-20T12:30:00.000Z",
				type: "task_blocked",
				message: "blocked",
				taskId: "999",
			},
		],
	});

	const malformedSnapshot = {
		version: 1,
		featureName: "product-agent-ui",
		currentStage: "invalid-stage",
		approvals: {},
		taskView: "list",
		runState: createRunState(),
		updatedAt: "2026-02-20T11:00:00.000Z",
	};

	const restoreResult = restoreWorkflowStateFromEntriesWithWarnings(
		[
			createStateEntry(malformedSnapshot),
			createStateEntry(createWorkflowStateSnapshot(firstState, "2026-02-20T12:00:00.000Z")),
			createStateEntry(createWorkflowStateSnapshot(secondState, "2026-02-20T12:30:00.000Z")),
		],
		"product-agent-ui",
	);

	assert.ok(restoreResult.state);
	assert.equal(restoreResult.state?.currentStage, "review");
	assert.equal(restoreResult.state?.taskView, "board");
	assert.deepEqual(
		restoreResult.state?.run.timeline.map((event) => event.id),
		["event-1", "event-2"],
	);
	assert.equal(restoreResult.state?.run.timeline[0]?.message, "updated first event");
	assert.ok(
		restoreResult.warnings.some((warning) => warning.includes("Ignored malformed product-agent-state entry")),
	);
});
