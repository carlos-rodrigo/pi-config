import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

import loopMonitorExtension, {
	LoopMonitorComponent,
	buildTaskSections,
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
		status: "ready",
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
		taskStatus: "ready",
		association: "explicit",
		board: { current: "TASK-002", next: "TASK-003", blockers: "none", tasks: new Map() },
		iteration: { iteration: 2, maxIterations: 5, finished: false, lines: ["Working now"], sourceLineCount: 1 },
		logUpdatedAt: NOW.getTime() - 2000,
		...overrides,
	};
}

function testTheme(colors?: string[]): Theme {
	return new Proxy({}, {
		get: (_target, property) => property === "bold"
			? (text: string) => text
			: (color: string, text: string) => {
				colors?.push(color);
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

test("parseActiveTaskBoard reads current, next, blockers, and task metadata", () => {
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
	assert.deepEqual(board.tasks.get("TASK-002"), { id: "TASK-002", title: "Handle retries", status: "ready" });
});

test("parseTaskBrief reads frontmatter, title, and display content", () => {
	const task = parseTaskBrief(`---
id: TASK-003
status: ready
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
		status: "ready",
		filePath: "/tmp/project/.features/payments/tasks/003-timeouts.md",
		content: "## Brief\n\n- Goal: Cover timeout behavior.",
	});
});

test("buildTaskSections separates ready tasks from tasks with running loops", () => {
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

	const sections = buildTaskSections([taskTwo, taskThree, taskThree, blocked], [running, recent, unassigned]);

	assert.deepEqual(sections.ready.map((entry) => entry.task.id), ["TASK-003"]);
	assert.deepEqual(sections.inProgress.map((entry) => entry.task.id), ["TASK-002"]);
	assert.deepEqual(sections.inProgress[0]?.loops.map((item) => item.job.jobId), ["loop-1"]);
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
## Progress
- [ ] TASK-002 — Handle retries (ready)
- [ ] TASK-003 — Add timeout tests (ready)
## Current / Next
- Current: TASK-002
- Next: TASK-003
- Blockers: none
`, "utf8");
	await writeFile(join(featureDir, "tasks", "002-handle-retries.md"), `---
id: TASK-002
status: ready
---
# TASK-002 — Handle retries
## Brief
- Goal: Add reliable retries.
`, "utf8");
	await writeFile(join(featureDir, "tasks", "003-timeouts.md"), `---
id: TASK-003
status: ready
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
	assert.equal(explicit?.association, "explicit");
	assert.equal(explicit?.iteration.iteration, 3);
	assert.deepEqual(explicit?.iteration.lines.slice(-1), ["Working now"]);
	assert.equal(inferred?.taskId, "TASK-002");
	assert.equal(inferred?.association, "inferred");
	assert.deepEqual(snapshot.tasks.map((task) => task.id), ["TASK-002", "TASK-003"]);
	const sections = buildTaskSections(snapshot.tasks, snapshot.items);
	assert.deepEqual(sections.ready.map((entry) => entry.task.id), ["TASK-003"]);
	assert.deepEqual(sections.inProgress[0]?.loops.map((item) => item.job.jobId).sort(), ["loop-current", "loop-feature"]);
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
	const renderedColors: string[] = [];
	const component = new LoopMonitorComponent(
		{ terminal: { rows: 30 }, requestRender() {} },
		testTheme(renderedColors),
		snapshot,
		async () => snapshot,
		() => {},
		{ now: () => NOW.getTime(), autoRefresh: false, initialView: "tasks" },
	);

	const initialLines = component.render(110);
	const initial = initialLines.join("\n");
	assert.ok(initialLines.every((line) => visibleWidth(line) <= 110));
	assert.ok(renderedColors.includes("thinkingXhigh"));
	assert.ok(renderedColors.includes("error"));
	assert.match(initial, /\[Tasks\].*Loops/);
	assert.match(initial, /READY · 1/);
	assert.match(initial, /IN PROGRESS · 1/);
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
	await commands.get("tasks")!.handler("", context);
	await commands.get("loops")!.handler("", context);
	assert.match(renders[0]!, /\[Tasks\].*Loops/);
	assert.match(renders[1]!, /Tasks.*\[Loops\]/);
});
