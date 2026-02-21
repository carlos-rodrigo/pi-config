import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	reconcileRunMetadataWithTaskFiles,
	reconcileRunStateWithTaskFiles,
	reconcileTaskListWithActiveFile,
} from "./reconcile-service.js";
import type { ProductTaskListResult } from "./task-service.js";
import type { ProductRunState } from "../types.js";

function createTaskList(): ProductTaskListResult {
	const todoTask = {
		id: "001",
		title: "Task one",
		path: ".features/feature-x/tasks/001-task-one.md",
		rawStatus: "open" as const,
		groupStatus: "TODO" as const,
		depends: [] as string[],
		isBlocked: false,
	};

	const doneTask = {
		id: "002",
		title: "Task two",
		path: ".features/feature-x/tasks/002-task-two.md",
		rawStatus: "done" as const,
		groupStatus: "Done" as const,
		depends: [] as string[],
		isBlocked: false,
	};

	return {
		featureName: "feature-x",
		tasksPath: ".features/feature-x/tasks",
		tasks: [todoTask, doneTask],
		sections: {
			TODO: [todoTask],
			"In Progress": [],
			Done: [doneTask],
		},
	};
}

test("reconcileTaskListWithActiveFile keeps frontmatter as canonical and warns on mismatches", async () => {
	const projectRoot = await mkdtemp(path.join(os.tmpdir(), "product-agent-ui-"));
	const activeDir = path.join(projectRoot, ".features", "feature-x", "tasks");
	await mkdir(activeDir, { recursive: true });
	await writeFile(
		path.join(activeDir, "_active.md"),
		[
			"- [x] 001 - should be open in frontmatter",
			"- [ ] 002 - should be done in frontmatter",
			"- [x] 999 - unknown task",
		].join("\n"),
		"utf8",
	);

	try {
		const taskList = createTaskList();
		const reconciled = await reconcileTaskListWithActiveFile({
			projectRoot,
			featureName: "feature-x",
			taskList,
		});

		const statusById = new Map(reconciled.tasks.map((task) => [task.id, task.rawStatus]));
		assert.equal(statusById.get("001"), "open");
		assert.equal(statusById.get("002"), "done");

		assert.ok(reconciled.warning?.includes("using task frontmatter status as canonical"));
		assert.ok(reconciled.warning?.includes("references unknown task 999"));
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

test("reconcileRunMetadataWithTaskFiles marks missing task references as orphaned metadata", () => {
	const taskList = createTaskList();
	const runState: ProductRunState = {
		status: "blocked",
		timeline: [
			{
				id: "event-1",
				at: "2026-02-20T12:00:00.000Z",
				type: "info",
				message: "ready",
				taskId: "001",
			},
			{
				id: "event-2",
				at: "2026-02-20T12:05:00.000Z",
				type: "task_blocked",
				message: "missing",
				taskId: "999",
			},
		],
		pendingCheckpoint: {
			id: "checkpoint-1",
			at: "2026-02-20T12:05:00.000Z",
			message: "checkpoint",
			taskId: "998",
		},
	};

	const reconciled = reconcileRunMetadataWithTaskFiles({
		runState,
		taskList,
	});

	assert.ok(reconciled.warnings[0]?.includes("999"));
	assert.ok(reconciled.warnings[0]?.includes("998"));
	assert.ok(reconciled.runState.timeline[1]?.message.includes("[orphaned metadata: task 999"));
	assert.ok(reconciled.runState.pendingCheckpoint?.message.includes("[orphaned metadata: task 998"));
});

test("reconcileRunStateWithTaskFiles reconciles active done task before metadata replay", () => {
	const taskList = createTaskList();
	const runState: ProductRunState = {
		status: "running",
		activeTaskId: "002",
		timeline: [],
	};

	const reconciled = reconcileRunStateWithTaskFiles({
		runState,
		taskList,
		now: "2026-02-20T13:00:00.000Z",
	});

	assert.equal(reconciled.runState.status, "paused");
	assert.equal(reconciled.runState.activeTaskId, undefined);
	assert.ok(
		reconciled.runState.timeline.some((event) => event.type === "task_done" && event.taskId === "002"),
	);
});
