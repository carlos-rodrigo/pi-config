import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

export type LoopJobState = "running" | "completed" | "failed" | "cancelled";
export type TaskStatus = "draft" | "ready" | "blocked" | "done" | "open";
export type TaskAssociation = "explicit" | "inferred" | "unassigned";
export type MonitorView = "tasks" | "loops";

export interface PersistedLoopJob {
	jobId: string;
	feature: string;
	task?: string;
	cwd: string;
	createdAt: string;
	updatedAt: string;
	state: LoopJobState;
	maxIterations: number;
	pollSeconds: number;
	loopLogPath: string;
	completedAt?: string;
	summary?: string;
	errorMessage?: string;
}

export interface ActiveTask {
	id: string;
	title: string;
	status: TaskStatus;
}

export interface ActiveTaskBoard {
	current?: string;
	next?: string;
	blockers?: string;
	tasks: Map<string, ActiveTask>;
}

export interface ProjectTask {
	id: string;
	feature: string;
	title: string;
	status: TaskStatus;
	filePath: string;
	content: string;
}

export interface CurrentIteration {
	iteration?: number;
	maxIterations?: number;
	finished: boolean;
	lines: string[];
	sourceLineCount: number;
	markerMissing?: boolean;
}

export interface LoopMonitorItem {
	job: PersistedLoopJob;
	taskId: string;
	taskTitle?: string;
	taskStatus?: TaskStatus;
	association: TaskAssociation;
	board: ActiveTaskBoard;
	iteration: CurrentIteration;
	logUpdatedAt?: number;
}

export interface TaskMonitorEntry {
	task: ProjectTask;
	loops: LoopMonitorItem[];
}

export interface TaskSections {
	ready: TaskMonitorEntry[];
	inProgress: TaskMonitorEntry[];
}

export interface LoopMonitorSnapshot {
	cwd: string;
	loadedAt: number;
	tasks: ProjectTask[];
	items: LoopMonitorItem[];
	warnings: string[];
}

interface LoadOptions {
	now?: number;
	maxLogLines?: number;
}

interface ComponentOptions {
	now?: () => number;
	autoRefresh?: boolean;
	refreshIntervalMs?: number;
	initialView?: MonitorView;
}

const RECENT_JOB_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_MONITORED_JOBS = 10;
const MAX_LOG_READ_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_LOG_LINES = 500;
const DEFAULT_REFRESH_INTERVAL_MS = 1500;
const MIN_LOG_ROWS = 4;
const MAX_MONITOR_HEIGHT = 32;
const MIN_SIDEBAR_WIDTH = 18;
const MAX_SIDEBAR_WIDTH = 40;
const MONITOR_BORDER_COLOR = "thinkingXhigh";
const MONITOR_DIVIDER_COLOR = "error";

function isLoopJobState(value: unknown): value is LoopJobState {
	return value === "running" || value === "completed" || value === "failed" || value === "cancelled";
}

function isPersistedLoopJob(value: unknown): value is PersistedLoopJob {
	if (!value || typeof value !== "object") return false;
	const job = value as Partial<PersistedLoopJob>;
	return typeof job.jobId === "string"
		&& typeof job.feature === "string"
		&& typeof job.cwd === "string"
		&& typeof job.createdAt === "string"
		&& typeof job.updatedAt === "string"
		&& isLoopJobState(job.state)
		&& typeof job.maxIterations === "number"
		&& typeof job.pollSeconds === "number"
		&& typeof job.loopLogPath === "string";
}

function timestamp(value: string | undefined): number {
	if (!value) return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function loopActivityTime(item: LoopMonitorItem): number {
	return item.logUpdatedAt ?? timestamp(item.job.updatedAt);
}

function normalizedProjectPath(value: string): string {
	const resolved = path.resolve(value);
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

export function selectCurrentProjectJobs(
	jobs: readonly PersistedLoopJob[],
	cwd: string,
	now = Date.now(),
): PersistedLoopJob[] {
	const project = normalizedProjectPath(cwd);
	const cutoff = now - RECENT_JOB_WINDOW_MS;
	return jobs
		.filter((job) => normalizedProjectPath(job.cwd) === project)
		.filter((job) => job.state === "running" || timestamp(job.completedAt ?? job.updatedAt) >= cutoff)
		.sort((a, b) => {
			if (a.state === "running" && b.state !== "running") return -1;
			if (a.state !== "running" && b.state === "running") return 1;
			return timestamp(b.completedAt ?? b.updatedAt ?? b.createdAt) - timestamp(a.completedAt ?? a.updatedAt ?? a.createdAt);
		})
		.slice(0, MAX_MONITORED_JOBS);
}

function cleanBoardValue(value: string): string {
	return value.trim().replace(/^`|`$/g, "").replace(/^\*\*|\*\*$/g, "").trim();
}

function isTaskStatus(value: string): value is TaskStatus {
	return value === "draft" || value === "ready" || value === "blocked" || value === "done" || value === "open";
}

export function parseActiveTaskBoard(markdown: string): ActiveTaskBoard {
	const board: ActiveTaskBoard = { tasks: new Map() };
	for (const line of markdown.split(/\r?\n/)) {
		const field = line.match(/^\s*-\s*(Current|Next|Blockers):\s*(.*?)\s*$/i);
		if (field) {
			const value = cleanBoardValue(field[2] ?? "");
			switch (field[1]?.toLowerCase()) {
				case "current": board.current = value; break;
				case "next": board.next = value; break;
				case "blockers": board.blockers = value; break;
			}
			continue;
		}

		const task = line.match(/^\s*-\s*\[[ xX]\]\s*(TASK-[A-Za-z0-9_.-]+)\s+[—-]\s+(.+?)\s+\((draft|ready|blocked|done|open)\)\s*$/i);
		if (!task) continue;
		const status = task[3]!.toLowerCase();
		if (!isTaskStatus(status)) continue;
		const activeTask = { id: task[1]!, title: task[2]!.trim(), status };
		board.tasks.set(activeTask.id.toUpperCase(), activeTask);
	}
	return board;
}

export function parseTaskBrief(markdown: string, feature: string, filePath: string): ProjectTask | undefined {
	const frontmatter = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!frontmatter) return undefined;
	const fields = new Map<string, string>();
	for (const line of frontmatter[1]!.split(/\r?\n/)) {
		const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
		if (field) fields.set(field[1]!.toLowerCase(), field[2]!.replace(/\s+#.*$/, "").trim());
	}
	const id = fields.get("id")?.replace(/^['"]|['"]$/g, "");
	const status = fields.get("status")?.replace(/^['"]|['"]$/g, "").toLowerCase();
	if (!id || !/^TASK-[A-Za-z0-9_.-]+$/i.test(id) || !status || !isTaskStatus(status)) return undefined;

	const body = markdown.slice(frontmatter[0].length).trimStart();
	const heading = body.match(/^#\s+(TASK-[A-Za-z0-9_.-]+)\s+[—-]\s+(.+?)\s*$/m);
	if (!heading || heading[1]!.toUpperCase() !== id.toUpperCase()) return undefined;
	const content = stripTerminalControls(body.slice(heading.index! + heading[0].length)).trim();
	return {
		id,
		feature,
		title: stripTerminalControls(heading[2]!).trim(),
		status,
		filePath,
		content,
	};
}

export function stripTerminalControls(text: string): string {
	return text
		.replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
		.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u001B[@-_]/g, "")
		.replace(/\r(?!\n)/g, "\n")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F-\u009F]/g, "");
}

function sanitizeDisplayValue(text: string): string {
	return stripTerminalControls(text).replace(/\s+/g, " ").trim();
}

export function extractCurrentIteration(log: string, maxLines = DEFAULT_MAX_LOG_LINES): CurrentIteration {
	const sanitized = stripTerminalControls(log);
	const starts = [...sanitized.matchAll(/^\[iteration\s+(\d+)\/(\d+)\]\s+started[^\n]*$/gm)];
	if (starts.length === 0) {
		const fallback = sanitized.split("\n").filter((line, index, lines) => line.length > 0 || index < lines.length - 1);
		return {
			finished: false,
			lines: fallback.slice(-maxLines),
			sourceLineCount: fallback.length,
			markerMissing: sanitized.trim().length > 0,
		};
	}

	const latest = starts.at(-1)!;
	const iteration = Number(latest[1]);
	const maxIterations = Number(latest[2]);
	const segment = sanitized.slice(latest.index!);
	const finishPattern = new RegExp(`^\\[iteration\\s+${iteration}\\/${maxIterations}\\]\\s+finished[^\\n]*$`, "m");
	const finish = finishPattern.exec(segment);
	const bounded = finish ? segment.slice(0, finish.index + finish[0].length) : segment;
	const lines = bounded.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return {
		iteration,
		maxIterations,
		finished: Boolean(finish),
		lines: lines.slice(-maxLines),
		sourceLineCount: lines.length,
	};
}

function safeProjectFile(cwd: string, candidate: string): string | undefined {
	const project = normalizedProjectPath(cwd);
	const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(cwd, candidate);
	const comparable = normalizedProjectPath(resolved);
	const relative = path.relative(project, comparable);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	return resolved;
}

async function readTextFileIfSafe(cwd: string, candidate: string): Promise<string> {
	const resolved = safeProjectFile(cwd, candidate);
	if (!resolved) return "";
	const stat = await fs.promises.lstat(resolved).catch(() => undefined);
	if (!stat?.isFile() || stat.isSymbolicLink()) return "";
	return fs.promises.readFile(resolved, "utf8").catch(() => "");
}

async function readProjectTasks(cwd: string): Promise<{ tasks: ProjectTask[]; warnings: string[] }> {
	const featureRoot = path.join(cwd, ".features");
	const featureEntries = await fs.promises.readdir(featureRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	const tasks: ProjectTask[] = [];
	const warnings: string[] = [];

	for (const featureEntry of featureEntries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!featureEntry.isDirectory()) continue;
		const taskRoot = path.join(featureRoot, featureEntry.name, "tasks");
		const taskRootStat = await fs.promises.lstat(taskRoot).catch(() => undefined);
		if (!taskRootStat?.isDirectory() || taskRootStat.isSymbolicLink()) continue;
		const taskEntries = await fs.promises.readdir(taskRoot, { withFileTypes: true }).catch(() => []);
		for (const taskEntry of taskEntries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (!taskEntry.isFile() || !taskEntry.name.endsWith(".md")) continue;
			if (taskEntry.name.startsWith("_") || /^readme\.md$/i.test(taskEntry.name)) continue;
			const filePath = path.join(taskRoot, taskEntry.name);
			const markdown = await readTextFileIfSafe(cwd, filePath);
			const task = parseTaskBrief(markdown, featureEntry.name, filePath);
			if (task) tasks.push(task);
			else warnings.push(`${featureEntry.name}/${taskEntry.name}: invalid task brief`);
		}
	}

	tasks.sort((a, b) => a.feature.localeCompare(b.feature) || a.id.localeCompare(b.id));
	return { tasks, warnings };
}

async function readLogTail(cwd: string, candidate: string): Promise<{ text: string; updatedAt?: number }> {
	const resolved = safeProjectFile(cwd, candidate);
	if (!resolved) return { text: "" };
	const stat = await fs.promises.lstat(resolved).catch(() => undefined);
	if (!stat?.isFile() || stat.isSymbolicLink()) return { text: "" };

	try {
		const handle = await fs.promises.open(resolved, "r");
		try {
			const start = Math.max(0, stat.size - MAX_LOG_READ_BYTES);
			const buffer = Buffer.alloc(stat.size - start);
			if (buffer.length > 0) await handle.read(buffer, 0, buffer.length, start);
			let text = buffer.toString("utf8");
			if (start > 0) {
				const firstNewline = text.indexOf("\n");
				text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
			}
			return { text, updatedAt: stat.mtimeMs };
		} finally {
			await handle.close();
		}
	} catch {
		return { text: "" };
	}
}

async function readPersistedJobs(cwd: string): Promise<{ jobs: PersistedLoopJob[]; warnings: string[] }> {
	const root = path.join(cwd, ".pi", "loop-jobs");
	const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	const jobs: PersistedLoopJob[] = [];
	const warnings: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			const raw = JSON.parse(await fs.promises.readFile(path.join(root, entry.name, "status.json"), "utf8"));
			if (isPersistedLoopJob(raw)) jobs.push(raw);
			else warnings.push(`${entry.name}: invalid status`);
		} catch {
			warnings.push(`${entry.name}: unreadable status`);
		}
	}
	return { jobs, warnings };
}

function loopTaskReference(job: PersistedLoopJob, board: ActiveTaskBoard): { taskId: string; association: TaskAssociation } {
	if (job.task?.trim()) return { taskId: job.task.trim(), association: "explicit" };
	if (job.state === "running" && board.current && /^TASK-[A-Za-z0-9_.-]+$/i.test(board.current)) {
		return { taskId: board.current, association: "inferred" };
	}
	return { taskId: "feature loop", association: "unassigned" };
}

function taskKey(feature: string, taskId: string): string {
	return `${feature}\u0000${taskId.toUpperCase()}`;
}

function compareTaskEntries(a: TaskMonitorEntry, b: TaskMonitorEntry): number {
	return a.task.feature.localeCompare(b.task.feature) || a.task.id.localeCompare(b.task.id);
}

export function buildTaskSections(tasks: readonly ProjectTask[], loops: readonly LoopMonitorItem[]): TaskSections {
	const runningByTask = new Map<string, LoopMonitorItem[]>();
	for (const item of loops) {
		if (item.job.state !== "running" || item.association === "unassigned") continue;
		const key = taskKey(item.job.feature, item.taskId);
		const associated = runningByTask.get(key) ?? [];
		associated.push(item);
		associated.sort((a, b) => loopActivityTime(b) - loopActivityTime(a));
		runningByTask.set(key, associated);
	}

	const ready: TaskMonitorEntry[] = [];
	const inProgress: TaskMonitorEntry[] = [];
	const seenTasks = new Set<string>();
	for (const task of tasks) {
		const key = taskKey(task.feature, task.id);
		if (seenTasks.has(key)) continue;
		seenTasks.add(key);
		const associated = runningByTask.get(key) ?? [];
		if (associated.length > 0) inProgress.push({ task, loops: associated });
		else if (task.status === "ready" || task.status === "open") ready.push({ task, loops: [] });
	}
	ready.sort(compareTaskEntries);
	inProgress.sort(compareTaskEntries);
	return { ready, inProgress };
}

export async function loadLoopMonitorSnapshot(cwd: string, options: LoadOptions = {}): Promise<LoopMonitorSnapshot> {
	const now = options.now ?? Date.now();
	const maxLogLines = options.maxLogLines ?? DEFAULT_MAX_LOG_LINES;
	const [{ jobs, warnings: jobWarnings }, { tasks, warnings: taskWarnings }] = await Promise.all([
		readPersistedJobs(cwd),
		readProjectTasks(cwd),
	]);
	const selected = selectCurrentProjectJobs(jobs, cwd, now);
	const boards = new Map<string, ActiveTaskBoard>();
	const taskLookup = new Map(tasks.map((task) => [taskKey(task.feature, task.id), task]));
	const items: LoopMonitorItem[] = [];

	for (const job of selected) {
		let board = boards.get(job.feature);
		if (!board) {
			const activePath = path.join(cwd, ".features", job.feature, "tasks", "_active.md");
			board = parseActiveTaskBoard(await readTextFileIfSafe(cwd, activePath));
			boards.set(job.feature, board);
		}
		const reference = loopTaskReference(job, board);
		const projectTask = taskLookup.get(taskKey(job.feature, reference.taskId));
		const boardTask = board.tasks.get(reference.taskId.toUpperCase());
		const log = await readLogTail(cwd, job.loopLogPath);
		items.push({
			job,
			taskId: reference.taskId,
			taskTitle: projectTask?.title ?? boardTask?.title,
			taskStatus: projectTask?.status ?? boardTask?.status,
			association: reference.association,
			board,
			iteration: extractCurrentIteration(log.text, maxLogLines),
			logUpdatedAt: log.updatedAt,
		});
	}

	return {
		cwd: path.resolve(cwd),
		loadedAt: now,
		tasks,
		items,
		warnings: [...jobWarnings, ...taskWarnings],
	};
}

function formatAge(time: number | undefined, now: number): string {
	if (!time) return "never";
	const seconds = Math.max(0, Math.floor((now - time) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

function frameLine(content: string, width: number, theme: Theme): string {
	if (width < 4) return truncateToWidth(content, width, "");
	const available = width - 4;
	const clipped = truncateToWidth(content, available, "…");
	const padding = " ".repeat(Math.max(0, available - visibleWidth(clipped)));
	return `${theme.fg(MONITOR_BORDER_COLOR, "│")} ${clipped}${padding} ${theme.fg(MONITOR_BORDER_COLOR, "│")}`;
}

function frameBorder(title: string | undefined, width: number, top: boolean, theme: Theme): string {
	const left = top ? "┌" : "└";
	const right = top ? "┐" : "┘";
	if (!title || width < visibleWidth(title) + 6) return theme.fg(MONITOR_BORDER_COLOR, `${left}${"─".repeat(Math.max(0, width - 2))}${right}`);
	const styledTitle = theme.fg("accent", theme.bold(` ${title} `));
	const fill = Math.max(0, width - visibleWidth(styledTitle) - 3);
	return `${theme.fg(MONITOR_BORDER_COLOR, `${left}─`)}${styledTitle}${theme.fg(MONITOR_BORDER_COLOR, `${"─".repeat(fill)}${right}`)}`;
}

function padToWidth(content: string, width: number): string {
	const clipped = truncateToWidth(content, Math.max(0, width), "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function splitFrameLine(left: string, right: string, width: number, leftWidth: number, theme: Theme): string {
	const rightWidth = Math.max(0, width - leftWidth - 3);
	return `${theme.fg(MONITOR_BORDER_COLOR, "│")}${padToWidth(left, leftWidth)}${theme.fg(MONITOR_DIVIDER_COLOR, "│")}${padToWidth(right, rightWidth)}${theme.fg(MONITOR_BORDER_COLOR, "│")}`;
}

function splitFrameSeparator(width: number, leftWidth: number, theme: Theme): string {
	const rightWidth = Math.max(0, width - leftWidth - 3);
	return theme.fg(MONITOR_DIVIDER_COLOR, `├${"─".repeat(leftWidth)}┼${"─".repeat(rightWidth)}┤`);
}

function wrapPlainText(text: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const wrapped: string[] = [];
	for (const sourceLine of stripTerminalControls(text).replace(/\t/g, "    ").split(/\r?\n/)) {
		let remaining = sourceLine.trimEnd();
		if (remaining.length === 0) {
			wrapped.push("");
			continue;
		}
		while (visibleWidth(remaining) > safeWidth) {
			const characters = Array.from(remaining);
			let used = 0;
			let fit = 0;
			let lastSpace = -1;
			for (let index = 0; index < characters.length; index++) {
				const characterWidth = visibleWidth(characters[index]!);
				if (used + characterWidth > safeWidth) break;
				used += characterWidth;
				fit = index + 1;
				if (/\s/.test(characters[index]!)) lastSpace = fit;
			}
			const cut = lastSpace > 0 ? lastSpace : Math.max(1, fit);
			wrapped.push(characters.slice(0, cut).join("").trimEnd());
			remaining = characters.slice(cut).join("").trimStart();
		}
		wrapped.push(remaining);
	}
	return wrapped;
}

function stateText(state: LoopJobState, theme: Theme): string {
	switch (state) {
		case "running": return theme.fg("success", "● running");
		case "failed": return theme.fg("error", "● failed");
		case "cancelled": return theme.fg("warning", "○ cancelled");
		case "completed": return theme.fg("muted", "✓ completed");
	}
}

export class LoopMonitorComponent {
	private readonly tui: Pick<TUI, "requestRender" | "terminal">;
	private readonly theme: Theme;
	private readonly loader: () => Promise<LoopMonitorSnapshot>;
	private readonly onClose: () => void;
	private snapshot: LoopMonitorSnapshot;
	private view: MonitorView;
	private selectedTaskKey?: string;
	private selectedLoopId?: string;
	private taskSidebarScroll = 0;
	private loopSidebarScroll = 0;
	private taskContentScroll = 0;
	private taskContentLineCount = 0;
	private taskContentRows = 1;
	private expandedTask = false;
	private activeLogJobId?: string;
	private logScroll = 0;
	private lastLogRows = MIN_LOG_ROWS;
	private following = true;
	private seenLineCount = 0;
	private refreshing = false;
	private refreshError?: string;
	private interval?: ReturnType<typeof setInterval>;
	private disposed = false;
	private readonly now: () => number;

	constructor(
		tui: Pick<TUI, "requestRender" | "terminal">,
		theme: Theme,
		initialSnapshot: LoopMonitorSnapshot,
		loader: () => Promise<LoopMonitorSnapshot>,
		onClose: () => void,
		options: ComponentOptions = {},
	) {
		this.tui = tui;
		this.theme = theme;
		this.loader = loader;
		this.onClose = onClose;
		this.snapshot = initialSnapshot;
		this.view = options.initialView ?? "tasks";
		this.now = options.now ?? Date.now;
		this.ensureSelections();
		if (options.autoRefresh !== false) {
			this.interval = setInterval(() => void this.refresh(), options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS);
			this.interval.unref?.();
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") {
			this.dispose();
			this.onClose();
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
			this.view = this.view === "tasks" ? "loops" : "tasks";
			this.ensureSelections();
			this.syncActiveLog();
			this.tui.requestRender();
			return;
		}
		if (data === "r") {
			void this.refresh();
			return;
		}
		if (data === "o") {
			this.openRelatedItem();
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			this.moveSelection(-1);
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			this.moveSelection(1);
			return;
		}
		if (matchesKey(data, Key.enter) || data === "\r") {
			if (this.view === "tasks" && (this.selectedTaskEntry()?.loops.length ?? 0) > 0) {
				this.expandedTask = !this.expandedTask;
				this.taskContentScroll = 0;
				this.syncActiveLog();
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollDetail(-1);
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollDetail(1);
			return;
		}
		if (matchesKey(data, Key.home) || data === "g") {
			const item = this.outputItem();
			if (item) {
				this.activateLog(item);
				this.following = false;
				this.logScroll = 0;
			} else {
				this.taskContentScroll = 0;
			}
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.end) || data === "G") {
			if (this.outputItem()) this.resumeFollowing();
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		if (safeWidth < 24) return [truncateToWidth("Work Monitor requires a wider terminal", safeWidth, "")];
		this.ensureSelections();
		this.syncActiveLog();
		const now = this.now();
		const terminalRows = this.tui.terminal.rows || 24;
		const totalHeight = Math.max(15, Math.min(MAX_MONITOR_HEIGHT, Math.floor(terminalRows * 0.9)));
		const bodyRows = Math.max(9, totalHeight - 6);
		const leftWidth = Math.min(
			Math.max(8, safeWidth - 13),
			Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.floor((safeWidth - 3) * 0.34))),
		);
		const rightWidth = Math.max(1, safeWidth - leftWidth - 3);
		const taskSections = buildTaskSections(this.snapshot.tasks, this.snapshot.items);
		const running = this.snapshot.items.filter((candidate) => candidate.job.state === "running").length;
		const projectName = sanitizeDisplayValue(path.basename(this.snapshot.cwd) || this.snapshot.cwd);
		const tasksTab = this.view === "tasks" ? this.theme.fg("accent", "[Tasks]") : "Tasks";
		const loopsTab = this.view === "loops" ? this.theme.fg("accent", "[Loops]") : "Loops";
		const activity = `${running} running · refreshed ${formatAge(this.snapshot.loadedAt, now)} ago`;
		const lines = [
			frameBorder(`Work Monitor · ${projectName}`, safeWidth, true, this.theme),
			frameLine(`${tasksTab}  ${loopsTab} · ${activity}`, safeWidth, this.theme),
			splitFrameSeparator(safeWidth, leftWidth, this.theme),
		];
		const sidebar = this.view === "tasks"
			? this.renderTaskSidebar(taskSections, bodyRows)
			: this.renderLoopSidebar(bodyRows, now);
		const detail = this.view === "tasks"
			? this.renderTaskDetail(bodyRows, rightWidth, now)
			: this.renderLoopDetail(bodyRows, rightWidth, now);
		for (let row = 0; row < bodyRows; row++) {
			lines.push(splitFrameLine(sidebar[row] ?? "", detail[row] ?? "", safeWidth, leftWidth, this.theme));
		}
		lines.push(splitFrameSeparator(safeWidth, leftWidth, this.theme));
		const rawWarning = this.refreshError ?? this.snapshot.warnings[0];
		const warning = rawWarning ? sanitizeDisplayValue(rawWarning) : undefined;
		const help = warning
			? `${this.theme.fg("warning", warning)} · r refresh · q close`
			: "↑↓/jk select · PgUp/PgDn detail · Tab view · o related · G follow · r refresh · q close";
		lines.push(frameLine(help, safeWidth, this.theme));
		lines.push(frameBorder(undefined, safeWidth, false, this.theme));
		return lines.map((line) => truncateToWidth(line, safeWidth, ""));
	}

	invalidate(): void {
		// Rendering is computed from current state and theme each time.
	}

	dispose(): void {
		this.disposed = true;
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = undefined;
		}
	}

	private taskEntries(): TaskMonitorEntry[] {
		const sections = buildTaskSections(this.snapshot.tasks, this.snapshot.items);
		return [...sections.ready, ...sections.inProgress];
	}

	private ensureSelections(): void {
		const sections = buildTaskSections(this.snapshot.tasks, this.snapshot.items);
		const taskEntries = [...sections.ready, ...sections.inProgress];
		if (!this.selectedTaskKey || !taskEntries.some((entry) => taskKey(entry.task.feature, entry.task.id) === this.selectedTaskKey)) {
			const preferred = sections.inProgress[0] ?? sections.ready[0];
			this.selectedTaskKey = preferred ? taskKey(preferred.task.feature, preferred.task.id) : undefined;
		}
		if (!this.selectedLoopId || !this.snapshot.items.some((item) => item.job.jobId === this.selectedLoopId)) {
			this.selectedLoopId = this.snapshot.items[0]?.job.jobId;
		}
	}

	private selectedTaskEntry(): TaskMonitorEntry | undefined {
		this.ensureSelections();
		return this.taskEntries().find((entry) => taskKey(entry.task.feature, entry.task.id) === this.selectedTaskKey);
	}

	private selectedLoopItem(): LoopMonitorItem | undefined {
		this.ensureSelections();
		return this.snapshot.items.find((item) => item.job.jobId === this.selectedLoopId);
	}

	private outputItem(): LoopMonitorItem | undefined {
		if (this.view === "loops") return this.selectedLoopItem();
		if (this.expandedTask) return undefined;
		return this.selectedTaskEntry()?.loops[0];
	}

	private activateLog(item: LoopMonitorItem): void {
		if (this.activeLogJobId === item.job.jobId) return;
		this.activeLogJobId = item.job.jobId;
		this.following = true;
		this.seenLineCount = item.iteration.sourceLineCount;
		this.logScroll = Math.max(0, item.iteration.lines.length - this.lastLogRows);
	}

	private syncActiveLog(): void {
		const item = this.outputItem();
		if (item) this.activateLog(item);
		else this.activeLogJobId = undefined;
	}

	private moveSelection(delta: number): void {
		if (this.view === "tasks") {
			const entries = this.taskEntries();
			if (entries.length === 0) return;
			const current = Math.max(0, entries.findIndex((entry) => taskKey(entry.task.feature, entry.task.id) === this.selectedTaskKey));
			const next = (current + delta + entries.length) % entries.length;
			this.selectedTaskKey = taskKey(entries[next]!.task.feature, entries[next]!.task.id);
			this.taskContentScroll = 0;
			this.expandedTask = false;
		} else {
			if (this.snapshot.items.length === 0) return;
			const current = Math.max(0, this.snapshot.items.findIndex((item) => item.job.jobId === this.selectedLoopId));
			const next = (current + delta + this.snapshot.items.length) % this.snapshot.items.length;
			this.selectedLoopId = this.snapshot.items[next]!.job.jobId;
		}
		this.syncActiveLog();
		this.tui.requestRender();
	}

	private openRelatedItem(): void {
		if (this.view === "tasks") {
			const loop = this.selectedTaskEntry()?.loops[0];
			if (!loop) return;
			this.selectedLoopId = loop.job.jobId;
			this.view = "loops";
		} else {
			const loop = this.selectedLoopItem();
			if (!loop || loop.association === "unassigned") return;
			const key = taskKey(loop.job.feature, loop.taskId);
			if (!this.taskEntries().some((entry) => taskKey(entry.task.feature, entry.task.id) === key)) return;
			this.selectedTaskKey = key;
			this.view = "tasks";
			this.expandedTask = false;
			this.taskContentScroll = 0;
		}
		this.syncActiveLog();
		this.tui.requestRender();
	}

	private scrollDetail(direction: -1 | 1): void {
		const item = this.outputItem();
		if (item) {
			this.activateLog(item);
			const lineCount = Math.max(1, item.iteration.lines.length);
			const maxScroll = Math.max(0, lineCount - this.lastLogRows);
			this.logScroll = Math.max(0, Math.min(maxScroll, this.logScroll + direction * this.lastLogRows));
			this.following = this.logScroll === maxScroll && direction > 0;
			if (this.following) this.seenLineCount = item.iteration.sourceLineCount;
		} else {
			const maxScroll = Math.max(0, this.taskContentLineCount - this.taskContentRows);
			this.taskContentScroll = Math.max(0, Math.min(maxScroll, this.taskContentScroll + direction * this.taskContentRows));
		}
		this.tui.requestRender();
	}

	private resumeFollowing(): void {
		const item = this.outputItem();
		if (!item) return;
		this.activateLog(item);
		this.following = true;
		this.seenLineCount = item.iteration.sourceLineCount;
		this.logScroll = Math.max(0, item.iteration.lines.length - this.lastLogRows);
	}

	private async refresh(): Promise<void> {
		if (this.disposed || this.refreshing) return;
		this.refreshing = true;
		this.tui.requestRender();
		const previousTasks = this.taskEntries();
		const previousTaskIndex = Math.max(0, previousTasks.findIndex((entry) => taskKey(entry.task.feature, entry.task.id) === this.selectedTaskKey));
		const previousLoopIndex = Math.max(0, this.snapshot.items.findIndex((item) => item.job.jobId === this.selectedLoopId));
		const previousOutput = this.outputItem();
		const previousIteration = previousOutput?.iteration.iteration;
		const previousTailStart = previousOutput
			? Math.max(0, previousOutput.iteration.sourceLineCount - previousOutput.iteration.lines.length)
			: 0;
		const previousAbsoluteScroll = previousTailStart + this.logScroll;
		try {
			const next = await this.loader();
			this.snapshot = next;
			this.refreshError = undefined;
			const nextTasks = this.taskEntries();
			if (!nextTasks.some((entry) => taskKey(entry.task.feature, entry.task.id) === this.selectedTaskKey)) {
				const fallback = nextTasks[Math.min(previousTaskIndex, Math.max(0, nextTasks.length - 1))];
				this.selectedTaskKey = fallback ? taskKey(fallback.task.feature, fallback.task.id) : undefined;
			}
			if (!next.items.some((item) => item.job.jobId === this.selectedLoopId)) {
				this.selectedLoopId = next.items[Math.min(previousLoopIndex, Math.max(0, next.items.length - 1))]?.job.jobId;
			}
			this.ensureSelections();
			const currentOutput = this.outputItem();
			if (currentOutput?.job.jobId !== previousOutput?.job.jobId) {
				this.activeLogJobId = undefined;
				this.syncActiveLog();
			} else if (currentOutput && currentOutput.iteration.iteration !== previousIteration) {
				this.following = true;
				this.resumeFollowing();
			} else if (
				currentOutput
				&& previousOutput
				&& !this.following
				&& currentOutput.iteration.sourceLineCount >= previousOutput.iteration.sourceLineCount
			) {
				const currentTailStart = Math.max(0, currentOutput.iteration.sourceLineCount - currentOutput.iteration.lines.length);
				this.logScroll = Math.max(0, previousAbsoluteScroll - currentTailStart);
			} else if (currentOutput && this.following) {
				this.resumeFollowing();
			}
		} catch (error) {
			this.refreshError = error instanceof Error ? error.message : String(error);
		} finally {
			this.refreshing = false;
			if (!this.disposed) this.tui.requestRender();
		}
	}

	private visibleSidebarRows(
		rows: Array<{ text: string; selected?: boolean }>,
		height: number,
		view: MonitorView,
	): string[] {
		const selectedRow = rows.findIndex((row) => row.selected);
		let scroll = view === "tasks" ? this.taskSidebarScroll : this.loopSidebarScroll;
		const maxScroll = Math.max(0, rows.length - height);
		scroll = Math.max(0, Math.min(scroll, maxScroll));
		if (selectedRow >= 0 && selectedRow < scroll) scroll = selectedRow;
		else if (selectedRow >= scroll + height) scroll = selectedRow - height + 1;
		if (view === "tasks") this.taskSidebarScroll = scroll;
		else this.loopSidebarScroll = scroll;
		return rows.slice(scroll, scroll + height).map((row) => row.text);
	}

	private renderTaskSidebar(sections: TaskSections, height: number): string[] {
		const rows: Array<{ text: string; selected?: boolean }> = [];
		const addSection = (label: string, entries: TaskMonitorEntry[]) => {
			rows.push({ text: this.theme.bold(` ${label} · ${entries.length}`) });
			if (entries.length === 0) rows.push({ text: this.theme.fg("dim", "   none") });
			for (const entry of entries) {
				const key = taskKey(entry.task.feature, entry.task.id);
				const selected = key === this.selectedTaskKey;
				const marker = selected ? this.theme.fg("accent", "▶") : " ";
				const runtime = entry.loops.length > 0
					? ` ${this.theme.fg("success", `● ${entry.loops[0]!.iteration.iteration ?? "—"}/${entry.loops[0]!.iteration.maxIterations ?? entry.loops[0]!.job.maxIterations}`)}`
					: "";
				rows.push({
					selected,
					text: `${marker} ${sanitizeDisplayValue(entry.task.id)}${runtime} · ${sanitizeDisplayValue(entry.task.title)}`,
				});
			}
		};
		addSection("READY", sections.ready);
		rows.push({ text: "" });
		addSection("IN PROGRESS", sections.inProgress);
		if (sections.ready.length + sections.inProgress.length === 0) {
			rows.push({ text: "" }, { text: this.theme.fg("dim", " No active task briefs found.") });
		}
		return this.visibleSidebarRows(rows, height, "tasks");
	}

	private renderLoopSidebar(height: number, now: number): string[] {
		const rows: Array<{ text: string; selected?: boolean }> = [];
		const running = this.snapshot.items.filter((item) => item.job.state === "running");
		const recent = this.snapshot.items.filter((item) => item.job.state !== "running");
		const addSection = (label: string, items: LoopMonitorItem[]) => {
			rows.push({ text: this.theme.bold(` ${label} · ${items.length}`) });
			if (items.length === 0) rows.push({ text: this.theme.fg("dim", "   none") });
			for (const item of items) {
				const selected = item.job.jobId === this.selectedLoopId;
				const marker = selected ? this.theme.fg("accent", "▶") : " ";
				const feature = sanitizeDisplayValue(item.job.feature);
				const task = item.association === "unassigned" ? "feature loop" : sanitizeDisplayValue(item.taskId);
				const age = formatAge(item.logUpdatedAt ?? timestamp(item.job.updatedAt), now);
				rows.push({ selected, text: `${marker} ${feature}/${task} · ${age}` });
			}
		};
		addSection("RUNNING", running);
		rows.push({ text: "" });
		addSection("RECENT", recent);
		if (this.snapshot.items.length === 0) {
			rows.push({ text: "" }, { text: this.theme.fg("dim", " No current-project loops found.") });
		}
		return this.visibleSidebarRows(rows, height, "loops");
	}

	private renderTaskDetail(height: number, width: number, now: number): string[] {
		const entry = this.selectedTaskEntry();
		if (!entry) return [this.theme.fg("dim", " Select a ready or in-progress task.")];
		const task = entry.task;
		const loop = entry.loops[0];
		const rows: string[] = [
			this.theme.bold(` ${sanitizeDisplayValue(task.id)} — ${sanitizeDisplayValue(task.title)}`),
			` ${sanitizeDisplayValue(task.feature)} · stored status: ${task.status}`,
		];
		if (loop) {
			const association = loop.association === "inferred" ? "inferred from Current" : "explicit task";
			const iteration = loop.iteration.iteration
				? `${loop.iteration.iteration}/${loop.iteration.maxIterations ?? loop.job.maxIterations}`
				: `—/${loop.job.maxIterations}`;
			rows.push(` runtime: running · ${association} · iteration ${iteration}${entry.loops.length > 1 ? ` · ${entry.loops.length} loops` : ""}`);
		}

		const content = wrapPlainText(task.content || "Task content unavailable.", Math.max(1, width - 2));
		this.taskContentLineCount = content.length;
		if (!loop || this.expandedTask) {
			rows.push(` ${this.theme.fg("muted", `── TASK CONTENT${loop ? " · Enter to collapse" : ""}`)}`);
			this.taskContentRows = Math.max(1, height - rows.length);
			const maxScroll = Math.max(0, content.length - this.taskContentRows);
			this.taskContentScroll = Math.max(0, Math.min(this.taskContentScroll, maxScroll));
			for (const line of content.slice(this.taskContentScroll, this.taskContentScroll + this.taskContentRows)) {
				rows.push(` ${this.theme.fg("text", line)}`);
			}
			return rows.slice(0, height);
		}

		rows.push(` ${this.theme.fg("muted", "── TASK CONTENT · Enter to expand")}`);
		const excerptRows = Math.max(1, Math.min(4, height - rows.length - MIN_LOG_ROWS - 1));
		for (const line of content.slice(0, excerptRows)) rows.push(` ${this.theme.fg("text", line)}`);
		const logRows = Math.max(2, height - rows.length);
		rows.push(...this.renderLogBlock(loop, logRows, width, now));
		return rows.slice(0, height);
	}

	private renderLoopDetail(height: number, width: number, now: number): string[] {
		const item = this.selectedLoopItem();
		if (!item) return [this.theme.fg("dim", " Select a running or recent loop.")];
		const task = item.association === "unassigned"
			? "feature-level / unassigned"
			: `${sanitizeDisplayValue(item.taskId)}${item.taskTitle ? ` — ${sanitizeDisplayValue(item.taskTitle)}` : ""}`;
		const association = item.association === "inferred" ? "inferred from Current" : item.association;
		const rows = [
			this.theme.bold(` ${sanitizeDisplayValue(item.job.feature)} / ${task}`),
			` state: ${stateText(item.job.state, this.theme)} · association: ${association}`,
			` started ${formatAge(timestamp(item.job.createdAt), now)} ago · activity ${formatAge(item.logUpdatedAt ?? timestamp(item.job.updatedAt), now)} ago`,
		];
		if (item.job.errorMessage) rows.push(` ${this.theme.fg("error", sanitizeDisplayValue(item.job.errorMessage))}`);
		const logRows = Math.max(2, height - rows.length);
		rows.push(...this.renderLogBlock(item, logRows, width, now));
		return rows.slice(0, height);
	}

	private renderLogBlock(item: LoopMonitorItem, capacity: number, _width: number, now: number): string[] {
		this.activateLog(item);
		const rows: string[] = [];
		const iteration = item.iteration.iteration
			? `${item.iteration.finished ? "Last" : "Current"} iteration ${item.iteration.iteration}/${item.iteration.maxIterations ?? item.job.maxIterations}`
			: "Current iteration";
		const activityAge = item.logUpdatedAt ? now - item.logUpdatedAt : Number.POSITIVE_INFINITY;
		const staleAfter = Math.max(30_000, item.job.pollSeconds * 3000);
		const stale = item.job.state === "running" && activityAge > staleAfter;
		const unseen = Math.max(0, item.iteration.sourceLineCount - this.seenLineCount);
		const follow = item.job.state !== "running"
			? this.theme.fg("muted", "FINAL")
			: this.following
				? this.theme.fg("success", "FOLLOWING")
				: this.theme.fg("warning", `PAUSED${unseen > 0 ? ` · ${unseen} new` : ""}`);
		const activity = item.logUpdatedAt ? `updated ${formatAge(item.logUpdatedAt, now)} ago` : "waiting for first output";
		const staleLabel = stale ? this.theme.fg("warning", " · STALE") : "";
		const refreshing = this.refreshing ? this.theme.fg("dim", " · refreshing…") : "";
		rows.push(` ${this.theme.fg("muted", "──")} ${iteration} · ${follow} · ${activity}${staleLabel}${refreshing}`);

		const logLines = item.iteration.lines.length > 0
			? item.iteration.lines
			: [item.job.state === "running" ? "Waiting for first output…" : "Log unavailable."];
		this.lastLogRows = Math.max(1, capacity - 1);
		const maxScroll = Math.max(0, logLines.length - this.lastLogRows);
		if (this.following) {
			this.logScroll = maxScroll;
			this.seenLineCount = item.iteration.sourceLineCount;
		} else {
			this.logScroll = Math.max(0, Math.min(this.logScroll, maxScroll));
		}
		const visible = logLines.slice(this.logScroll, this.logScroll + this.lastLogRows);
		for (let index = 0; index < this.lastLogRows; index++) {
			const raw = visible[index] ?? "";
			const marker = item.iteration.markerMissing && this.logScroll === 0 && index === 0
				? this.theme.fg("warning", "[iteration marker unavailable] ")
				: "";
			rows.push(` ${marker}${this.theme.fg("text", raw)}`);
		}
		return rows.slice(0, capacity);
	}
}

async function showLoopMonitor(ctx: ExtensionContext, initialView: MonitorView): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`/${initialView} requires the interactive Pi TUI`, "error");
		return;
	}
	const load = () => loadLoopMonitorSnapshot(ctx.cwd);
	const initial = await load();
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => new LoopMonitorComponent(
			tui,
			theme,
			initial,
			load,
			() => done(undefined),
			{ initialView },
		),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "90%",
				minWidth: 50,
				maxHeight: "90%",
				margin: 1,
			},
		},
	);
}

export default function loopMonitorExtension(pi: ExtensionAPI) {
	pi.registerShortcut("ctrl+shift+l", {
		description: "Open current-project task and loop monitor",
		handler: async (ctx) => showLoopMonitor(ctx as ExtensionContext, "tasks"),
	});
	pi.registerCommand("tasks", {
		description: "Browse ready and in-progress tasks in the current project",
		handler: async (_args, ctx) => showLoopMonitor(ctx as ExtensionContext, "tasks"),
	});
	pi.registerCommand("loops", {
		description: "Monitor running and recent loops in the current project (Ctrl+Shift+L)",
		handler: async (_args, ctx) => showLoopMonitor(ctx as ExtensionContext, "loops"),
	});
}
