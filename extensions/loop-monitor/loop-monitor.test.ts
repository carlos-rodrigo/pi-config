import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";

import loopMonitorExtension, {
	LoopMonitorComponent,
	buildTaskGroups,
	extractCurrentIteration,
	loadLoopMonitorSnapshot,
	parseActiveTaskBoard,
	parseTaskBrief,
	selectCurrentProjectJobs,
	type LoopMonitorItem,
	type LoopMonitorSnapshot,
	type PersistedLoopJob,
	type ProjectTask,
} from "./index.ts";

initTheme("dark", false);
const NOW = new Date("2026-06-01T12:00:00Z");

function loopJob(overrides: Partial<PersistedLoopJob> = {}): PersistedLoopJob {
	return {
		jobId: "loop-1",
		feature: "payments",
		task: "TASK-002",
		cwd: "/tmp/project",
		createdAt: "2026-06-01T11:55:00Z",
		updatedAt: "2026-06-01T11:59:00Z",
		state: "running",
		maxIterations: 5,
		pollSeconds: 3,
		loopLogPath: "/tmp/project/.features/payments/artifacts/loop/loop.log",
		...overrides,
	};
}

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

function monitorItem(overrides: Partial<LoopMonitorItem> = {}): LoopMonitorItem {
	return {
		job: loopJob(),
		taskId: "TASK-002",
		taskTitle: "Handle retries",
		taskStatus: "todo",
		association: "explicit",
		board: { current: "TASK-002", next: "TASK-003", blockers: "none" },
		iteration: { iteration: 2, maxIterations: 5, finished: false, lines: ["Working now"], sourceLineCount: 1 },
		logUpdatedAt: NOW.getTime() - 2000,
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

test("extractCurrentIteration returns only the latest sanitized iteration", () => {
	const parsed = extractCurrentIteration([
		"[iteration 1/5] started at 2026-06-01 11:00:00",
		"old output",
		"[iteration 1/5] finished at 2026-06-01 11:01:00 (duration: 1m)",
		"between iterations",
		"[iteration 2/5] started at 2026-06-01 11:02:00",
		"\u001b[31mRunning tests\u001b[0m\u0007",
		"all good",
		"[iteration 2/5] finished at 2026-06-01 11:03:00 (duration: 1m)",
		"must not appear",
	].join("\n"), 500);

	assert.equal(parsed.iteration, 2);
	assert.equal(parsed.maxIterations, 5);
	assert.equal(parsed.finished, true);
	assert.match(parsed.lines.join("\n"), /Running tests/);
	assert.doesNotMatch(parsed.lines.join("\n"), /\u001b|must not appear|old output/);
});

test("parseActiveTaskBoard reads current, next, and blockers but no task statuses", () => {
	const board = parseActiveTaskBoard(`
# Current Feature: payments

## Progress
- [x] TASK-001 — Add model (done)
- [ ] TASK-002 — Handle retries (ready)

## Current / Next
- Current: TASK-002
- Next: TASK-003
- Blockers: none
`);

	assert.equal(board.current, "TASK-002");
	assert.equal(board.next, "TASK-003");
	assert.equal(board.blockers, "none");
	assert.deepEqual(Object.keys(board).sort(), ["blockers", "current", "next"]);

	const tableBoard = parseActiveTaskBoard(`
| Task | Status |
| --- | --- |
| TASK-002 | in-progress |
`);
	assert.deepEqual(tableBoard, {}, "a board without a Current line yields no loop association hint");
});

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

test("buildTaskGroups hides done tasks and completed-only features while preserving running associations", () => {
	const taskTwo = projectTask();
	const taskThree = projectTask({ id: "TASK-003", title: "Add timeout tests" });
	const blocked = projectTask({ id: "TASK-004", title: "Blocked work", status: "blocked" });
	const running = monitorItem();
	const recent = monitorItem({
		job: loopJob({ jobId: "loop-recent", task: "TASK-003", state: "completed" }),
		taskId: "TASK-003",
	});
	const unassigned = monitorItem({
		job: loopJob({ jobId: "loop-unassigned", task: undefined }),
		taskId: "feature loop",
		association: "unassigned",
	});

	const inProgress = projectTask({ id: "TASK-005", status: "in-progress" });
	const done = projectTask({ id: "TASK-006", status: "done" });
	const legacy = projectTask({ id: "TASK-007", status: "ready" });
	const otherFeature = projectTask({ feature: "accounts", id: "TASK-002", status: "todo" });
	const completedFeature = projectTask({ feature: "completed-feature", status: "done" });
	const doneLoop = monitorItem({ job: loopJob({ task: "TASK-006" }), taskId: "TASK-006" });
	const groups = buildTaskGroups([taskTwo, taskThree, taskThree, blocked, inProgress, done, legacy, otherFeature, completedFeature], [running, recent, unassigned, doneLoop]);

	assert.deepEqual(groups.map(group => group.feature), ["accounts", "payments"]);
	assert.deepEqual(groups[1]?.entries.map(entry => [entry.task.id, entry.task.status]), [
		["TASK-002", "todo"], ["TASK-003", "todo"], ["TASK-004", "blocked"],
		["TASK-005", "in-progress"], ["TASK-007", "ready"],
	]);
	assert.deepEqual(groups[1]?.entries[0]?.loops.map(item => item.job.jobId), ["loop-1"]);
	assert.deepEqual(groups[0]?.entries[0]?.loops, [], "same task ID from another feature does not inherit the loop");
	assert.deepEqual(groups[1]?.entries[1]?.loops, [], "recent terminal loops do not imply running activity");
});

test("task sidebar groups unfinished tasks, hides done, and keeps feature context when scrolling", () => {
	const statuses: ProjectTask["status"][] = ["todo", "in-progress", "blocked", "ready", "done"];
	const tasks = statuses.map((status, index) => projectTask({ id: `TASK-00${index + 1}`, status, title: `Task ${index + 1}` }));
	const snapshot: LoopMonitorSnapshot = { cwd: "/tmp/project", loadedAt: NOW.getTime(), tasks, items: [], warnings: [] };
	const coloredText: ColoredText[] = [];
	const component = new LoopMonitorComponent({ terminal: { rows: 40 }, requestRender() {} }, testTheme(coloredText), snapshot,
		async () => snapshot, () => {}, { autoRefresh: false, initialView: "tasks" });
	const rendered = component.render(130).join("\n");
	assert.match(rendered, /payments · 4/);
	for (const status of ["todo", "in-progress", "blocked", "ready"]) assert.ok(rendered.includes(`[${status}]`));
	assert.doesNotMatch(rendered, /\[done\]|TASK-005/);
	const statusColors = Object.fromEntries(coloredText.filter(({ text }) => /^\[[a-z-]+\]$/.test(text)).map(({ text, color }) => [text, color]));
	assert.deepEqual(statusColors, { "[todo]": "muted", "[in-progress]": "accent", "[blocked]": "warning", "[ready]": "warning" });
	component.dispose();

	const legacySnapshot = { ...snapshot, tasks: [projectTask({ status: "ready" })] };
	const legacyView = new LoopMonitorComponent({ terminal: { rows: 40 }, requestRender() {} }, testTheme(), legacySnapshot,
		async () => legacySnapshot, () => {}, { autoRefresh: false, initialView: "tasks" });
	assert.match(legacyView.render(130).join("\n"), /stored status: ready \(unrecognized\)/);
	legacyView.dispose();

	const manyTasks = Array.from({ length: 25 }, (_, index) => projectTask({ id: `TASK-${String(index).padStart(3, "0")}`, status: "todo" }));
	const scrollingSnapshot = { ...snapshot, tasks: manyTasks };
	const scroller = new LoopMonitorComponent({ terminal: { rows: 24 }, requestRender() {} }, testTheme(), scrollingSnapshot,
		async () => scrollingSnapshot, () => {}, { autoRefresh: false, initialView: "tasks" });
	for (let i = 0; i < 20; i++) scroller.handleInput("j");
	const leftColumn = scroller.render(100).map(line => line.split("│")[1] ?? "").join("\n");
	assert.match(leftColumn, /payments · 25/);
	assert.match(leftColumn, /▶ TASK-020 \[todo\]/);
	scroller.dispose();
});

test("task selection distinguishes the same ID across features and survives status changes on refresh", async () => {
	let snapshot: LoopMonitorSnapshot = {
		cwd: "/tmp/project", loadedAt: NOW.getTime(), items: [], warnings: [], tasks: [
			projectTask({ feature: "payments", id: "TASK-001", status: "blocked", title: "Payment work" }),
			projectTask({ feature: "accounts", id: "TASK-001", status: "in-progress", title: "Account work" }),
		],
	};
	const component = new LoopMonitorComponent({ terminal: { rows: 30 }, requestRender() {} }, testTheme(), snapshot,
		async () => snapshot, () => {}, { autoRefresh: false, initialView: "tasks" });
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
	let snapshot: LoopMonitorSnapshot = { cwd: "/tmp/project", loadedAt: NOW.getTime(), items: [], warnings: [], tasks: [projectTask({ content: markdown })] };
	const component = new LoopMonitorComponent({ terminal: { rows: 40 }, requestRender() {} }, testTheme(), snapshot,
		async () => snapshot, () => {}, { autoRefresh: false, initialView: "tasks" });
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
	const snapshot: LoopMonitorSnapshot = { cwd: "/tmp/project", loadedAt: NOW.getTime(), items: [], warnings: [], tasks: [
		projectTask({ id: "TASK-001", title: "Long task", content: Array.from({ length: 100 }, (_, i) => `Line ${String(i + 1).padStart(3, "0")}`).join("  \n") }),
		projectTask({ id: "TASK-002", title: "Other task" }),
	] };
	const component = new LoopMonitorComponent({ terminal: { rows: 24 }, requestRender() {} }, testTheme(), snapshot,
		async () => snapshot, () => { closes++; }, { autoRefresh: false, initialView: "tasks" });
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

test("content focus expands a running task brief and resets when the task completes on refresh", async () => {
	let snapshot: LoopMonitorSnapshot = { cwd: "/tmp/project", loadedAt: NOW.getTime(), warnings: [], items: [monitorItem()], tasks: [
		projectTask({ content: Array.from({ length: 50 }, (_, i) => `Brief line ${i}`).join("  \n") }),
		projectTask({ id: "TASK-003", title: "Next task" }),
	] };
	const component = new LoopMonitorComponent({ terminal: { rows: 30 }, requestRender() {} }, testTheme(), snapshot,
		async () => snapshot, () => {}, { autoRefresh: false, initialView: "tasks" });
	assert.match(component.render(130).join("\n"), /Working now/);
	component.handleInput("\r");
	let rendered = component.render(130).join("\n");
	assert.match(rendered, /FOCUSED/);
	assert.match(rendered, /Brief line 10/);
	assert.doesNotMatch(rendered, /Working now/);
	component.handleInput("j");
	component.handleInput("\t");
	assert.match(component.render(130).join("\n"), /Working now/);
	component.handleInput("\r");
	assert.match(component.render(130).join("\n"), /Tasks.*\[Loops\]/);
	component.handleInput("\t");
	assert.doesNotMatch(component.render(130).join("\n"), /FOCUSED/);
	component.handleInput("\r");
	assert.match(component.render(130).join("\n"), /FOCUSED/);
	snapshot = { ...snapshot, tasks: snapshot.tasks.map(task => task.id === "TASK-002" ? { ...task, status: "done" } : task) };
	component.handleInput("r");
	await new Promise<void>(resolve => setImmediate(resolve));
	rendered = component.render(130).join("\n");
	assert.match(rendered, /TASK-003 — Next task/);
	assert.doesNotMatch(rendered, /FOCUSED/);
	component.dispose();
});

test("feature headers are sanitized and the empty task view gives accurate guidance", () => {
	const snapshot: LoopMonitorSnapshot = { cwd: "/tmp/project", loadedAt: NOW.getTime(), items: [], warnings: [],
		tasks: [projectTask({ feature: "\x1bcfeature\x1b]incomplete", status: "todo" })],
	};
	const component = new LoopMonitorComponent({ terminal: { rows: 24 }, requestRender() {} }, testTheme(), snapshot,
		async () => snapshot, () => {}, { autoRefresh: false, initialView: "tasks" });
	assert.doesNotMatch(component.render(130).join("\n"), /\x1bc|\x1b\]/);
	component.dispose();
	const empty = { ...snapshot, tasks: [] };
	const emptyComponent = new LoopMonitorComponent({ terminal: { rows: 24 }, requestRender() {} }, testTheme(), empty,
		async () => empty, () => {}, { autoRefresh: false, initialView: "tasks" });
	const rendered = emptyComponent.render(100).join("\n");
	assert.match(rendered, /No unfinished tasks/);
	assert.match(rendered, /Select a task from a feature/);
	emptyComponent.dispose();
});

test("selectCurrentProjectJobs keeps current-project running jobs and recent terminal jobs", () => {
	const selected = selectCurrentProjectJobs([
		loopJob(),
		loopJob({ jobId: "recent-failed", state: "failed", completedAt: "2026-06-01T10:00:00Z" }),
		loopJob({ jobId: "old-completed", state: "completed", completedAt: "2026-05-29T10:00:00Z" }),
		loopJob({ jobId: "other-project", cwd: "/tmp/other" }),
	], "/tmp/project", NOW.getTime());

	assert.deepEqual(selected.map((job) => job.jobId), ["loop-1", "recent-failed"]);
});

test("selectCurrentProjectJobs treats symlinked project paths as the same project", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-loop-monitor-real-"));
	const alias = `${root}-alias`;
	t.after(() => Promise.all([
		rm(root, { recursive: true, force: true }),
		rm(alias, { recursive: true, force: true }),
	]));
	await symlink(root, alias);

	const selected = selectCurrentProjectJobs([loopJob({ cwd: root })], alias, NOW.getTime());

	assert.deepEqual(selected.map((job) => job.jobId), ["loop-1"]);
});

test("loadLoopMonitorSnapshot reads tasks and live logs only from the current project", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-loop-monitor-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const jobDir = join(root, ".pi", "loop-jobs", "loop-current");
	const featureJobDir = join(root, ".pi", "loop-jobs", "loop-feature");
	const otherJobDir = join(root, ".pi", "loop-jobs", "loop-other");
	const featureDir = join(root, ".features", "payments");
	const logPath = join(featureDir, "artifacts", "loop", "loop.log");
	await mkdir(jobDir, { recursive: true });
	await mkdir(featureJobDir, { recursive: true });
	await mkdir(otherJobDir, { recursive: true });
	await mkdir(join(featureDir, "tasks"), { recursive: true });
	await mkdir(join(featureDir, "artifacts", "loop"), { recursive: true });
	await writeFile(join(featureDir, "tasks", "_active.md"), `
| Task | Status |
| --- | --- |
| TASK-002 | done |
| TASK-003 | done |
## Current / Next
- Current: TASK-002
- Next: TASK-003
- Blockers: none
`, "utf8");
	await writeFile(join(featureDir, "tasks", "002-handle-retries.md"), `---
id: TASK-002
status: in-progress
---
# TASK-002 — Handle retries
## Brief
- Goal: Add reliable retries.
`, "utf8");
	await writeFile(join(featureDir, "tasks", "003-timeouts.md"), `---
id: TASK-003
status: todo
---
# TASK-003 — Add timeout tests
## Brief
- Goal: Cover timeouts.
`, "utf8");
	await writeFile(logPath, "[iteration 3/5] started at 2026-06-01 11:59:00\nWorking now\n", "utf8");
	await writeFile(join(jobDir, "status.json"), JSON.stringify(loopJob({
		jobId: "loop-current",
		cwd: root,
		loopLogPath: logPath,
	})), "utf8");
	await writeFile(join(featureJobDir, "status.json"), JSON.stringify(loopJob({
		jobId: "loop-feature",
		task: undefined,
		cwd: root,
		loopLogPath: logPath,
	})), "utf8");
	await writeFile(join(otherJobDir, "status.json"), JSON.stringify(loopJob({
		jobId: "loop-other",
		cwd: "/tmp/another-project",
		loopLogPath: "/tmp/another-project/loop.log",
	})), "utf8");

	const snapshot = await loadLoopMonitorSnapshot(root, { now: NOW.getTime() });

	assert.equal(snapshot.items.length, 2);
	const explicit = snapshot.items.find((item) => item.job.jobId === "loop-current");
	const inferred = snapshot.items.find((item) => item.job.jobId === "loop-feature");
	assert.equal(explicit?.taskId, "TASK-002");
	assert.equal(explicit?.taskTitle, "Handle retries");
	assert.equal(explicit?.taskStatus, "in-progress", "frontmatter wins over the board table");
	assert.equal(explicit?.association, "explicit");
	assert.equal(explicit?.iteration.iteration, 3);
	assert.deepEqual(explicit?.iteration.lines.slice(-1), ["Working now"]);
	assert.equal(inferred?.taskId, "TASK-002");
	assert.equal(inferred?.association, "inferred");
	assert.deepEqual(snapshot.tasks.map((task) => task.id), ["TASK-002", "TASK-003"]);
	const groups = buildTaskGroups(snapshot.tasks, snapshot.items);
	assert.deepEqual(groups[0]?.entries.map(entry => [entry.task.id, entry.task.status]), [["TASK-002", "in-progress"], ["TASK-003", "todo"]]);
	assert.deepEqual(groups[0]?.entries[0]?.loops.map(item => item.job.jobId).sort(), ["loop-current", "loop-feature"]);
});

test("loadLoopMonitorSnapshot refuses loop logs outside the current project", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-loop-monitor-safe-"));
	const outside = await mkdtemp(join(tmpdir(), "pi-loop-monitor-outside-"));
	t.after(() => Promise.all([
		rm(root, { recursive: true, force: true }),
		rm(outside, { recursive: true, force: true }),
	]));
	const jobDir = join(root, ".pi", "loop-jobs", "loop-current");
	const outsideLog = join(outside, "loop.log");
	await mkdir(jobDir, { recursive: true });
	await writeFile(outsideLog, "[iteration 1/5] started\nsecret output\n", "utf8");
	await writeFile(join(jobDir, "status.json"), JSON.stringify(loopJob({
		jobId: "loop-current",
		cwd: root,
		loopLogPath: outsideLog,
	})), "utf8");

	const snapshot = await loadLoopMonitorSnapshot(root, { now: NOW.getTime() });

	assert.equal(snapshot.items.length, 1);
	assert.deepEqual(snapshot.items[0]?.iteration.lines, []);
});

test("LoopMonitorComponent keeps lines within width and preserves paused log position", async () => {
	const lines = Array.from({ length: 500 }, (_, index) => `output ${index + 1}`);
	const snapshot: LoopMonitorSnapshot = {
		cwd: "/tmp/project",
		loadedAt: NOW.getTime(),
		tasks: [projectTask({ title: "\u001b[31mHandle retries\u001b[0m" })],
		items: [monitorItem({
			taskTitle: "\u001b[31mHandle retries\u001b[0m",
			iteration: { iteration: 2, maxIterations: 5, finished: false, lines, sourceLineCount: lines.length },
		})],
		warnings: [],
	};
	let loadedSnapshot = snapshot;
	const component = new LoopMonitorComponent(
		{ terminal: { rows: 24 }, requestRender() {} },
		testTheme(),
		snapshot,
		async () => loadedSnapshot,
		() => {},
		{ now: () => NOW.getTime(), autoRefresh: false, initialView: "loops" },
	);

	const initial = component.render(72);
	assert.ok(initial.every((line) => visibleWidth(line) <= 72));
	assert.match(initial.join("\n"), /FOLLOWING/);
	assert.match(initial.join("\n"), /Handle retries/);
	assert.doesNotMatch(initial.join("\n"), /\u001b\[31m/);

	component.handleInput("\u001b[5~");
	const paused = component.render(72).join("\n");
	assert.match(paused, /PAUSED/);
	const anchor = paused.match(/output \d+/)?.[0];
	assert.ok(anchor);

	const nextLines = Array.from({ length: 500 }, (_, index) => `output ${index + 11}`);
	loadedSnapshot = {
		...snapshot,
		items: [{
			...snapshot.items[0]!,
			iteration: { ...snapshot.items[0]!.iteration, lines: nextLines, sourceLineCount: 510 },
		}],
	};
	component.handleInput("r");
	await new Promise<void>((resolve) => setImmediate(resolve));
	const refreshed = component.render(72).join("\n");
	assert.match(refreshed, /PAUSED · 10 new/);
	assert.match(refreshed, new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

	component.handleInput("G");
	assert.match(component.render(72).join("\n"), /FOLLOWING/);
	component.dispose();
});

test("LoopMonitorComponent navigates task details and switches to the loops view", () => {
	const snapshot: LoopMonitorSnapshot = {
		cwd: "/tmp/project",
		loadedAt: NOW.getTime(),
		tasks: [
			projectTask({ id: "TASK-002", title: "Handle retries", content: "## Brief\nRetry details" }),
			projectTask({ id: "TASK-003", title: "Add timeout tests", content: "## Brief\nTimeout details" }),
		],
		items: [monitorItem()],
		warnings: [],
	};
	const coloredText: ColoredText[] = [];
	const component = new LoopMonitorComponent(
		{ terminal: { rows: 30 }, requestRender() {} },
		testTheme(coloredText),
		snapshot,
		async () => snapshot,
		() => {},
		{ now: () => NOW.getTime(), autoRefresh: false, initialView: "tasks" },
	);

	const initialLines = component.render(110);
	const initial = initialLines.join("\n");
	assert.ok(initialLines.every((line) => visibleWidth(line) <= 110));
	assert.ok(coloredText.some(({ color }) => color === "thinkingXhigh"));
	assert.ok(coloredText.some(({ color }) => color === "error"));
	assert.match(initial, /\[Tasks\].*Loops/);
	assert.match(initial, /payments · 2/);
	assert.match(initial, /TASK-002 \[todo\].*● 2\/5/);
	assert.match(initial, /TASK-003 \[todo\]/);
	assert.match(initial, /TASK-002 — Handle retries/);
	assert.match(initial, /Working now/);

	component.handleInput("\u001b[A");
	const readySelected = component.render(110).join("\n");
	assert.match(readySelected, /TASK-003 — Add timeout tests/);
	assert.match(readySelected, /Timeout details/);

	component.handleInput("\t");
	const loops = component.render(110).join("\n");
	assert.match(loops, /Tasks.*\[Loops\]/);
	assert.match(loops, /RUNNING · 1/);
	assert.match(loops, /Current iteration 2\/5/);

	component.handleInput("o");
	const relatedTask = component.render(110).join("\n");
	assert.match(relatedTask, /\[Tasks\].*Loops/);
	assert.match(relatedTask, /TASK-002 — Handle retries/);
	component.dispose();
});

test("loopMonitorExtension opens task and loop entry commands without control actions", async (t) => {
	type CommandDefinition = Parameters<ExtensionAPI["registerCommand"]>[1];
	type CustomFactory = (
		tui: { terminal: { rows: number }; requestRender(): void },
		theme: Theme,
		keybindings: unknown,
		done: (value?: void) => void,
	) => LoopMonitorComponent;
	const root = await mkdtemp(join(tmpdir(), "pi-loop-monitor-commands-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const commands = new Map<string, CommandDefinition>();
	const shortcuts = new Set<string>();
	const renders: string[] = [];
	loopMonitorExtension({
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

	assert.deepEqual([...commands.keys()], ["tasks", "loops"]);
	assert.deepEqual([...shortcuts], ["ctrl+shift+l"]);
	assert.equal(commands.has("cancel-loop"), false);
	assert.match(commands.get("tasks")!.description ?? "", /todo, in-progress, and blocked/);
	await commands.get("tasks")!.handler("", context);
	await commands.get("loops")!.handler("", context);
	assert.match(renders[0]!, /\[Tasks\].*Loops/);
	assert.match(renders[1]!, /Tasks.*\[Loops\]/);
});
