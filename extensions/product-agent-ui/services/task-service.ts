import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";

export type ProductTaskRawStatus = "open" | "in-progress" | "done" | "blocked";

export type ProductTaskGroupStatus = "TODO" | "In Progress" | "Done";

export interface ProductTaskItem {
	id: string;
	title: string;
	path: string;
	rawStatus: ProductTaskRawStatus;
	groupStatus: ProductTaskGroupStatus;
	depends: string[];
	isBlocked: boolean;
}

export interface ProductTaskListResult {
	featureName: string;
	tasksPath: string;
	tasks: ProductTaskItem[];
	sections: Record<ProductTaskGroupStatus, ProductTaskItem[]>;
	warning?: string;
}

export const TASK_GROUP_ORDER: ProductTaskGroupStatus[] = ["TODO", "In Progress", "Done"];

const MAX_TASK_FILES = 300;
const MAX_TASK_FILE_SIZE_BYTES = 512 * 1024;

export async function loadProductTaskList(options: {
	projectRoot: string;
	featureName: string;
}): Promise<ProductTaskListResult> {
	const { projectRoot, featureName } = options;
	const featuresRoot = path.resolve(projectRoot, ".features");
	const featureRoot = path.resolve(featuresRoot, featureName);
	const tasksPath = path.resolve(featureRoot, "tasks");
	const displayTasksPath = toPosixPath(path.join(".features", featureName, "tasks"));

	const sections = createEmptySections();
	const warnings: string[] = [];

	if (!isPathWithinRoot(featuresRoot, featureRoot)) {
		return {
			featureName,
			tasksPath: displayTasksPath,
			tasks: [],
			sections,
			warning: `Invalid feature name: ${featureName}`,
		};
	}

	let entries: Array<{ name: string; isFile: () => boolean }>;
	try {
		entries = await readdir(tasksPath, { withFileTypes: true, encoding: "utf8" });
	} catch (error) {
		if (hasErrnoCode(error, "ENOENT")) {
			return {
				featureName,
				tasksPath: displayTasksPath,
				tasks: [],
				sections,
				warning: `Task directory not found: ${displayTasksPath}`,
			};
		}

		return {
			featureName,
			tasksPath: displayTasksPath,
			tasks: [],
			sections,
			warning: `Could not read task directory: ${displayTasksPath}. ${toErrorMessage(error)}`,
		};
	}

	const discoveredTaskFiles = entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "_active.md")
		.map((entry) => entry.name)
		.sort((left, right) => left.localeCompare(right));

	if (discoveredTaskFiles.length > MAX_TASK_FILES) {
		warnings.push(
			`Found ${discoveredTaskFiles.length} task files in ${displayTasksPath}; loading first ${MAX_TASK_FILES} files only.`,
		);
	}

	const taskFiles = discoveredTaskFiles.slice(0, MAX_TASK_FILES);
	const parsedTasks = await Promise.all(
		taskFiles.map((fileName) =>
			readAndParseTaskFile({
				projectRoot,
				tasksPath,
				fileName,
				warnings,
			}),
		),
	);

	const tasks = parsedTasks.filter((task): task is ProductTaskItem => task !== undefined);
	tasks.sort(compareTaskItems);
	for (const task of tasks) {
		sections[task.groupStatus].push(task);
	}

	return {
		featureName,
		tasksPath: displayTasksPath,
		tasks,
		sections,
		warning: warnings.length > 0 ? warnings.join(" | ") : undefined,
	};
}

async function readAndParseTaskFile(params: {
	projectRoot: string;
	tasksPath: string;
	fileName: string;
	warnings: string[];
}): Promise<ProductTaskItem | undefined> {
	const { projectRoot, tasksPath, fileName, warnings } = params;
	const absolutePath = path.join(tasksPath, fileName);
	const relativePath = toPosixPath(path.relative(projectRoot, absolutePath));

	let fileStats;
	try {
		fileStats = await stat(absolutePath);
	} catch (error) {
		warnings.push(`Could not stat ${relativePath}: ${toErrorMessage(error)}`);
		return undefined;
	}

	if (!fileStats.isFile()) {
		warnings.push(`Skipping non-file task entry: ${relativePath}.`);
		return undefined;
	}

	if (fileStats.size > MAX_TASK_FILE_SIZE_BYTES) {
		warnings.push(
			`Skipping ${relativePath}: file size ${fileStats.size} bytes exceeds ${MAX_TASK_FILE_SIZE_BYTES} byte limit.`,
		);
		return undefined;
	}

	let content = "";
	try {
		content = await readFile(absolutePath, "utf8");
	} catch (error) {
		warnings.push(`Could not read ${relativePath}: ${toErrorMessage(error)}`);
		return undefined;
	}

	try {
		return parseTaskFile({
			content,
			fileName,
			relativePath,
			warnings,
		});
	} catch (error) {
		warnings.push(`Could not parse ${relativePath}: ${toErrorMessage(error)}`);
		return undefined;
	}
}

function parseTaskFile(params: {
	content: string;
	fileName: string;
	relativePath: string;
	warnings: string[];
}): ProductTaskItem {
	const { content, fileName, relativePath, warnings } = params;
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);

	const id = parseTaskId(frontmatter.id, fileName, relativePath, warnings);
	const rawStatus = parseTaskStatus(frontmatter.status, relativePath, warnings);
	const depends = parseDepends(frontmatter.depends, relativePath, warnings);
	const title = parseTitle(body, fileName);

	return {
		id,
		title,
		path: relativePath,
		rawStatus,
		groupStatus: mapRawStatusToGroup(rawStatus),
		depends,
		isBlocked: rawStatus === "blocked",
	};
}

function parseTaskId(
	value: unknown,
	fileName: string,
	relativePath: string,
	warnings: string[],
): string {
	if (typeof value === "string" && value.trim().length > 0) {
		return normalizeTaskIdentifier(value);
	}

	if (typeof value === "number" && Number.isFinite(value)) {
		return normalizeTaskIdentifier(value);
	}

	const fileIdMatch = /^(\d{1,})/.exec(fileName);
	if (fileIdMatch?.[1]) {
		warnings.push(`Task ${relativePath} is missing frontmatter id; using filename id ${fileIdMatch[1]}.`);
		return normalizeTaskIdentifier(fileIdMatch[1]);
	}

	warnings.push(`Task ${relativePath} is missing frontmatter id; using filename as fallback.`);
	return fileName.replace(/\.md$/i, "");
}

function parseTaskStatus(value: unknown, relativePath: string, warnings: string[]): ProductTaskRawStatus {
	if (isTaskStatus(value)) {
		return value;
	}

	warnings.push(`Task ${relativePath} has invalid status; defaulting to \"open\".`);
	return "open";
}

function parseDepends(value: unknown, relativePath: string, warnings: string[]): string[] {
	if (value === undefined) return [];

	if (Array.isArray(value)) {
		const depends: string[] = [];
		for (const entry of value) {
			if (typeof entry === "string" && entry.trim().length > 0) {
				depends.push(normalizeTaskIdentifier(entry));
				continue;
			}

			if (typeof entry === "number" && Number.isFinite(entry)) {
				depends.push(normalizeTaskIdentifier(entry));
				continue;
			}

			warnings.push(`Task ${relativePath} has invalid depends entry; skipping unsupported value.`);
		}
		return depends;
	}

	if (typeof value === "string") {
		const normalized = value
			.trim()
			.replace(/^\[/, "")
			.replace(/\]$/, "");
		if (!normalized) return [];
		return normalized
			.split(",")
			.map((entry) => normalizeTaskIdentifier(entry))
			.filter((entry) => entry.length > 0);
	}

	warnings.push(`Task ${relativePath} has invalid depends field; expected array.`);
	return [];
}

function parseTitle(body: string, fileName: string): string {
	const headingMatch = /^#\s+(.+)$/m.exec(body);
	if (headingMatch?.[1]) {
		return headingMatch[1].trim();
	}

	return fileName
		.replace(/\.md$/i, "")
		.replace(/^\d{1,}-?/, "")
		.replace(/[-_]+/g, " ")
		.trim();
}

function mapRawStatusToGroup(status: ProductTaskRawStatus): ProductTaskGroupStatus {
	switch (status) {
		case "in-progress":
			return "In Progress";
		case "done":
			return "Done";
		case "open":
		case "blocked":
		default:
			return "TODO";
	}
}

function compareTaskItems(left: ProductTaskItem, right: ProductTaskItem): number {
	const leftIsNumeric = isNumericIdentifier(left.id);
	const rightIsNumeric = isNumericIdentifier(right.id);

	if (leftIsNumeric && rightIsNumeric) {
		const leftNumeric = Number(left.id);
		const rightNumeric = Number(right.id);
		if (leftNumeric !== rightNumeric) {
			return leftNumeric - rightNumeric;
		}
	}

	if (leftIsNumeric !== rightIsNumeric) {
		return leftIsNumeric ? -1 : 1;
	}

	return left.path.localeCompare(right.path);
}

function createEmptySections(): Record<ProductTaskGroupStatus, ProductTaskItem[]> {
	const sections = {} as Record<ProductTaskGroupStatus, ProductTaskItem[]>;
	for (const group of TASK_GROUP_ORDER) {
		sections[group] = [];
	}
	return sections;
}

function normalizeTaskIdentifier(value: string | number): string {
	const rawValue = typeof value === "number" ? String(value) : value.trim();
	if (/^\d+$/.test(rawValue)) {
		return rawValue.padStart(3, "0");
	}
	return rawValue;
}

function isTaskStatus(value: unknown): value is ProductTaskRawStatus {
	return value === "open" || value === "in-progress" || value === "done" || value === "blocked";
}

function isNumericIdentifier(value: string): boolean {
	return /^\d+$/.test(value);
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

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function toPosixPath(value: string): string {
	return value.split(path.sep).join("/");
}
