import * as fs from "node:fs";
import * as path from "node:path";
import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

export type TaskStatus = "todo" | "in-progress" | "blocked" | "done";

export interface ProjectTask {
	id: string;
	feature: string;
	title: string;
	/** Raw frontmatter value; may be a legacy status that is not a TaskStatus. */
	status: string;
	filePath: string;
	content: string;
}

export interface TaskFeatureGroup {
	feature: string;
	tasks: ProjectTask[];
}

export interface TaskMonitorSnapshot {
	cwd: string;
	loadedAt: number;
	tasks: ProjectTask[];
	warnings: string[];
}

interface LoadOptions {
	now?: number;
}

interface ComponentOptions {
	now?: () => number;
	autoRefresh?: boolean;
	refreshIntervalMs?: number;
}

const DEFAULT_REFRESH_INTERVAL_MS = 1500;
const MAX_MONITOR_HEIGHT = 32;
const MIN_SIDEBAR_WIDTH = 18;
const MAX_SIDEBAR_WIDTH = 40;
const MONITOR_BORDER_COLOR = "thinkingXhigh";
const MONITOR_DIVIDER_COLOR = "error";

function normalizedProjectPath(value: string): string {
	const resolved = path.resolve(value);
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

export function isTaskStatus(value: string): value is TaskStatus {
	return value === "todo" || value === "in-progress" || value === "blocked" || value === "done";
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
	if (!id || !/^TASK-[A-Za-z0-9_.-]+$/i.test(id) || !status) return undefined;

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
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

function sanitizeDisplayValue(text: string): string {
	return stripTerminalControls(text).replace(/\s+/g, " ").trim();
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

function taskKey(feature: string, taskId: string): string {
	return `${feature}\u0000${taskId.toUpperCase()}`;
}

export function buildTaskGroups(tasks: readonly ProjectTask[]): TaskFeatureGroup[] {
	const groups = new Map<string, TaskFeatureGroup>();
	const seenTasks = new Set<string>();
	for (const task of tasks) {
		if (task.status === "done") continue;
		const key = taskKey(task.feature, task.id);
		if (seenTasks.has(key)) continue;
		seenTasks.add(key);
		let group = groups.get(task.feature);
		if (!group) {
			group = { feature: task.feature, tasks: [] };
			groups.set(task.feature, group);
		}
		group.tasks.push(task);
	}
	for (const group of groups.values()) group.tasks.sort((a, b) => a.id.localeCompare(b.id));
	return [...groups.values()].sort((a, b) => a.feature.localeCompare(b.feature));
}

export async function loadTaskMonitorSnapshot(cwd: string, options: LoadOptions = {}): Promise<TaskMonitorSnapshot> {
	const { tasks, warnings } = await readProjectTasks(cwd);
	return { cwd: path.resolve(cwd), loadedAt: options.now ?? Date.now(), tasks, warnings };
}

function taskStatusColor(status: string): "muted" | "accent" | "warning" | "success" {
	switch (status) {
		case "todo": return "muted";
		case "in-progress": return "accent";
		case "done": return "success";
		case "blocked": return "warning";
		default: return "warning"; // unrecognized legacy value
	}
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

export class TaskMonitorComponent {
	private readonly tui: Pick<TUI, "requestRender" | "terminal">;
	private readonly theme: Theme;
	private readonly loader: () => Promise<TaskMonitorSnapshot>;
	private readonly onClose: () => void;
	private snapshot: TaskMonitorSnapshot;
	private selectedTaskKey?: string;
	private sidebarScroll = 0;
	private taskContentScroll = 0;
	private taskContentLineCount = 0;
	private taskContentRows = 1;
	private taskContentFocused = false;
	private taskMarkdown?: Markdown;
	private taskMarkdownSource?: string;
	private refreshing = false;
	private refreshError?: string;
	private interval?: ReturnType<typeof setInterval>;
	private disposed = false;
	private readonly now: () => number;

	constructor(
		tui: Pick<TUI, "requestRender" | "terminal">,
		theme: Theme,
		initialSnapshot: TaskMonitorSnapshot,
		loader: () => Promise<TaskMonitorSnapshot>,
		onClose: () => void,
		options: ComponentOptions = {},
	) {
		this.tui = tui;
		this.theme = theme;
		this.loader = loader;
		this.onClose = onClose;
		this.snapshot = initialSnapshot;
		this.now = options.now ?? Date.now;
		this.ensureSelection();
		if (options.autoRefresh !== false) {
			this.interval = setInterval(() => void this.refresh(), options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS);
			this.interval.unref?.();
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) && this.taskContentFocused) {
			this.taskContentFocused = false;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, "q")) {
			this.dispose();
			this.onClose();
			return;
		}
		if (data === "r") {
			void this.refresh();
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, "k") || matchesKey(data, Key.shift("k"))) {
			if (this.taskContentFocused) this.scrollContent(-1, 1);
			else this.moveSelection(-1);
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, "j") || matchesKey(data, Key.shift("j"))) {
			if (this.taskContentFocused) this.scrollContent(1, 1);
			else this.moveSelection(1);
			return;
		}
		if (matchesKey(data, Key.enter) || data === "\r") {
			if (this.selectedTask()) {
				this.taskContentFocused = !this.taskContentFocused;
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollContent(-1);
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollContent(1);
			return;
		}
		if (matchesKey(data, Key.home) || data === "g") {
			this.taskContentScroll = 0;
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		if (safeWidth < 24) return [truncateToWidth("Tasks requires a wider terminal", safeWidth, "")];
		this.ensureSelection();
		const now = this.now();
		const terminalRows = this.tui.terminal.rows || 24;
		const totalHeight = Math.max(15, Math.min(MAX_MONITOR_HEIGHT, Math.floor(terminalRows * 0.9)));
		const bodyRows = Math.max(9, totalHeight - 6);
		const leftWidth = Math.min(
			Math.max(8, safeWidth - 13),
			Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.floor((safeWidth - 3) * 0.34))),
		);
		const rightWidth = Math.max(1, safeWidth - leftWidth - 3);
		const groups = buildTaskGroups(this.snapshot.tasks);
		const unfinished = groups.reduce((count, group) => count + group.tasks.length, 0);
		const projectName = sanitizeDisplayValue(path.basename(this.snapshot.cwd) || this.snapshot.cwd);
		const refreshing = this.refreshing ? " · refreshing…" : "";
		const lines = [
			frameBorder(`Tasks · ${projectName}`, safeWidth, true, this.theme),
			frameLine(`${unfinished} unfinished · refreshed ${formatAge(this.snapshot.loadedAt, now)} ago${refreshing}`, safeWidth, this.theme),
			splitFrameSeparator(safeWidth, leftWidth, this.theme),
		];
		const sidebar = this.renderSidebar(groups, bodyRows);
		const detail = this.renderDetail(bodyRows, rightWidth);
		for (let row = 0; row < bodyRows; row++) {
			lines.push(splitFrameLine(sidebar[row] ?? "", detail[row] ?? "", safeWidth, leftWidth, this.theme));
		}
		lines.push(splitFrameSeparator(safeWidth, leftWidth, this.theme));
		const rawWarning = this.refreshError ?? this.snapshot.warnings[0];
		const warning = rawWarning ? sanitizeDisplayValue(rawWarning) : undefined;
		const controls = this.taskContentFocused
			? "↑↓/jk scroll task · Enter/Esc list · PgUp/PgDn page · q close"
			: "Enter content · ↑↓/jk select · PgUp/PgDn detail · r refresh · q close";
		lines.push(frameLine(warning ? `${this.theme.fg("warning", warning)} · r refresh · q close` : controls, safeWidth, this.theme));
		lines.push(frameBorder(undefined, safeWidth, false, this.theme));
		return lines.map((line) => truncateToWidth(line, safeWidth, ""));
	}

	invalidate(): void {
		this.taskMarkdown?.invalidate();
	}

	dispose(): void {
		this.disposed = true;
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = undefined;
		}
	}

	private orderedTasks(): ProjectTask[] {
		return buildTaskGroups(this.snapshot.tasks).flatMap(group => group.tasks);
	}

	private ensureSelection(): void {
		const tasks = this.orderedTasks();
		if (this.selectedTaskKey && tasks.some((task) => taskKey(task.feature, task.id) === this.selectedTaskKey)) return;
		this.selectedTaskKey = tasks[0] ? taskKey(tasks[0].feature, tasks[0].id) : undefined;
		this.taskContentFocused = false;
		this.taskContentScroll = 0;
	}

	private selectedTask(): ProjectTask | undefined {
		this.ensureSelection();
		return this.orderedTasks().find((task) => taskKey(task.feature, task.id) === this.selectedTaskKey);
	}

	private moveSelection(delta: number): void {
		const tasks = this.orderedTasks();
		if (tasks.length === 0) return;
		const current = Math.max(0, tasks.findIndex((task) => taskKey(task.feature, task.id) === this.selectedTaskKey));
		const next = tasks[(current + delta + tasks.length) % tasks.length]!;
		this.selectedTaskKey = taskKey(next.feature, next.id);
		this.taskContentScroll = 0;
		this.taskContentFocused = false;
		this.tui.requestRender();
	}

	private scrollContent(direction: -1 | 1, step = this.taskContentRows): void {
		const maxScroll = Math.max(0, this.taskContentLineCount - this.taskContentRows);
		this.taskContentScroll = Math.max(0, Math.min(maxScroll, this.taskContentScroll + direction * step));
		this.tui.requestRender();
	}

	private async refresh(): Promise<void> {
		if (this.disposed || this.refreshing) return;
		this.refreshing = true;
		this.tui.requestRender();
		const previousTasks = this.orderedTasks();
		const previousIndex = Math.max(0, previousTasks.findIndex((task) => taskKey(task.feature, task.id) === this.selectedTaskKey));
		try {
			this.snapshot = await this.loader();
			this.refreshError = undefined;
			const nextTasks = this.orderedTasks();
			if (!nextTasks.some((task) => taskKey(task.feature, task.id) === this.selectedTaskKey)) {
				const fallback = nextTasks[Math.min(previousIndex, Math.max(0, nextTasks.length - 1))];
				this.selectedTaskKey = fallback ? taskKey(fallback.feature, fallback.id) : undefined;
				this.taskContentFocused = false;
				this.taskContentScroll = 0;
			}
		} catch (error) {
			this.refreshError = error instanceof Error ? error.message : String(error);
		} finally {
			this.refreshing = false;
			if (!this.disposed) this.tui.requestRender();
		}
	}

	private renderSidebar(groups: TaskFeatureGroup[], height: number): string[] {
		const rows: Array<{ text: string; selected?: boolean; featureHeader?: string }> = [];
		for (const group of groups) {
			const featureHeader = this.theme.fg("accent", this.theme.bold(` ${sanitizeDisplayValue(group.feature)} · ${group.tasks.length}`));
			rows.push({ text: featureHeader });
			for (const task of group.tasks) {
				const selected = taskKey(task.feature, task.id) === this.selectedTaskKey;
				const marker = selected ? this.theme.fg("accent", "▶") : " ";
				const status = this.theme.fg(taskStatusColor(task.status), `[${sanitizeDisplayValue(task.status)}]`);
				rows.push({
					selected, featureHeader,
					text: `${marker} ${sanitizeDisplayValue(task.id)} ${status} · ${sanitizeDisplayValue(task.title)}`,
				});
			}
		}
		if (groups.length === 0) rows.push({ text: this.theme.fg("dim", " No unfinished tasks.") });

		const selectedRow = rows.findIndex((row) => row.selected);
		const maxScroll = Math.max(0, rows.length - height);
		let scroll = Math.max(0, Math.min(this.sidebarScroll, maxScroll));
		if (selectedRow >= 0 && selectedRow < scroll) scroll = selectedRow;
		else if (selectedRow >= scroll + height) scroll = selectedRow - height + 1;
		// Keep the feature name visible when its heading has scrolled out of view.
		if (height > 1 && rows[scroll]?.featureHeader) {
			if (selectedRow >= scroll + height - 1) scroll = selectedRow - height + 2;
			this.sidebarScroll = scroll;
			const featureHeader = rows[scroll]?.featureHeader;
			if (featureHeader) return [featureHeader, ...rows.slice(scroll, scroll + height - 1).map(row => row.text)];
		}
		this.sidebarScroll = scroll;
		return rows.slice(scroll, scroll + height).map((row) => row.text);
	}

	private renderDetail(height: number, width: number): string[] {
		const task = this.selectedTask();
		if (!task) return [this.theme.fg("dim", " Select a task from a feature.")];
		const rows: string[] = [
			this.theme.bold(` ${sanitizeDisplayValue(task.id)} — ${sanitizeDisplayValue(task.title)}`),
			` ${sanitizeDisplayValue(task.feature)} · stored status: ${sanitizeDisplayValue(task.status)}${isTaskStatus(task.status) ? "" : " (unrecognized)"}`,
		];

		const source = stripTerminalControls(task.content || "Task content unavailable.");
		if (!this.taskMarkdown || this.taskMarkdownSource !== source) {
			this.taskMarkdownSource = source;
			this.taskMarkdown = new Markdown(source, 0, 0, getMarkdownTheme(), {
				color: text => this.theme.fg("text", text),
			});
		}
		const content = this.taskMarkdown.render(Math.max(1, width - 2));
		this.taskContentLineCount = content.length;
		rows.push(` ${this.theme.fg(this.taskContentFocused ? "accent" : "muted", `── TASK CONTENT · ${this.taskContentFocused ? "FOCUSED · Enter/Esc to list" : "Enter to focus"}`)}`);
		this.taskContentRows = Math.max(1, height - rows.length);
		const maxScroll = Math.max(0, content.length - this.taskContentRows);
		this.taskContentScroll = Math.max(0, Math.min(this.taskContentScroll, maxScroll));
		for (const line of content.slice(this.taskContentScroll, this.taskContentScroll + this.taskContentRows)) {
			rows.push(` ${line}`);
		}
		return rows.slice(0, height);
	}
}

async function showTaskMonitor(ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/tasks requires the interactive Pi TUI", "error");
		return;
	}
	const load = () => loadTaskMonitorSnapshot(ctx.cwd);
	const initial = await load();
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => new TaskMonitorComponent(tui, theme, initial, load, () => done(undefined)),
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

export default function taskMonitorExtension(pi: ExtensionAPI) {
	pi.registerShortcut("ctrl+shift+l", {
		description: "Browse todo, in-progress, and blocked tasks in the current project",
		handler: async (ctx) => showTaskMonitor(ctx as ExtensionContext),
	});
	pi.registerCommand("tasks", {
		description: "Browse todo, in-progress, and blocked tasks in the current project (Ctrl+Shift+L)",
		handler: async (_args, ctx) => showTaskMonitor(ctx as ExtensionContext),
	});
}
