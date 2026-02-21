import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { pickNextReadyTask } from "../services/runloop-service.js";
import type { ProductTaskListResult } from "../services/task-service.js";
import type { ProductRunEvent, ProductRunState, ProductRunStatus } from "../types.js";

const TIMELINE_PREVIEW_LIMIT = 10;

export interface RunConsoleRenderParams {
	theme: Theme;
	width: number;
	runState: ProductRunState;
	taskList: ProductTaskListResult;
}

export function renderRunConsole(params: RunConsoleRenderParams): string[] {
	const { theme, width, runState, taskList } = params;
	const lines: string[] = [];

	lines.push(truncateToWidth(theme.fg("accent", theme.bold("Run console")), width));
	lines.push(truncateToWidth(`${theme.fg("muted", "State:")} ${formatRunStatus(theme, runState.status)}`, width));

	if (runState.blockedReason) {
		lines.push(truncateToWidth(theme.fg("warning", `Blocked: ${sanitizeDisplayText(runState.blockedReason)}`), width));
	}

	if (runState.activeTaskId) {
		lines.push(truncateToWidth(theme.fg("muted", `Active task: ${sanitizeDisplayText(runState.activeTaskId)}`), width));
	} else {
		const nextReadyTask = pickNextReadyTask(taskList.tasks).task;
		if (nextReadyTask) {
			const safeTaskId = sanitizeDisplayText(nextReadyTask.id);
			const safeTaskTitle = sanitizeDisplayText(nextReadyTask.title);
			lines.push(
				truncateToWidth(
					theme.fg("muted", `Next ready task: ${safeTaskId} ${safeTaskTitle}`),
					width,
				),
			);
		} else {
			lines.push(truncateToWidth(theme.fg("dim", "Next ready task: none"), width));
		}
	}

	lines.push("");
	lines.push(truncateToWidth(theme.fg("border", "Pending checkpoint"), width));
	if (runState.pendingCheckpoint) {
		const pending = runState.pendingCheckpoint;
		const checkpointLabel = pending.taskId
			? `[${sanitizeDisplayText(pending.taskId)}] ${sanitizeDisplayText(pending.message)}`
			: sanitizeDisplayText(pending.message);
		lines.push(truncateToWidth(`  ${checkpointLabel}`, width));
	} else {
		lines.push(truncateToWidth(theme.fg("dim", "  No checkpoint pending."), width));
	}
	lines.push(truncateToWidth(theme.fg("dim", "  Controls: c Continue · p Pause · r Request changes"), width));

	lines.push("");
	lines.push(truncateToWidth(theme.fg("border", "Recent timeline"), width));
	const recentEvents = runState.timeline.slice(-TIMELINE_PREVIEW_LIMIT);
	if (recentEvents.length === 0) {
		lines.push(truncateToWidth(theme.fg("dim", "  No run events yet."), width));
	} else {
		for (const event of recentEvents) {
			lines.push(truncateToWidth(`  ${formatRunEvent(theme, event)}`, width));
		}
	}

	if (taskList.warning) {
		lines.push("");
		for (const warning of taskList.warning.split(" | ")) {
			const safeWarning = sanitizeDisplayText(warning);
			if (!safeWarning) continue;
			lines.push(truncateToWidth(theme.fg("warning", `⚠ ${safeWarning}`), width));
		}
	}

	return lines;
}

function formatRunStatus(theme: Theme, status: ProductRunStatus): string {
	switch (status) {
		case "running":
			return theme.fg("accent", "Running");
		case "paused":
			return theme.fg("warning", "Paused");
		case "blocked":
			return theme.fg("error", "Blocked");
		case "idle":
		default:
			return theme.fg("dim", "Idle");
	}
}

function formatRunEvent(theme: Theme, event: ProductRunEvent): string {
	const timestamp = formatTimestamp(event.at);
	const typeLabel = formatRunEventType(theme, event.type);
	const taskLabel = event.taskId ? ` ${sanitizeDisplayText(event.taskId)}` : "";
	const message = sanitizeDisplayText(event.message);
	return `${theme.fg("dim", `[${timestamp}]`)} ${typeLabel}${taskLabel} ${message}`;
}

function formatRunEventType(theme: Theme, type: ProductRunEvent["type"]): string {
	switch (type) {
		case "task_start":
			return theme.fg("accent", "START");
		case "task_done":
			return theme.fg("success", "DONE");
		case "task_blocked":
			return theme.fg("error", "BLOCKED");
		case "checkpoint":
			return theme.fg("warning", "CHECKPOINT");
		case "info":
		default:
			return theme.fg("muted", "INFO");
	}
}

function formatTimestamp(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}
	return date.toISOString().slice(11, 19);
}

function sanitizeDisplayText(value: string): string {
	return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").trim();
}
