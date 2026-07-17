import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

export type LoopJobState = "running" | "completed" | "failed" | "cancelled";
export type TaskStatus = "draft" | "ready" | "blocked" | "done" | "open";

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
	board: ActiveTaskBoard;
	iteration: CurrentIteration;
	logUpdatedAt?: number;
}

export interface LoopMonitorSnapshot {
	cwd: string;
	loadedAt: number;
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
}

const RECENT_JOB_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_MONITORED_JOBS = 10;
const MAX_LOG_READ_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_LOG_LINES = 500;
const DEFAULT_REFRESH_INTERVAL_MS = 1500;
const MAX_JOB_ROWS = 4;
const MIN_LOG_ROWS = 4;
const MAX_LOG_ROWS = 12;

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

function taskIdFrom(job: PersistedLoopJob, board: ActiveTaskBoard): string {
	if (job.task?.trim()) return job.task.trim();
	if (board.current && /^TASK-[A-Za-z0-9_.-]+$/i.test(board.current)) return board.current;
	return "next ready task";
}

export async function loadLoopMonitorSnapshot(cwd: string, options: LoadOptions = {}): Promise<LoopMonitorSnapshot> {
	const now = options.now ?? Date.now();
	const maxLogLines = options.maxLogLines ?? DEFAULT_MAX_LOG_LINES;
	const { jobs, warnings } = await readPersistedJobs(cwd);
	const selected = selectCurrentProjectJobs(jobs, cwd, now);
	const boards = new Map<string, ActiveTaskBoard>();
	const items: LoopMonitorItem[] = [];

	for (const job of selected) {
		let board = boards.get(job.feature);
		if (!board) {
			const activePath = path.join(cwd, ".features", job.feature, "tasks", "_active.md");
			board = parseActiveTaskBoard(await readTextFileIfSafe(cwd, activePath));
			boards.set(job.feature, board);
		}
		const taskId = taskIdFrom(job, board);
		const task = board.tasks.get(taskId.toUpperCase());
		const log = await readLogTail(cwd, job.loopLogPath);
		items.push({
			job,
			taskId,
			taskTitle: task?.title,
			taskStatus: task?.status,
			board,
			iteration: extractCurrentIteration(log.text, maxLogLines),
			logUpdatedAt: log.updatedAt,
		});
	}

	return { cwd: path.resolve(cwd), loadedAt: now, items, warnings };
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
	return `${theme.fg("borderMuted", "│")} ${clipped}${padding} ${theme.fg("borderMuted", "│")}`;
}

function frameSeparator(width: number, theme: Theme): string {
	return theme.fg("borderMuted", `├${"─".repeat(Math.max(0, width - 2))}┤`);
}

function frameBorder(title: string | undefined, width: number, top: boolean, theme: Theme): string {
	const left = top ? "┌" : "└";
	const right = top ? "┐" : "┘";
	if (!title || width < visibleWidth(title) + 6) return theme.fg("borderMuted", `${left}${"─".repeat(Math.max(0, width - 2))}${right}`);
	const styledTitle = theme.fg("accent", theme.bold(` ${title} `));
	const fill = Math.max(0, width - visibleWidth(styledTitle) - 3);
	return `${theme.fg("borderMuted", `${left}─`)}${styledTitle}${theme.fg("borderMuted", `${"─".repeat(fill)}${right}`)}`;
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
	private selectedIndex = 0;
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
		this.now = options.now ?? Date.now;
		this.seenLineCount = this.selectedItem()?.iteration.sourceLineCount ?? 0;
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
		if (matchesKey(data, Key.tab)) {
			this.selectJob(1);
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			this.selectJob(-1);
			return;
		}
		if (data === "r") {
			void this.refresh();
			return;
		}

		const lineCount = this.selectedItem()?.iteration.lines.length ?? 0;
		const maxScroll = Math.max(0, lineCount - this.lastLogRows);
		if (matchesKey(data, Key.up) || data === "k") {
			this.following = false;
			this.logScroll = Math.max(0, Math.min(this.logScroll, maxScroll) - 1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.logScroll = Math.min(maxScroll, this.logScroll + 1);
			if (this.logScroll === maxScroll) this.resumeFollowing();
		} else if (matchesKey(data, Key.pageUp)) {
			this.following = false;
			this.logScroll = Math.max(0, Math.min(this.logScroll, maxScroll) - this.lastLogRows);
		} else if (matchesKey(data, Key.pageDown)) {
			this.logScroll = Math.min(maxScroll, this.logScroll + this.lastLogRows);
			if (this.logScroll === maxScroll) this.resumeFollowing();
		} else if (matchesKey(data, Key.home) || data === "g") {
			this.following = false;
			this.logScroll = 0;
		} else if (matchesKey(data, Key.end) || data === "G") {
			this.resumeFollowing();
		} else {
			return;
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const now = this.now();
		const item = this.selectedItem();
		const terminalRows = this.tui.terminal.rows || 24;
		const jobRows = Math.min(MAX_JOB_ROWS, Math.max(1, this.snapshot.items.length));
		const targetHeight = Math.max(15, Math.floor(terminalRows * 0.9) - 2);
		this.lastLogRows = Math.max(MIN_LOG_ROWS, Math.min(MAX_LOG_ROWS, targetHeight - 10 - jobRows));
		const lines: string[] = [];
		const running = this.snapshot.items.filter((candidate) => candidate.job.state === "running").length;
		const recent = this.snapshot.items.length - running;

		const projectName = sanitizeDisplayValue(path.basename(this.snapshot.cwd) || this.snapshot.cwd);
		const projectPath = sanitizeDisplayValue(this.snapshot.cwd);
		lines.push(frameBorder(`Loop Tasks · ${projectName}`, safeWidth, true, this.theme));
		lines.push(frameLine(`${running} running · ${recent} recent · current project: ${projectPath}`, safeWidth, this.theme));
		this.renderJobs(lines, safeWidth, now, jobRows);
		lines.push(frameSeparator(safeWidth, this.theme));

		if (item) {
			const current = sanitizeDisplayValue(item.board.current || item.taskId);
			const next = sanitizeDisplayValue(item.board.next || "unknown");
			const blockers = sanitizeDisplayValue(item.board.blockers || "unknown");
			const feature = sanitizeDisplayValue(item.job.feature);
			const taskMeta = [item.taskTitle, item.taskStatus]
				.filter((value): value is string => Boolean(value))
				.map(sanitizeDisplayValue)
				.join(" · ");
			lines.push(frameLine(`Current: ${current}${taskMeta ? ` — ${taskMeta}` : ""} · Next: ${next}`, safeWidth, this.theme));
			lines.push(frameLine(`Blockers: ${blockers} · Feature: ${feature}`, safeWidth, this.theme));
		} else {
			lines.push(frameLine("No running or recent loop tasks found in this project.", safeWidth, this.theme));
			lines.push(frameLine("Start one with loop_job_start or /loop-bg.", safeWidth, this.theme));
		}
		lines.push(frameSeparator(safeWidth, this.theme));
		this.renderLog(lines, safeWidth, now, item);
		const rawWarning = this.refreshError ?? this.snapshot.warnings[0];
		const warning = rawWarning ? sanitizeDisplayValue(rawWarning) : undefined;
		const help = warning
			? `${this.theme.fg("warning", warning)} · r refresh · q close`
			: "↑↓/jk log · PgUp/PgDn page · Tab task · G follow · r refresh · q close";
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

	private selectedItem(): LoopMonitorItem | undefined {
		if (this.snapshot.items.length === 0) return undefined;
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.snapshot.items.length - 1));
		return this.snapshot.items[this.selectedIndex];
	}

	private selectJob(delta: number): void {
		if (this.snapshot.items.length === 0) return;
		this.selectedIndex = (this.selectedIndex + delta + this.snapshot.items.length) % this.snapshot.items.length;
		this.logScroll = 0;
		this.following = true;
		this.seenLineCount = this.selectedItem()?.iteration.sourceLineCount ?? 0;
		this.tui.requestRender();
	}

	private resumeFollowing(): void {
		this.following = true;
		const item = this.selectedItem();
		this.seenLineCount = item?.iteration.sourceLineCount ?? 0;
		this.logScroll = Math.max(0, (item?.iteration.lines.length ?? 0) - this.lastLogRows);
	}

	private async refresh(): Promise<void> {
		if (this.disposed || this.refreshing) return;
		this.refreshing = true;
		this.tui.requestRender();
		const selectedItem = this.selectedItem();
		const selectedId = selectedItem?.job.jobId;
		const previousIteration = selectedItem?.iteration.iteration;
		const previousTailStart = selectedItem
			? Math.max(0, selectedItem.iteration.sourceLineCount - selectedItem.iteration.lines.length)
			: 0;
		const previousAbsoluteScroll = previousTailStart + this.logScroll;
		try {
			const next = await this.loader();
			this.snapshot = next;
			this.refreshError = undefined;
			if (selectedId) {
				const selected = next.items.findIndex((item) => item.job.jobId === selectedId);
				this.selectedIndex = selected >= 0 ? selected : Math.min(this.selectedIndex, Math.max(0, next.items.length - 1));
			}
			const currentItem = this.selectedItem();
			const currentIteration = currentItem?.iteration.iteration;
			if (currentIteration !== previousIteration) {
				this.following = true;
			} else if (
				!this.following
				&& selectedItem
				&& currentItem?.job.jobId === selectedId
				&& currentItem.iteration.sourceLineCount >= selectedItem.iteration.sourceLineCount
			) {
				const currentTailStart = Math.max(0, currentItem.iteration.sourceLineCount - currentItem.iteration.lines.length);
				this.logScroll = Math.max(0, previousAbsoluteScroll - currentTailStart);
			}
			if (this.following) this.resumeFollowing();
		} catch (error) {
			this.refreshError = error instanceof Error ? error.message : String(error);
		} finally {
			this.refreshing = false;
			if (!this.disposed) this.tui.requestRender();
		}
	}

	private renderJobs(lines: string[], width: number, now: number, availableRows: number): void {
		if (this.snapshot.items.length === 0) {
			lines.push(frameLine(this.theme.fg("dim", "Waiting for a current-project loop task…"), width, this.theme));
			return;
		}
		const maxStart = Math.max(0, this.snapshot.items.length - availableRows);
		const start = Math.min(maxStart, Math.max(0, this.selectedIndex - availableRows + 1));
		for (let index = start; index < Math.min(this.snapshot.items.length, start + availableRows); index++) {
			const item = this.snapshot.items[index]!;
			const selected = index === this.selectedIndex ? this.theme.fg("accent", "▶") : " ";
			const iteration = item.iteration.iteration
				? `iter ${item.iteration.iteration}/${item.iteration.maxIterations ?? item.job.maxIterations}`
				: `iter —/${item.job.maxIterations}`;
			const taskId = sanitizeDisplayValue(item.taskId);
			const task = item.taskTitle ? `${taskId} — ${sanitizeDisplayValue(item.taskTitle)}` : taskId;
			const feature = sanitizeDisplayValue(item.job.feature);
			const activity = item.logUpdatedAt ?? timestamp(item.job.updatedAt);
			lines.push(frameLine(`${selected} ${stateText(item.job.state, this.theme)} · ${feature} / ${task} · ${iteration} · ${formatAge(activity, now)} ago`, width, this.theme));
		}
	}

	private renderLog(lines: string[], width: number, now: number, item: LoopMonitorItem | undefined): void {
		if (!item) {
			lines.push(frameLine(this.theme.fg("dim", "Current iteration log"), width, this.theme));
			for (let index = 0; index < this.lastLogRows; index++) lines.push(frameLine("", width, this.theme));
			return;
		}
		const iteration = item.iteration.iteration
			? `${item.iteration.finished ? "Last" : "Current"} iteration ${item.iteration.iteration}/${item.iteration.maxIterations ?? item.job.maxIterations}`
			: "Current iteration";
		const activityAge = item.logUpdatedAt ? now - item.logUpdatedAt : Number.POSITIVE_INFINITY;
		const staleAfter = Math.max(30_000, item.job.pollSeconds * 3000);
		const stale = item.job.state === "running" && activityAge > staleAfter;
		const unseen = Math.max(0, item.iteration.sourceLineCount - this.seenLineCount);
		const follow = this.following
			? this.theme.fg("success", "FOLLOWING")
			: this.theme.fg("warning", `PAUSED${unseen > 0 ? ` · ${unseen} new` : ""}`);
		const activity = item.logUpdatedAt ? `updated ${formatAge(item.logUpdatedAt, now)} ago` : "waiting for first output";
		const staleLabel = stale ? this.theme.fg("warning", " · STALE") : "";
		const refreshing = this.refreshing ? this.theme.fg("dim", " · refreshing…") : "";
		lines.push(frameLine(`${iteration} · ${follow} · ${activity}${staleLabel}${refreshing}`, width, this.theme));

		const logLines = item.iteration.lines.length > 0
			? item.iteration.lines
			: [item.job.state === "running" ? "Waiting for first output…" : "Log unavailable."];
		const maxScroll = Math.max(0, logLines.length - this.lastLogRows);
		if (this.following) this.logScroll = maxScroll;
		else this.logScroll = Math.max(0, Math.min(this.logScroll, maxScroll));
		const visible = logLines.slice(this.logScroll, this.logScroll + this.lastLogRows);
		for (let index = 0; index < this.lastLogRows; index++) {
			const raw = visible[index] ?? "";
			const marker = item.iteration.markerMissing && index === 0 ? this.theme.fg("warning", "[iteration marker unavailable] ") : "";
			lines.push(frameLine(`${marker}${this.theme.fg("text", raw)}`, width, this.theme));
		}
	}
}

async function showLoopMonitor(ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/loops requires the interactive Pi TUI", "error");
		return;
	}
	const load = () => loadLoopMonitorSnapshot(ctx.cwd);
	const initial = await load();
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => new LoopMonitorComponent(tui, theme, initial, load, () => done(undefined)),
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
		description: "Open current-project loop task monitor",
		handler: async (ctx) => showLoopMonitor(ctx as ExtensionContext),
	});
	pi.registerCommand("loops", {
		description: "Monitor loop tasks running in the current project (Ctrl+Shift+L)",
		handler: async (_args, ctx) => showLoopMonitor(ctx as ExtensionContext),
	});
}
