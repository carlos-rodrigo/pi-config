import type { ProductAgentPolicy } from "./policy-service.js";
import type { ProductTaskItem, ProductTaskListResult, ProductTaskRawStatus } from "./task-service.js";
import type {
	ProductApprovals,
	ProductRunControlAction,
	ProductRunEvent,
	ProductRunEventType,
	ProductRunState,
} from "../types.js";

const MAX_TIMELINE_EVENTS = 80;

export type RunLoopNotificationLevel = "info" | "warning" | "error";

export interface RunLoopActionResult {
	runState: ProductRunState;
	notification: string;
	level: RunLoopNotificationLevel;
	command?: string;
}

export interface NextReadyTaskResult {
	task?: ProductTaskItem;
	openTaskCount: number;
	blockedReason?: string;
}

export function continueRunLoop(params: {
	featureName: string;
	runState: ProductRunState;
	taskList: ProductTaskListResult;
	policy: ProductAgentPolicy;
	approvals: ProductApprovals;
	now?: string;
}): RunLoopActionResult {
	const { featureName, taskList, policy, approvals } = params;
	const now = params.now ?? new Date().toISOString();

	const reconciledState = reconcileRunStateWithTasks({
		runState: params.runState,
		taskList,
		now,
	});

	const gateCheck = validateRunLoopGates(policy, approvals);
	if (!gateCheck.ok) {
		return createBlockedResult(reconciledState, gateCheck.reason, now);
	}

	if (reconciledState.activeTaskId) {
		const message = `Task ${reconciledState.activeTaskId} is still active. Wait for completion, then continue.`;
		const runState = appendRunEvent(reconciledState, {
			type: "info",
			at: now,
			taskId: reconciledState.activeTaskId,
			message,
		});
		return {
			runState,
			notification: message,
			level: "warning",
		};
	}

	const nextReady = pickNextReadyTask(taskList.tasks);
	if (!nextReady.task) {
		if (nextReady.openTaskCount === 0) {
			const message = "No open tasks remain. Run loop is idle.";
			const runState = appendRunEvent(
				{
					...reconciledState,
					status: "idle",
					blockedReason: undefined,
					pendingCheckpoint: undefined,
				},
				{
					type: "info",
					at: now,
					message,
				},
			);
			return {
				runState,
				notification: message,
				level: "info",
			};
		}

		return createBlockedResult(
			reconciledState,
			nextReady.blockedReason ?? "No ready open tasks. Dependencies are still in progress.",
			now,
		);
	}

	if (!isSafeTaskPath(nextReady.task.path)) {
		return createBlockedResult(
			reconciledState,
			`Cannot dispatch task ${nextReady.task.id}: task path is invalid (${nextReady.task.path}).`,
			now,
			nextReady.task.id,
		);
	}

	const task = nextReady.task;
	const startMessage = `Starting task ${task.id}: ${task.title}`;
	let runState: ProductRunState = {
		...reconciledState,
		status: "running",
		activeTaskId: task.id,
		blockedReason: undefined,
	};

	runState = appendRunEvent(runState, {
		type: "task_start",
		at: now,
		taskId: task.id,
		message: startMessage,
	});

	runState = setPendingCheckpoint(
		runState,
		`Await completion of task ${task.id}. Continue to run the next ready task, pause, or request changes.`,
		now,
		task.id,
	);

	const command = buildImplementTaskCommand(featureName, task.path);
	return {
		runState,
		command,
		notification: `Run loop queued task ${task.id}.`,
		level: "info",
	};
}

export function pauseRunLoop(params: {
	runState: ProductRunState;
	now?: string;
}): RunLoopActionResult {
	const now = params.now ?? new Date().toISOString();
	const message = params.runState.activeTaskId
		? `Paused run loop after task ${params.runState.activeTaskId}.`
		: "Run loop paused.";

	let runState: ProductRunState = {
		...params.runState,
		status: "paused",
		blockedReason: undefined,
	};

	runState = setPendingCheckpoint(
		runState,
		params.runState.activeTaskId
			? `Task ${params.runState.activeTaskId} is active. Continue when it is marked done.`
			: "Run loop is paused. Continue to pick the next ready task.",
		now,
		params.runState.activeTaskId,
	);

	runState = appendRunEvent(runState, {
		type: "info",
		at: now,
		taskId: params.runState.activeTaskId,
		message,
	});

	return {
		runState,
		notification: message,
		level: "info",
	};
}

export function requestRunLoopChanges(params: {
	runState: ProductRunState;
	reason?: string;
	now?: string;
}): RunLoopActionResult {
	const now = params.now ?? new Date().toISOString();
	const message = sanitizeDisplayText(
		params.reason && params.reason.trim().length > 0
			? params.reason
			: "Changes requested before continuing the run loop.",
	);

	const runState = applyBlockedState(params.runState, {
		reason: message,
		now,
		taskId: params.runState.activeTaskId,
	});

	return {
		runState,
		notification: message,
		level: "warning",
	};
}

export function reconcileRunStateWithTasks(params: {
	runState: ProductRunState;
	taskList: ProductTaskListResult;
	now?: string;
}): ProductRunState {
	const { runState, taskList } = params;
	const now = params.now ?? new Date().toISOString();
	if (!runState.activeTaskId) {
		return runState;
	}

	const activeTask = taskList.tasks.find((task) => task.id === runState.activeTaskId);
	if (!activeTask) {
		return applyBlockedState(runState, {
			reason: `Active task ${runState.activeTaskId} is missing from the task list. Refresh task data before continuing.`,
			now,
			taskId: runState.activeTaskId,
			clearActiveTask: true,
		});
	}

	if (activeTask.rawStatus !== "done") {
		return runState;
	}

	let nextState: ProductRunState = {
		...runState,
		status: runState.status === "running" ? "paused" : runState.status,
		activeTaskId: undefined,
		blockedReason: undefined,
	};

	nextState = appendRunEvent(nextState, {
		type: "task_done",
		at: now,
		taskId: activeTask.id,
		message: `Task ${activeTask.id} completed: ${activeTask.title}`,
	});

	return setPendingCheckpoint(
		nextState,
		`Task ${activeTask.id} is done. Continue for the next ready task, pause, or request changes.`,
		now,
		activeTask.id,
	);
}

export function pickNextReadyTask(tasks: ProductTaskItem[]): NextReadyTaskResult {
	const openTasks = tasks.filter((task) => task.rawStatus === "open");
	if (openTasks.length === 0) {
		return {
			openTaskCount: 0,
		};
	}

	const statusById = new Map<string, ProductTaskRawStatus>();
	for (const task of tasks) {
		statusById.set(task.id, task.rawStatus);
	}

	for (const task of openTasks) {
		if (task.depends.every((dependencyId) => statusById.get(dependencyId) === "done")) {
			return {
				task,
				openTaskCount: openTasks.length,
			};
		}
	}

	const blockedPreview = openTasks
		.slice(0, 3)
		.map((task) => {
			const pendingDependencies = task.depends.filter((dependencyId) => statusById.get(dependencyId) !== "done");
			if (pendingDependencies.length === 0) {
				return `${task.id} (dependency metadata incomplete)`;
			}
			return `${task.id} waits on ${pendingDependencies.join(", ")}`;
		})
		.join("; ");

	const blockedReason =
		blockedPreview.length > 0
			? `No ready open tasks. ${blockedPreview}.`
			: "No ready open tasks. Dependencies are still in progress.";

	return {
		openTaskCount: openTasks.length,
		blockedReason,
	};
}

export function buildImplementTaskCommand(featureName: string, taskPath: string): string {
	const safeFeatureName = sanitizeDisplayText(featureName);
	const safeTaskPath = sanitizeDisplayText(taskPath);
	return `/skill:implement-task Implement task file ${safeTaskPath} for feature ${safeFeatureName}`;
}

function createBlockedResult(
	runState: ProductRunState,
	reason: string,
	now: string,
	taskId?: string,
): RunLoopActionResult {
	return {
		runState: applyBlockedState(runState, {
			reason,
			now,
			taskId,
		}),
		notification: reason,
		level: "warning",
	};
}

function applyBlockedState(
	runState: ProductRunState,
	params: {
		reason: string;
		now: string;
		taskId?: string;
		clearActiveTask?: boolean;
	},
): ProductRunState {
	const reason = sanitizeDisplayText(params.reason);
	let nextState: ProductRunState = {
		...runState,
		status: "blocked",
		blockedReason: reason,
		activeTaskId: params.clearActiveTask ? undefined : runState.activeTaskId,
	};

	nextState = appendRunEvent(nextState, {
		type: "task_blocked",
		at: params.now,
		taskId: params.taskId,
		message: reason,
	});

	return setPendingCheckpoint(nextState, reason, params.now, params.taskId);
}

function validateRunLoopGates(
	policy: ProductAgentPolicy,
	approvals: ProductApprovals,
):
	| {
			ok: true;
	  }
	| {
			ok: false;
			reason: string;
	  } {
	if (policy.gates.planApprovalRequired && approvals.prd?.status !== "approved") {
		return {
			ok: false,
			reason: "Run loop is blocked: Plan approval is required.",
		};
	}

	if (policy.gates.designApprovalRequired && approvals.design?.status !== "approved") {
		return {
			ok: false,
			reason: "Run loop is blocked: Design approval is required.",
		};
	}

	if (policy.gates.tasksApprovalRequired && approvals.tasks?.status !== "approved") {
		return {
			ok: false,
			reason: "Run loop is blocked: Tasks approval is required.",
		};
	}

	return { ok: true };
}

function setPendingCheckpoint(
	runState: ProductRunState,
	message: string,
	at: string,
	taskId?: string,
): ProductRunState {
	const safeMessage = sanitizeDisplayText(message);
	const pendingCheckpoint = {
		id: createEventId("checkpoint"),
		at,
		taskId,
		message: safeMessage,
	};

	return appendRunEvent(
		{
			...runState,
			pendingCheckpoint,
		},
		{
			type: "checkpoint",
			at,
			taskId,
			message: safeMessage,
		},
	);
}

function appendRunEvent(
	runState: ProductRunState,
	event: {
		type: ProductRunEventType;
		at: string;
		message: string;
		taskId?: string;
	},
): ProductRunState {
	const sanitizedMessage = sanitizeDisplayText(event.message);
	const previousEvent = runState.timeline[runState.timeline.length - 1];
	if (
		previousEvent &&
		previousEvent.type === event.type &&
		previousEvent.taskId === event.taskId &&
		previousEvent.message === sanitizedMessage
	) {
		return runState;
	}

	const nextEvent: ProductRunEvent = {
		id: createEventId(event.type),
		at: event.at,
		type: event.type,
		taskId: event.taskId,
		message: sanitizedMessage,
	};

	const timeline = [...runState.timeline, nextEvent];
	const normalizedTimeline = timeline.length > MAX_TIMELINE_EVENTS ? timeline.slice(-MAX_TIMELINE_EVENTS) : timeline;

	return {
		...runState,
		timeline: normalizedTimeline,
	};
}

function createEventId(prefix: ProductRunEventType | "checkpoint"): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeDisplayText(value: string): string {
	return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").trim();
}

function isSafeTaskPath(taskPath: string): boolean {
	if (!taskPath) return false;
	if (taskPath.startsWith("/") || taskPath.startsWith("\\") || taskPath.includes("..")) {
		return false;
	}
	return /^[a-zA-Z0-9._/-]+$/.test(taskPath);
}

export function getRunActionLabel(action: ProductRunControlAction): string {
	switch (action) {
		case "continue":
			return "Continue";
		case "pause":
			return "Pause";
		case "request_changes":
			return "Request changes";
		default:
			return action;
	}
}
