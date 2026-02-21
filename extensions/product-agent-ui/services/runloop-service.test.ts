import test from "node:test";
import assert from "node:assert/strict";
import { continueRunLoop, pickNextReadyTask } from "./runloop-service.js";
import type { ProductAgentPolicy } from "./policy-service.js";
import type { ProductTaskItem, ProductTaskListResult } from "./task-service.js";
import type { ProductApprovals, ProductRunState } from "../types.js";

function createTask(params: {
	id: string;
	rawStatus?: ProductTaskItem["rawStatus"];
	depends?: string[];
}): ProductTaskItem {
	const rawStatus = params.rawStatus ?? "open";
	const groupStatus = rawStatus === "done" ? "Done" : rawStatus === "in-progress" ? "In Progress" : "TODO";
	return {
		id: params.id,
		title: `Task ${params.id}`,
		path: `.features/product-agent-ui/tasks/${params.id}-task.md`,
		rawStatus,
		groupStatus,
		depends: params.depends ?? [],
		isBlocked: rawStatus === "blocked",
	};
}

function createTaskList(tasks: ProductTaskItem[]): ProductTaskListResult {
	return {
		featureName: "product-agent-ui",
		tasksPath: ".features/product-agent-ui/tasks",
		tasks,
		sections: {
			TODO: tasks.filter((task) => task.groupStatus === "TODO"),
			"In Progress": tasks.filter((task) => task.groupStatus === "In Progress"),
			Done: tasks.filter((task) => task.groupStatus === "Done"),
		},
	};
}

function createStrictPolicy(): ProductAgentPolicy {
	return {
		version: 1,
		mode: "strict",
		gates: {
			planApprovalRequired: true,
			designApprovalRequired: true,
			tasksApprovalRequired: true,
			reviewRequired: true,
		},
		execution: {
			autoRunLoop: true,
			stopOnFailedChecks: true,
			stopOnUncertainty: true,
		},
	};
}

function createApprovedGateState(): ProductApprovals {
	return {
		prd: {
			status: "approved",
			note: "ok",
			by: "tester",
			at: "2026-02-20T12:00:00.000Z",
		},
		design: {
			status: "approved",
			note: "ok",
			by: "tester",
			at: "2026-02-20T12:00:00.000Z",
		},
		tasks: {
			status: "approved",
			note: "ok",
			by: "tester",
			at: "2026-02-20T12:00:00.000Z",
		},
	};
}

function createRunState(): ProductRunState {
	return {
		status: "idle",
		timeline: [],
	};
}

test("continueRunLoop queues the next ready task when approvals are satisfied", () => {
	const taskList = createTaskList([
		createTask({ id: "001", rawStatus: "open" }),
		createTask({ id: "002", rawStatus: "open", depends: ["001"] }),
	]);

	const result = continueRunLoop({
		featureName: "product-agent-ui",
		runState: createRunState(),
		taskList,
		policy: createStrictPolicy(),
		approvals: createApprovedGateState(),
		now: "2026-02-20T13:00:00.000Z",
	});

	assert.equal(result.level, "info");
	assert.equal(result.runState.status, "running");
	assert.equal(result.runState.activeTaskId, "001");
	assert.match(result.command ?? "", /\.features\/product-agent-ui\/tasks\/001-task\.md/);
	assert.ok(result.runState.timeline.some((event) => event.type === "task_start" && event.taskId === "001"));
});

test("continueRunLoop blocks when required approvals are missing", () => {
	const taskList = createTaskList([createTask({ id: "001", rawStatus: "open" })]);

	const result = continueRunLoop({
		featureName: "product-agent-ui",
		runState: createRunState(),
		taskList,
		policy: createStrictPolicy(),
		approvals: {},
		now: "2026-02-20T13:05:00.000Z",
	});

	assert.equal(result.level, "warning");
	assert.equal(result.runState.status, "blocked");
	assert.match(result.notification, /Plan approval is required/);
	assert.equal(result.command, undefined);
});

test("pickNextReadyTask reports dependency blocks when no open task is ready", () => {
	const result = pickNextReadyTask([
		createTask({ id: "001", rawStatus: "open", depends: ["010"] }),
		createTask({ id: "010", rawStatus: "in-progress" }),
	]);

	assert.equal(result.task, undefined);
	assert.equal(result.openTaskCount, 1);
	assert.match(result.blockedReason ?? "", /001 waits on 010/);
});
