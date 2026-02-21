import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ProductRunState } from "../types.js";
import { reconcileRunStateWithTasks } from "./runloop-service.js";
import type { ProductTaskListResult } from "./task-service.js";

const ACTIVE_TASK_HINT_PATTERN = /^\s*-\s*\[(x|X| )\]\s+(\d+)\b/;
const ORPHAN_METADATA_MARKER = "[orphaned metadata:";

interface ActiveTaskHint {
	id: string;
	isChecked: boolean;
	line: number;
}

export async function reconcileTaskListWithActiveFile(options: {
	projectRoot: string;
	featureName: string;
	taskList: ProductTaskListResult;
}): Promise<ProductTaskListResult> {
	const { projectRoot, featureName, taskList } = options;
	const warnings: string[] = [];

	if (!isValidFeatureName(featureName)) {
		warnings.push(`Could not reconcile _active.md status hints for invalid feature name: ${featureName}`);
		return appendWarnings(taskList, warnings);
	}

	const featuresRoot = path.resolve(projectRoot, ".features");
	const activePath = path.resolve(featuresRoot, featureName, "tasks", "_active.md");
	if (!isPathWithinRoot(featuresRoot, activePath)) {
		warnings.push("Could not reconcile _active.md status hints: path resolves outside .features root.");
		return appendWarnings(taskList, warnings);
	}

	let activeFileContent: string;
	try {
		activeFileContent = await readFile(activePath, "utf8");
	} catch (error) {
		if (hasErrnoCode(error, "ENOENT")) {
			return taskList;
		}

		warnings.push(`Could not read .features/${featureName}/tasks/_active.md: ${toErrorMessage(error)}`);
		return appendWarnings(taskList, warnings);
	}

	const hints = parseActiveTaskHints(activeFileContent);
	if (hints.length === 0) {
		return taskList;
	}

	const taskById = new Map<string, (typeof taskList.tasks)[number]>();
	for (const task of taskList.tasks) {
		taskById.set(task.id, task);
	}

	for (const hint of hints) {
		const task = taskById.get(hint.id);
		if (!task) {
			warnings.push(`_active.md line ${hint.line} references unknown task ${hint.id}.`);
			continue;
		}

		const isDoneInFrontmatter = task.rawStatus === "done";
		if (hint.isChecked === isDoneInFrontmatter) {
			continue;
		}

		if (hint.isChecked) {
			warnings.push(
				`_active.md line ${hint.line} marks task ${hint.id} as done but frontmatter status is ${task.rawStatus}; using task frontmatter status as canonical.`,
			);
			continue;
		}

		warnings.push(
			`_active.md line ${hint.line} marks task ${hint.id} as open but frontmatter status is done; using task frontmatter status as canonical.`,
		);
	}

	return appendWarnings(taskList, warnings);
}

export function reconcileRunMetadataWithTaskFiles(options: {
	runState: ProductRunState;
	taskList: ProductTaskListResult;
}): {
	runState: ProductRunState;
	warnings: string[];
} {
	const { runState, taskList } = options;
	const taskIds = new Set(taskList.tasks.map((task) => task.id));
	const orphanTaskIds = new Set<string>();
	let didChange = false;

	const timeline = runState.timeline.map((event) => {
		if (!event.taskId || taskIds.has(event.taskId)) {
			return event;
		}

		orphanTaskIds.add(event.taskId);
		const nextMessage = withOrphanMetadataMessage(event.message, event.taskId);
		if (nextMessage === event.message) {
			return event;
		}

		didChange = true;
		return {
			...event,
			message: nextMessage,
		};
	});

	let pendingCheckpoint = runState.pendingCheckpoint;
	if (pendingCheckpoint?.taskId && !taskIds.has(pendingCheckpoint.taskId)) {
		orphanTaskIds.add(pendingCheckpoint.taskId);
		const nextMessage = withOrphanMetadataMessage(pendingCheckpoint.message, pendingCheckpoint.taskId);
		if (nextMessage !== pendingCheckpoint.message) {
			didChange = true;
			pendingCheckpoint = {
				...pendingCheckpoint,
				message: nextMessage,
			};
		}
	}

	if (runState.activeTaskId && !taskIds.has(runState.activeTaskId)) {
		orphanTaskIds.add(runState.activeTaskId);
	}

	const warnings =
		orphanTaskIds.size > 0
			? [
				`Run metadata references missing tasks (${Array.from(orphanTaskIds).join(", ")}). Marked as orphaned metadata in timeline.`,
			]
			: [];

	if (!didChange) {
		return {
			runState,
			warnings,
		};
	}

	return {
		runState: {
			...runState,
			timeline,
			pendingCheckpoint,
		},
		warnings,
	};
}

export function reconcileRunStateWithTaskFiles(options: {
	runState: ProductRunState;
	taskList: ProductTaskListResult;
	now?: string;
}): {
	runState: ProductRunState;
	warnings: string[];
} {
	const reconciledState = reconcileRunStateWithTasks({
		runState: options.runState,
		taskList: options.taskList,
		now: options.now,
	});

	return reconcileRunMetadataWithTaskFiles({
		runState: reconciledState,
		taskList: options.taskList,
	});
}

export function splitWarningText(warningText: string | undefined): string[] {
	if (!warningText) {
		return [];
	}

	return warningText
		.split(" | ")
		.map((warning) => sanitizeDisplayText(warning))
		.filter((warning) => warning.length > 0);
}

function parseActiveTaskHints(content: string): ActiveTaskHint[] {
	const hints: ActiveTaskHint[] = [];
	const lines = content.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (!line) continue;

		const match = ACTIVE_TASK_HINT_PATTERN.exec(line);
		if (!match) continue;

		hints.push({
			id: normalizeTaskIdentifier(match[2]),
			isChecked: match[1].toLowerCase() === "x",
			line: index + 1,
		});
	}
	return hints;
}

function withOrphanMetadataMessage(message: string, taskId: string): string {
	const normalizedMessage = sanitizeDisplayText(message);
	if (normalizedMessage.includes(ORPHAN_METADATA_MARKER)) {
		return normalizedMessage;
	}
	return `${normalizedMessage} [orphaned metadata: task ${taskId} is missing from task files]`.trim();
}

function appendWarnings(taskList: ProductTaskListResult, warnings: string[]): ProductTaskListResult {
	if (warnings.length === 0) {
		return taskList;
	}

	const mergedWarnings = mergeWarningText(taskList.warning, warnings);
	if (mergedWarnings === taskList.warning) {
		return taskList;
	}

	return {
		...taskList,
		warning: mergedWarnings,
	};
}

function mergeWarningText(existing: string | undefined, nextWarnings: string[]): string {
	const merged = new Set<string>();
	if (existing) {
		for (const warning of existing.split(" | ")) {
			const normalized = warning.trim();
			if (normalized) {
				merged.add(normalized);
			}
		}
	}

	for (const warning of nextWarnings) {
		const normalized = sanitizeDisplayText(warning);
		if (normalized) {
			merged.add(normalized);
		}
	}

	return Array.from(merged).join(" | ");
}

function isValidFeatureName(featureName: string): boolean {
	if (!featureName) return false;
	if (featureName.includes("/") || featureName.includes("\\") || featureName.includes("..")) {
		return false;
	}
	return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(featureName);
}

function normalizeTaskIdentifier(value: string): string {
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) {
		return trimmed.padStart(3, "0");
	}
	return trimmed;
}

function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
	const relativePath = path.relative(rootPath, candidatePath);
	if (relativePath.length === 0) return true;
	return !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function hasErrnoCode(error: unknown, code: string): boolean {
	if (!isRecord(error)) return false;
	return error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeDisplayText(value: string): string {
	return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").trim();
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
