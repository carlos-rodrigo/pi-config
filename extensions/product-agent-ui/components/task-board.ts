import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { TASK_GROUP_ORDER, type ProductTaskItem, type ProductTaskListResult } from "../services/task-service.js";

const COLUMN_GAP = 2;

export interface TaskBoardRenderParams {
	theme: Theme;
	width: number;
	result: ProductTaskListResult;
	selectedTaskId?: string;
}

export function renderTaskBoard(params: TaskBoardRenderParams): string[] {
	const { theme, width, result, selectedTaskId } = params;
	const lines: string[] = [];

	lines.push(truncateToWidth(theme.fg("accent", theme.bold("Tasks · Board view")), width));
	lines.push(truncateToWidth(theme.fg("muted", "Columns: TODO | In Progress | Done"), width));

	if (result.warning) {
		for (const warning of result.warning.split(" | ")) {
			const safeWarning = sanitizeDisplayText(warning.trim());
			if (!safeWarning) continue;
			lines.push(truncateToWidth(theme.fg("warning", `⚠ ${safeWarning}`), width));
		}
	}

	lines.push("");

	const columns = TASK_GROUP_ORDER.map((group) => ({
		group,
		tasks: result.sections[group],
	}));
	const columnWidths = getColumnWidths(width, columns.length);
	const totalWidth = columnWidths.reduce((sum, columnWidth) => sum + columnWidth, 0) + COLUMN_GAP * (columnWidths.length - 1);

	lines.push(
		truncateToWidth(
			renderBoardRow(
				columns.map(({ group, tasks }) => theme.fg("border", `${group} (${tasks.length})`)),
				columnWidths,
			),
			totalWidth,
		),
	);
	lines.push(
		truncateToWidth(
			renderBoardRow(columns.map(() => theme.fg("borderMuted", "─".repeat(12))), columnWidths),
			totalWidth,
		),
	);

	const maxRows = Math.max(1, ...columns.map(({ tasks }) => tasks.length));
	for (let index = 0; index < maxRows; index += 1) {
		const cells = columns.map(({ tasks }) => {
			const task = tasks[index];
			if (!task) {
				return theme.fg("dim", "·");
			}
			return formatTaskCell(task, selectedTaskId === task.id, theme);
		});
		lines.push(truncateToWidth(renderBoardRow(cells, columnWidths), totalWidth));
	}

	return lines;
}

function renderBoardRow(cells: string[], columnWidths: number[]): string {
	return cells.map((cell, index) => padToWidth(cell, columnWidths[index] ?? 1)).join(" ".repeat(COLUMN_GAP));
}

function padToWidth(value: string, width: number): string {
	const normalizedWidth = Math.max(1, width);
	const truncated = truncateToWidth(value, normalizedWidth, "");
	const remainder = Math.max(0, normalizedWidth - visibleWidth(truncated));
	return `${truncated}${" ".repeat(remainder)}`;
}

function getColumnWidths(totalWidth: number, columnCount: number): number[] {
	if (columnCount <= 0) return [];

	const totalGapWidth = COLUMN_GAP * (columnCount - 1);
	const availableWidth = Math.max(columnCount, totalWidth - totalGapWidth);
	const baseWidth = Math.max(1, Math.floor(availableWidth / columnCount));
	let remainder = availableWidth - baseWidth * columnCount;

	const widths: number[] = [];
	for (let index = 0; index < columnCount; index += 1) {
		let width = baseWidth;
		if (remainder > 0) {
			width += 1;
			remainder -= 1;
		}
		widths.push(width);
	}

	return widths;
}

function formatTaskCell(task: ProductTaskItem, selected: boolean, theme: Theme): string {
	const safeId = sanitizeDisplayText(task.id);
	const safeTitle = sanitizeDisplayText(task.title);
	const blockedMarker = task.isBlocked ? ` ${theme.fg("warning", "[blocked]")}` : "";
	const baseLabel = `${safeId} ${safeTitle}${blockedMarker}`;
	const marker = selected ? theme.fg("accent", "▸") : theme.fg("dim", "•");

	if (selected) {
		return `${marker} ${theme.fg("accent", theme.bold(baseLabel))}`;
	}

	return `${marker} ${baseLabel}`;
}

function sanitizeDisplayText(value: string): string {
	return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
}
