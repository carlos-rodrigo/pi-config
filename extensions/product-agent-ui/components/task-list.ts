import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import {
	TASK_GROUP_ORDER,
	type ProductTaskGroupStatus,
	type ProductTaskItem,
	type ProductTaskListResult,
} from "../services/task-service.js";

export interface TaskListRenderParams {
	theme: Theme;
	width: number;
	result: ProductTaskListResult;
}

export function renderTaskList(params: TaskListRenderParams): string[] {
	const { theme, width, result } = params;
	const lines: string[] = [];

	lines.push(truncateToWidth(theme.fg("accent", theme.bold("Tasks · List view")), width));
	lines.push(truncateToWidth(theme.fg("muted", "Grouped order: TODO → In Progress → Done"), width));

	if (result.warning) {
		for (const warning of result.warning.split(" | ")) {
			const safeWarning = sanitizeDisplayText(warning.trim());
			if (!safeWarning) continue;
			lines.push(truncateToWidth(theme.fg("warning", `⚠ ${safeWarning}`), width));
		}
	}

	lines.push("");

	for (const group of TASK_GROUP_ORDER) {
		lines.push(...renderSection({ theme, width, group, tasks: result.sections[group] }));
		lines.push("");
	}

	if (lines[lines.length - 1] === "") {
		lines.pop();
	}

	return lines;
}

function renderSection(params: {
	theme: Theme;
	width: number;
	group: ProductTaskGroupStatus;
	tasks: ProductTaskItem[];
}): string[] {
	const { theme, width, group, tasks } = params;
	const lines: string[] = [];

	lines.push(truncateToWidth(theme.fg("border", `${group} (${tasks.length})`), width));

	if (tasks.length === 0) {
		lines.push(truncateToWidth(theme.fg("dim", "  No tasks in this section."), width));
		return lines;
	}

	for (const task of tasks) {
		const safeId = sanitizeDisplayText(task.id);
		const safeTitle = sanitizeDisplayText(task.title);
		const blockedMarker = task.isBlocked ? ` ${theme.fg("warning", "[blocked]")}` : "";
		const statusText = theme.fg("dim", `(${task.rawStatus})`);
		const label = `${theme.bold(safeId)} ${safeTitle}`;
		lines.push(truncateToWidth(`  • ${label}${blockedMarker} ${statusText}`, width));
	}

	return lines;
}

function sanitizeDisplayText(value: string): string {
	return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
}
