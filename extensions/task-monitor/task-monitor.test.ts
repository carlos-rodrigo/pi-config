import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";

import taskMonitorExtension, {
	TaskMonitorComponent,
	buildTaskGroups,
	loadTaskMonitorSnapshot,
	parseTaskBrief,
	type ProjectTask,
	type TaskMonitorSnapshot,
} from "./index.ts";

initTheme("dark", false);
const NOW = new Date("2026-06-01T12:00:00Z");

function projectTask(overrides: Partial<ProjectTask> = {}): ProjectTask {
	return {
		id: "TASK-002",
		feature: "payments",
		title: "Handle retries",
		status: "todo",
		filePath: "/tmp/project/.features/payments/tasks/002-handle-retries.md",
		content: "## Brief\n\n- Goal: Add reliable retries.",
		...overrides,
	};
}

type ColoredText = { color: string; text: string };

function testTheme(coloredText?: ColoredText[]): Theme {
	return new Proxy({}, {
		get: (_target, property) => property === "bold"
			? (text: string) => text
			: (color: string, text: string) => {
				coloredText?.push({ color, text });
				return text;
			},
	}) as Theme;
}

test("parseTaskBrief reads frontmatter, title, and display content", () => {
	const task = parseTaskBrief(`---
id: TASK-003
status: in-progress
order: 3
---

# TASK-003 — Add timeout tests

## Brief

- Goal: Cover timeout behavior.
`, "payments", "/tmp/project/.features/payments/tasks/003-timeouts.md");

	assert.deepEqual(task, {
		id: "TASK-003",
		feature: "payments",
		title: "Add timeout tests",
		status: "in-progress",
		filePath: "/tmp/project/.features/payments/tasks/003-timeouts.md",
		content: "## Brief\n\n- Goal: Cover timeout behavior.",
	});
});

test("parseTaskBrief keeps each lifecycle status and raw legacy values from frontmatter", () => {
	const brief = (status: string) => `---\nid: TASK-001\nstatus: ${status}\n---\n\n# TASK-001 — Work\n`;
	for (const status of ["todo", "in-progress", "blocked", "done"]) {
		assert.equal(parseTaskBrief(brief(status), "payments", "task.md")?.status, status);
	}
	assert.equal(parseTaskBrief(brief('"In-Progress"'), "payments", "task.md")?.status, "in-progress");
	assert.equal(parseTaskBrief(brief("ready"), "payments", "task.md")?.status, "ready", "legacy values are kept, not rejected");
	assert.equal(parseTaskBrief("---\nid: TASK-001\n---\n\n# TASK-001 — Work\n", "payments", "task.md"), undefined, "missing status stays invalid");
});

test("buildTaskGroups hides done tasks and completed-only features and dedupes by feature and ID", () => {
	const taskTwo = projectTask();
	const taskThree = projectTask({ id: "TASK-003", title: "Add timeout tests" });
	const blocked = projectTask({ id: "TASK-004", title: "Blocked work", status: "blocked" });
	const inProgress = projectTask({ id: "TASK-005", status: "in-progress" });
	const done = projectTask({ id: "TASK-006", status: "done" });
	const legacy = projectTask({ id: "TASK-007", status: "ready" });
	const otherFeature = projectTask({ feature: "accounts", id: "TASK-002", status: "todo" });
	const completedFeature = projectTask({ feature: "completed-feature", status: "done" });
	const groups = buildTaskGroups([taskTwo, taskThree, taskThree, blocked, inProgress, done, legacy, otherFeature, completedFeature]);

	assert.deepEqual(groups.map(group => group.feature), ["accounts", "payments"]);
	assert.deepEqual(groups[0]?.tasks.map(task => task.id), ["TASK-002"]);
	assert.deepEqual(groups[1]?.tasks.map(task => [task.id, task.status]), [
		["TASK-002", "todo"], ["TASK-003", "todo"], ["TASK-004", "blocked"],
		["TASK-005", "in-progress"], ["TASK-007", "ready"],
	]);
});

test("task sidebar groups unfinished tasks, hides done, and keeps feature context when scrolling", () => {
	const statuses: ProjectTask["status"][] = ["todo", "in-progress", "blocked", "ready", "done"];
	const tasks = statuses.map((status, index) => projectTask({ id: `TASK-00${index + 1}`, status, title: `Task ${index + 1}` }));
	const snapshot: TaskMonitorSnapshot = { cwd: "/tmp/project", loadedAt: NOW.getTime(), tasks, warnings: [] };
	const coloredText: ColoredText[] = [];
	const component = new TaskMonitorComponent({ terminal: { rows: 40 }, requestRender() {} }, testTheme(coloredText), snapshot,
		async () => snapshot, () => {}, { autoRefresh: false });
	const rendered = component.render(130).join("\n");
	assert.match(rendered, /payments · 4/);
	for (const status of ["todo", "in-progress", "blocked", "ready"]) assert.ok(rendered.includes(`[${status}]`));
	assert.doesNotMatch(rendered, /\[done\]|TASK-005/);
	const statusColors = Object.fromEntries(coloredText.filter(({ text }) => /^\[[a-z-]+\]$/.test(text)).map(({ text, color }) => [text, color]));
	assert.deepEqual(statusColors, { "[todo]": "muted", "[in-progress]": "accent", "[blocked]": "warning", "[ready]": "warning" });
	component.dispose();

	const legacySnapshot = { ...snapshot, tasks: [projectTask({ status: "ready" })] };
	const legacyView = new TaskMonitorComponent({ terminal: { rows: 40 }, requestRender() {} }, testTheme(), legacySnapshot,
		async () => legacySnapshot, () => {}, { autoRefresh: false });
	assert.match(legacyView.render(130).join("\n"), /stored status: ready \(unrecognized\)/);
	legacyView.dispose();

	const manyTasks = Array.from({ length: 25 }, (_, index) => projectTask({ id: `TASK-${String(index).padStart(3, "0")}`, status: "todo" }));
	const scrollingSnapshot = { ...snapshot, tasks: manyTasks };
	const scroller = new TaskMonitorComponent({ terminal: { rows: 24 }, requestRender() {} }, testTheme(), scrollingSnapshot,
		async () => scrollingSnapshot, () => {}, { autoRefresh: false });
	for (let i = 0; i < 20; i++) scroller.handleInput("j");
	const leftColumn = scroller.render(100).map(line => line.split("│")[1] ?? "").join("\n");
	assert.match(leftColumn, /payments · 25/);
	assert.match(leftColumn, /▶ TASK-020 \[todo\]/);
	scroller.dispose();
});

test("task selection distinguishes the same ID across features and survives status changes on refresh", async () => {
	let snapshot: TaskMonitorSnapshot = {
		cwd: "/tmp/project", loadedAt: NOW.getTime(), warnings: [], tasks: [
			projectTask({ feature: "payments", id: "TASK-001", status: "blocked", title: "Payment work" }),
			projectTask({ feature: "accounts", id: "TASK-001", status: "in-progress", title: "Account work" }),
		],
	};
	const component = new TaskMonitorComponent({ terminal: { rows: 30 }, requestRender() {} }, testTheme(), snapshot,
		async () => snapshot, () => {}, { autoRefresh: false });
	assert.match(component.render(130).join("\n"), /TASK-001 — Account work/);
	component.handleInput("j");
	assert.match(component.render(130).join("\n"), /TASK-001 — Payment work/);
	snapshot = { ...snapshot, tasks: [...snapshot.tasks].reverse().map(task => task.feature === "payments" ? { ...task, status: "done" } : task) };
	component.handleInput("r");
	await new Promise<void>(resolve => setImmediate(resolve));
	const rendered = component.render(130).join("\n");
	assert.match(rendered, /TASK-001 — Account work/);
	assert.match(rendered, /accounts · 1/);
	assert.doesNotMatch(rendered, /Payment work|payments · 1|\[done\]/);
	component.handleInput("j");
	assert.match(component.render(130).join("\n"), /TASK-001 — Account work/);
	snapshot = { ...snapshot, tasks: snapshot.tasks.map(task => ({ ...task, status: "done" })) };
	component.handleInput("r");
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.match(component.render(130).join("\n"), /No unfinished tasks/);
	assert.doesNotMatch(component.render(130).join("\n"), /Account work|Payment work/);
	component.dispose();
});

test("task Markdown formats emphasis, lists, links and code, reflows on resize and refreshes theme/content", async () => {
	const markdown = ["## Acceptance", "", "\x1bcUse **bold** and *italic* with `inline`.", "", "- First item", "- Second item", "", "[Docs](https://example.test/docs)", "", "| Name | State |", "| --- | --- |", "| Work | ready |", "", "```ts", "const value = 1;", "```"].join("\n");
	let snapshot: TaskMonitorSnapshot = { cwd: "/tmp/project", loadedAt: NOW.getTime(), warnings: [], tasks: [projectTask({ content: markdown })] };
	const component = new TaskMonitorComponent({ terminal: { rows: 40 }, requestRender() {} }, testTheme(), snapshot,
		async () => snapshot, () => {}, { autoRefresh: false });
	const rendered = component.render(140).join("\n");
	assert.doesNotMatch(rendered, /\*\*bold\*\*|\*italic\*|\[Docs\]\(/);
	assert.match(rendered, /bold/);
	assert.match(rendered, /Docs/);
	assert.doesNotMatch(rendered, /\x1bc/);
	const plain = rendered.replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(plain, /│ Name │ State │/);
	assert.match(plain, /const value = 1/);
	for (const width of [30, 60, 100, 140]) assert.ok(component.render(width).every(line => visibleWidth(line) <= width));
	const beforeThemeChange = component.render(140).join("\n");
	try {
		initTheme("light", false);
		component.invalidate();
		assert.notEqual(component.render(140).join("\n"), beforeThemeChange, "cached Markdown responds to theme invalidation");
	} finally { initTheme("dark", false); component.invalidate(); }
	snapshot = { ...snapshot, tasks: [projectTask({ content: "**Updated content**" })] };
	component.handleInput("r");
	await new Promise<void>(resolve => setImmediate(resolve));
	const updated = component.render(140).join("\n");
	assert.match(updated, /Updated content/);
	assert.doesNotMatch(updated, /Acceptance|\*\*Updated content\*\*/);
	component.dispose();
});

test("Enter focuses task content, j/k scroll by line, and Escape restores list navigation", () => {
	let closes = 0;
	const snapshot: TaskMonitorSnapshot = { cwd: "/tmp/project", loadedAt: NOW.getTime(), warnings: [], tasks: [
		projectTask({ id: "TASK-001", title: "Long task", content: Array.from({ length: 100 }, (_, i) => `Line ${String(i + 1).padStart(3, "0")}`).join("  \n") }),
		projectTask({ id: "TASK-002", title: "Other task" }),
	] };
	const component = new TaskMonitorComponent({ terminal: { rows: 24 }, requestRender() {} }, testTheme(), snapshot,
		async () => snapshot, () => { closes++; }, { autoRefresh: false });
	const render = () => component.render(120).join("\n");
	component.render(120);
	component.handleInput("\r");
	assert.match(render(), /TASK CONTENT.*FOCUSED/);
	component.handleInput("j");
	assert.match(render(), /TASK-001 — Long task/);
	assert.match(render(), /Line 002/);
	assert.doesNotMatch(render(), /Line 001/);
	component.handleInput("k");
	assert.match(render(), /Line 001/);
	component.handleInput("\x1b[106u"); // encoded j
	assert.doesNotMatch(render(), /Line 001/);
	component.handleInput("\x1b[A");
	assert.match(render(), /Line 001/);
	component.handleInput("J");
	assert.doesNotMatch(render(), /Line 001/);
	component.handleInput("K");
	assert.match(render(), /Line 001/);
	component.handleInput("\x1b[6~"); // PageDown
	assert.doesNotMatch(render(), /Line 001/);
	component.handleInput("\x1b[5~"); // PageUp
	assert.match(render(), /Line 001/);
	for (let i = 0; i < 110; i++) component.handleInput("j");
	assert.match(render(), /Line 100/);
	const bottom = render();
	component.handleInput("j");
	assert.equal(render(), bottom);
	component.handleInput("\x1b");
	assert.equal(closes, 0, "Escape returns to list rather than closing the overlay");
	assert.doesNotMatch(render(), /FOCUSED/);
	component.handleInput("j");
	assert.match(render(), /TASK-002 — Other task/);
	component.handleInput("\r");
	component.handleInput("\r");
	component.handleInput("k");
	assert.match(render(), /TASK-001 — Long task/);
	component.handleInput("q");
	assert.equal(closes, 1);
});

test("focused task content resets to the next task when the focused task completes on refresh", async () => {
	let snapshot: TaskMonitorSnapshot = { cwd: "/tmp/project", loadedAt: NOW.getTime(), warnings: [], tasks: [
		projectTask({ id: "TASK-002", status: "in-progress", content: Array.from({ length: 50 }, (_, i) => `Brief line ${i}`).join("  \n") }),
		projectTask({ id: "TASK-003", title: "Next task" }),
	] };
	const component = new TaskMonitorComponent({ terminal: { rows: 30 }, requestRender() {} }, testTheme(), snapshot,
		async () => snapshot, () => {}, { autoRefresh: false });
	component.handleInput("\r");
	let rendered = component.render(130).join("\n");
	assert.match(rendered, /TASK-002 — Handle retries/);
	assert.match(rendered, /FOCUSED/);
	snapshot = { ...snapshot, tasks: snapshot.tasks.map(task => task.id === "TASK-002" ? { ...task, status: "done" } : task) };
	component.handleInput("r");
	await new Promise<void>(resolve => setImmediate(resolve));
	rendered = component.render(130).join("\n");
	assert.match(rendered, /TASK-003 — Next task/);
	assert.doesNotMatch(rendered, /FOCUSED/);
	component.dispose();
});

test("task navigation shows each selected task's Markdown body inside the colored frame", () => {
	const snapshot: TaskMonitorSnapshot = { cwd: "/tmp/project", loadedAt: NOW.getTime(), warnings: [], tasks: [
		projectTask({ id: "TASK-002", title: "Handle retries", content: "## Brief\nRetry details" }),
		projectTask({ id: "TASK-003", title: "Add timeout tests", content: "## Brief\nTimeout details" }),
	] };
	const coloredText: ColoredText[] = [];
	const component = new TaskMonitorComponent({ terminal: { rows: 30 }, requestRender() {} }, testTheme(coloredText), snapshot,
		async () => snapshot, () => {}, { now: () => NOW.getTime(), autoRefresh: false });
	const initial = component.render(110).join("\n");
	assert.ok(coloredText.some(({ color }) => color === "thinkingXhigh"), "frame border color");
	assert.ok(coloredText.some(({ color }) => color === "error"), "divider color");
	assert.match(initial, /TASK-002 — Handle retries/);
	assert.match(initial, /Retry details/);
	assert.doesNotMatch(initial, /Timeout details/);

	component.handleInput("\u001b[B");
	const next = component.render(110).join("\n");
	assert.match(next, /TASK-003 — Add timeout tests/);
	assert.match(next, /Timeout details/);
	assert.doesNotMatch(next, /Retry details/);

	component.handleInput("\u001b[A");
	const back = component.render(110).join("\n");
	assert.match(back, /Retry details/);
	assert.doesNotMatch(back, /Timeout details/);
	component.dispose();
});

test("feature headers are sanitized and the empty task view gives accurate guidance", () => {
	const snapshot: TaskMonitorSnapshot = { cwd: "/tmp/project", loadedAt: NOW.getTime(), warnings: [],
		tasks: [projectTask({ feature: "\x1bcfeature\x1b]incomplete", status: "todo" })],
	};
	const component = new TaskMonitorComponent({ terminal: { rows: 24 }, requestRender() {} }, testTheme(), snapshot,
		async () => snapshot, () => {}, { autoRefresh: false });
	assert.doesNotMatch(component.render(130).join("\n"), /\x1bc|\x1b\]/);
	component.dispose();
	const empty = { ...snapshot, tasks: [] };
	const emptyComponent = new TaskMonitorComponent({ terminal: { rows: 24 }, requestRender() {} }, testTheme(), empty,
		async () => empty, () => {}, { autoRefresh: false });
	const rendered = emptyComponent.render(100).join("\n");
	assert.match(rendered, /No unfinished tasks/);
	assert.match(rendered, /Select a task from a feature/);
	emptyComponent.dispose();
});


test("loadTaskMonitorSnapshot reads task status from brief frontmatter, not the board", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-task-monitor-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const taskDir = join(root, ".features", "payments", "tasks");
	await mkdir(taskDir, { recursive: true });
	await writeFile(join(taskDir, "_active.md"), "| Task | Status |\n| --- | --- |\n| TASK-002 | done |\n- Current: TASK-002\n", "utf8");
	await writeFile(join(taskDir, "002-handle-retries.md"), "---\nid: TASK-002\nstatus: in-progress\n---\n# TASK-002 — Handle retries\n## Brief\n- Goal: Add reliable retries.\n", "utf8");
	await writeFile(join(taskDir, "003-timeouts.md"), "---\nid: TASK-003\nstatus: todo\n---\n# TASK-003 — Add timeout tests\n", "utf8");
	await writeFile(join(taskDir, "004-broken.md"), "no frontmatter\n", "utf8");

	const snapshot = await loadTaskMonitorSnapshot(root, { now: NOW.getTime() });

	assert.equal(snapshot.loadedAt, NOW.getTime());
	assert.deepEqual(snapshot.tasks.map((task) => [task.id, task.status]), [["TASK-002", "in-progress"], ["TASK-003", "todo"]]);
	assert.deepEqual(snapshot.warnings, ["payments/004-broken.md: invalid task brief"]);
});

test("loadTaskMonitorSnapshot ignores symlinked task directories that leave the project", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-task-monitor-safe-"));
	const outside = await mkdtemp(join(tmpdir(), "pi-task-monitor-outside-"));
	t.after(() => Promise.all([
		rm(root, { recursive: true, force: true }),
		rm(outside, { recursive: true, force: true }),
	]));
	await writeFile(join(outside, "001-secret.md"), "---\nid: TASK-001\nstatus: todo\n---\n# TASK-001 — Secret\n", "utf8");
	await mkdir(join(root, ".features", "payments"), { recursive: true });
	await symlink(outside, join(root, ".features", "payments", "tasks"));

	const snapshot = await loadTaskMonitorSnapshot(root, { now: NOW.getTime() });

	assert.deepEqual(snapshot.tasks, []);
});

test("taskMonitorExtension registers only the read-only /tasks entry and its shortcut", async (t) => {
	type CommandDefinition = Parameters<ExtensionAPI["registerCommand"]>[1];
	type CustomFactory = (
		tui: { terminal: { rows: number }; requestRender(): void },
		theme: Theme,
		keybindings: unknown,
		done: (value?: void) => void,
	) => TaskMonitorComponent;
	const root = await mkdtemp(join(tmpdir(), "pi-task-monitor-commands-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const commands = new Map<string, CommandDefinition>();
	const shortcuts = new Set<string>();
	const renders: string[] = [];
	taskMonitorExtension({
		registerCommand(name: string, definition: CommandDefinition) { commands.set(name, definition); },
		registerShortcut(key: string) { shortcuts.add(key); },
	} as unknown as ExtensionAPI);
	const context = {
		cwd: root,
		mode: "tui",
		ui: {
			notify() {},
			async custom(factory: unknown) {
				const component = (factory as CustomFactory)(
					{ terminal: { rows: 24 }, requestRender() {} },
					testTheme(),
					{},
					() => {},
				);
				renders.push(component.render(90).join("\n"));
				component.dispose();
			},
		},
	} as unknown as ExtensionContext;

	assert.deepEqual([...commands.keys()], ["tasks"]);
	assert.deepEqual([...shortcuts], ["ctrl+shift+l"]);
	assert.match(commands.get("tasks")!.description ?? "", /todo, in-progress, and blocked/);
	await commands.get("tasks")!.handler("", context);
	assert.match(renders[0]!, /Tasks · /);
	assert.match(renders[0]!, /No unfinished tasks/);
});
