import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import agentJobsExtension, {
	buildAgentTask,
	buildLoopCommandArgs,
	buildLoopRunScript,
	buildRunScript,
	collectReviewContext,
	createJobId,
	launchDetachedRunScript,
	parseAgentEvents,
	parseLoopBgCommandArgs,
	parseLoopJobStatusCommandArgs,
	resolveLoopFeature,
	sanitizeJobPart,
	shellQuote,
} from "./index.ts";

const testAgent = {
	name: "oracle",
	description: "test oracle",
	tools: ["read", "grep"],
	model: "provider/model",
	systemPrompt: "You are oracle.",
	source: "user" as const,
	filePath: "/tmp/oracle.md",
};

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function activateLifecycleHarness(sendUserMessage: (content: string, options?: unknown) => void) {
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	agentJobsExtension({
		on(event: string, handler: (event: any, ctx: any) => unknown) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		registerCommand() {},
		registerTool() {},
		sendUserMessage,
		events: { emit() {} },
	} as any);
	return handlers;
}

async function emitLifecycle(handlers: Map<string, Array<(event: any, ctx: any) => unknown>>, event: string, payload: any, ctx: any): Promise<void> {
	for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
}

test("sanitizeJobPart and createJobId produce process-safe names", () => {
	assert.equal(sanitizeJobPart("Researcher Agent!"), "researcher-agent");
	assert.match(createJobId("Oracle Agent", new Date("2026-05-04T12:34:56Z"), "abcdef"), /^oracle-agent-20260504123456-abcdef$/);
});

test("shellQuote escapes single quotes for shell commands", () => {
	assert.equal(shellQuote("/tmp/it's fine"), `'/tmp/it'"'"'s fine'`);
});

test("buildRunScript launches pi in json mode with prompt and persistent logs", () => {
	const script = buildRunScript({
		cwd: "/tmp/repo",
		jobId: "oracle-1",
		agent: testAgent,
		promptPath: "/tmp/repo/.pi/agent-jobs/oracle-1/prompt.md",
		systemPromptPath: "/tmp/repo/.pi/agent-jobs/oracle-1/system-prompt.md",
		eventLogPath: "/tmp/repo/.pi/agent-jobs/oracle-1/events.jsonl",
		stderrPath: "/tmp/repo/.pi/agent-jobs/oracle-1/stderr.log",
		exitPath: "/tmp/repo/.pi/agent-jobs/oracle-1/exit.json",
		pidPath: "/tmp/repo/.pi/agent-jobs/oracle-1/pid",
		resultPath: "/tmp/repo/.pi/agent-jobs/oracle-1/result.md",
	});

	assert.match(script, /pi' '--mode' 'json' '-p' '--no-session'/);
	assert.match(script, /'--model' 'provider\/model'/);
	assert.match(script, /'--tools' 'read,grep'/);
	assert.match(script, /'--append-system-prompt'/);
	assert.match(script, /'@\/tmp\/repo\/\.pi\/agent-jobs\/oracle-1\/prompt\.md' 'Execute the task described in the attached prompt file\.'/);
	assert.match(script, /> '\/tmp\/repo\/\.pi\/agent-jobs\/oracle-1\/events\.jsonl' 2> '\/tmp\/repo\/\.pi\/agent-jobs\/oracle-1\/stderr\.log'/);
	assert.match(script, /exit\.json/);
});

test("buildAgentTask makes Are You Proud validation mandatory for review jobs only", () => {
	const reviewTask = buildAgentTask("current work", "review", "/tmp/review-context.md");
	assert.match(reviewTask, /Run the Are You Proud validation/);
	assert.match(reviewTask, /five-topic quality review/);
	assert.doesNotMatch(buildAgentTask("an architecture question", "standard"), /Are You Proud/);
});

test("launchDetachedRunScript runs independently without tmux", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "agent-job-detached-launch-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const scriptPath = join(root, "run.sh");
	const markerPath = join(root, "finished");
	await writeFile(scriptPath, `#!/usr/bin/env bash\nprintf 'done' > ${JSON.stringify(markerPath)}\n`, "utf8");

	const previousTmux = process.env.TMUX;
	delete process.env.TMUX;
	t.after(() => {
		if (previousTmux === undefined) delete process.env.TMUX;
		else process.env.TMUX = previousTmux;
	});

	const pid = await launchDetachedRunScript(root, scriptPath);
	assert.ok(Number.isInteger(pid) && pid > 0);
	await waitFor(async () => (await readFile(markerPath, "utf8").catch(() => "")) === "done");
});

test("launchDetachedRunScript reports spawn failures", async () => {
	await assert.rejects(launchDetachedRunScript("/path/that/does/not/exist", "/tmp/run.sh"), /spawn|ENOENT/i);
});

test("buildLoopCommandArgs and buildLoopRunScript launch loop.sh with durable logs", () => {
	const command = buildLoopCommandArgs({
		loopScriptPath: "/Users/me/.agents/skills/loop/loop.sh",
		feature: "campaign-stock-ledger",
		task: "TASK-002",
		cwd: "/tmp/repo",
		maxIterations: 5,
		tool: "pi",
		sleepSeconds: 5,
		pollSeconds: 30,
		rateLimitStreak: 3,
	});
	const script = buildLoopRunScript({
		cwd: "/tmp/repo",
		jobId: "loop-1",
		command,
		stdoutPath: "/tmp/repo/.pi/loop-jobs/loop-1/stdout.log",
		stderrPath: "/tmp/repo/.pi/loop-jobs/loop-1/stderr.log",
		exitPath: "/tmp/repo/.pi/loop-jobs/loop-1/exit.json",
		pidPath: "/tmp/repo/.pi/loop-jobs/loop-1/pid",
		resultPath: "/tmp/repo/.pi/loop-jobs/loop-1/result.md",
	});

	assert.deepEqual(command, [
		"bash",
		"/Users/me/.agents/skills/loop/loop.sh",
		"--feature",
		"campaign-stock-ledger",
		"--project-root",
		"/tmp/repo",
		"--task",
		"TASK-002",
		"--tool",
		"pi",
		"--sleep",
		"5",
		"--poll",
		"30",
		"--rate-limit-streak",
		"3",
		"5",
	]);
	assert.match(script, /pi background loop job: loop-1/);
	assert.match(script, /'bash' '\/Users\/me\/\.agents\/skills\/loop\/loop\.sh' '--feature' 'campaign-stock-ledger'/);
	assert.match(script, /> '\/tmp\/repo\/\.pi\/loop-jobs\/loop-1\/stdout\.log' 2> '\/tmp\/repo\/\.pi\/loop-jobs\/loop-1\/stderr\.log'/);
	assert.match(script, /exit\.json/);
});

test("parseLoopBgCommandArgs accepts flags and positional shorthand", () => {
	assert.deepEqual(parseLoopBgCommandArgs("--feature campaign-stock-ledger --task TASK-002 --max 5 --tool pi --poll 30 --sleep 5"), {
		feature: "campaign-stock-ledger",
		task: "TASK-002",
		maxIterations: 5,
		tool: "pi",
		pollSeconds: 30,
		sleepSeconds: 5,
	});
	assert.deepEqual(parseLoopBgCommandArgs("campaign-stock-ledger TASK-002 5"), {
		feature: "campaign-stock-ledger",
		task: "TASK-002",
		maxIterations: 5,
	});
});

test("parseLoopJobStatusCommandArgs supports project-root polling", () => {
	assert.deepEqual(parseLoopJobStatusCommandArgs("--project-root /tmp/repo loop-123"), {
		cwd: "/tmp/repo",
		jobId: "loop-123",
	});
	assert.deepEqual(parseLoopJobStatusCommandArgs("loop-123"), {
		jobId: "loop-123",
	});
});

test("resolveLoopFeature infers feature from task or single ready feature", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-loop-feature-"));
	try {
		await mkdir(join(root, ".features", "alpha", "tasks"), { recursive: true });
		await mkdir(join(root, ".features", "beta", "tasks"), { recursive: true });
		await writeFile(join(root, ".features", "alpha", "tasks", "001-alpha.md"), "---\nid: TASK-001\nstatus: ready\n---\n", "utf8");
		await writeFile(join(root, ".features", "beta", "tasks", "002-beta.md"), "---\nid: TASK-002\nstatus: draft\n---\n", "utf8");

		assert.equal(await resolveLoopFeature(root, undefined, "TASK-002"), "beta");
		assert.equal(await resolveLoopFeature(root), "alpha");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("parseAgentEvents extracts final assistant output, usage, and tool count", () => {
	const events = [
		{ type: "tool_execution_start", toolName: "read" },
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "First draft" }],
				usage: { input: 10, output: 3, cacheRead: 1, cacheWrite: 2, totalTokens: 16, cost: { total: 0.01 } },
				model: "provider/model",
				stopReason: "tool_use",
			},
		},
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Final answer" }],
				usage: { input: 4, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 9, cost: { total: 0.02 } },
				model: "provider/model",
				stopReason: "stop",
			},
		},
	]
		.map((event) => JSON.stringify(event))
		.join("\n");

	const parsed = parseAgentEvents(events);
	assert.equal(parsed.finalOutput, "Final answer");
	assert.equal(parsed.assistantMessages, 2);
	assert.equal(parsed.toolCalls, 1);
	assert.equal(parsed.usage.input, 14);
	assert.equal(parsed.usage.output, 8);
	assert.equal(parsed.usage.cacheRead, 1);
	assert.equal(parsed.usage.cacheWrite, 2);
	assert.equal(parsed.usage.cost, 0.03);
	assert.equal(parsed.model, "provider/model");
	assert.equal(parsed.stopReason, "stop");
});

test("collectReviewContext snapshots diff context without requiring oracle bash access", async () => {
	const commands: string[] = [];
	const outputs = new Map<string, string>([
		["git rev-parse --is-inside-work-tree", "true\n"],
		["git status --short", " M src/app.ts\n?? notes.txt\n"],
		["git diff --cached --stat", ""],
		["git diff --stat", " src/app.ts | 2 +-\n"],
		["git diff --cached --", ""],
		["git diff --", "diff --git a/src/app.ts b/src/app.ts\n"],
		["git ls-files --others --exclude-standard", ""],
	]);
	const pi = {
		exec: async (_cmd: string, args: string[]) => {
			commands.push(args[1]!);
			return { stdout: outputs.get(args[1]!) ?? "", stderr: "" };
		},
	} as Pick<ExtensionAPI, "exec">;

	const context = await collectReviewContext(pi as ExtensionAPI, "/tmp/repo", "review current work");

	assert.deepEqual(commands, Array.from(outputs.keys()));
	assert.match(context, /# Review Context/);
	assert.match(context, /Focus: review current work/);
	assert.match(context, /git status --short/);
	assert.match(context, /diff --git a\/src\/app\.ts b\/src\/app\.ts/);
	assert.match(context, /read\/grep\/find\/ls/);
});

test("session start serially delivers pending agent and loop follow-ups and acknowledges them when received", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "agent-job-pending-follow-up-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const createdAt = new Date().toISOString();
	const agentJobId = "researcher-completed";
	const agentJobDir = join(root, ".pi", "agent-jobs", agentJobId);
	const loopJobId = "loop-completed";
	const loopJobDir = join(root, ".pi", "loop-jobs", loopJobId);
	await mkdir(agentJobDir, { recursive: true });
	await mkdir(loopJobDir, { recursive: true });
	await writeFile(join(agentJobDir, "result.md"), "Agent finished output.\n", "utf8");
	await writeFile(join(loopJobDir, "result.md"), "Loop finished output.\n", "utf8");
	await writeFile(join(agentJobDir, "status.json"), JSON.stringify({
		jobId: agentJobId,
		agent: "researcher",
		mode: "standard",
		cwd: root,
		createdAt,
		updatedAt: createdAt,
		state: "completed",
		tmuxWindow: "pi-researcher-test",
		jobDir: agentJobDir,
		resultPath: join(agentJobDir, "result.md"),
		eventLogPath: join(agentJobDir, "events.jsonl"),
		followUp: true,
		followUpSent: false,
	}), "utf8");
	await writeFile(join(loopJobDir, "status.json"), JSON.stringify({
		jobId: loopJobId,
		feature: "fixture",
		task: "TASK-001",
		cwd: root,
		createdAt,
		updatedAt: createdAt,
		state: "completed",
		tmuxWindow: "pi-loop-test",
		jobDir: loopJobDir,
		resultPath: join(loopJobDir, "result.md"),
		loopLogPath: join(loopJobDir, "loop.log"),
		loopSummaryPath: join(loopJobDir, "latest-iteration.md"),
		followUp: true,
		followUpSent: false,
	}), "utf8");

	const sent: Array<{ content: string; options?: unknown }> = [];
	const handlers = activateLifecycleHarness((content, options) => sent.push({ content, options }));
	await emitLifecycle(handlers, "session_start", {}, { cwd: root });
	await waitFor(() => sent.length === 1);
	assert.equal(JSON.parse(await readFile(join(agentJobDir, "status.json"), "utf8")).followUpSent, false);
	assert.equal(JSON.parse(await readFile(join(loopJobDir, "status.json"), "utf8")).followUpSent, false);

	await emitLifecycle(handlers, "message_start", {
		message: { role: "user", content: [{ type: "text", text: sent[0]!.content }] },
	}, { cwd: root });
	await waitFor(() => sent.length === 2);

	assert.ok(sent.some(({ content }) => content.includes("Agent finished output.")));
	assert.ok(sent.some(({ content }) => content.includes("Loop finished output.")));
	for (const message of sent) assert.deepEqual(message.options, { deliverAs: "followUp" });
	const deliveryStates = [
		JSON.parse(await readFile(join(agentJobDir, "status.json"), "utf8")).followUpSent,
		JSON.parse(await readFile(join(loopJobDir, "status.json"), "utf8")).followUpSent,
	];
	assert.equal(deliveryStates.filter(Boolean).length, 1);

	await emitLifecycle(handlers, "message_start", {
		message: { role: "user", content: [{ type: "text", text: sent[1]!.content }] },
	}, { cwd: root });
	assert.equal(JSON.parse(await readFile(join(agentJobDir, "status.json"), "utf8")).followUpSent, true);
	assert.equal(JSON.parse(await readFile(join(loopJobDir, "status.json"), "utf8")).followUpSent, true);
	await emitLifecycle(handlers, "session_shutdown", {}, {});
});

test("a completion follow-up is delivered only to its originating Pi session", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "agent-job-origin-session-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const jobId = "researcher-origin";
	const jobDir = join(root, ".pi", "agent-jobs", jobId);
	const resultPath = join(jobDir, "result.md");
	const createdAt = new Date().toISOString();
	await mkdir(jobDir, { recursive: true });
	await writeFile(resultPath, "Origin-only output.\n", "utf8");
	await writeFile(join(jobDir, "status.json"), JSON.stringify({
		jobId,
		agent: "researcher",
		mode: "standard",
		cwd: root,
		createdAt,
		updatedAt: createdAt,
		state: "completed",
		jobDir,
		resultPath,
		eventLogPath: join(jobDir, "events.jsonl"),
		originSessionId: "session-origin",
		followUp: true,
		followUpSent: false,
	}), "utf8");

	const unrelatedMessages: string[] = [];
	const unrelatedHandlers = activateLifecycleHarness((content) => unrelatedMessages.push(content));
	await emitLifecycle(unrelatedHandlers, "session_start", {}, {
		cwd: root,
		sessionManager: { getSessionId: () => "session-other", getSessionFile: () => "/tmp/other.jsonl" },
	});
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(unrelatedMessages, []);
	await emitLifecycle(unrelatedHandlers, "session_shutdown", {}, {});

	const originMessages: string[] = [];
	const originHandlers = activateLifecycleHarness((content) => originMessages.push(content));
	await emitLifecycle(originHandlers, "session_start", {}, {
		cwd: root,
		sessionManager: { getSessionId: () => "session-origin", getSessionFile: () => "/tmp/origin.jsonl" },
	});
	await waitFor(() => originMessages.length === 1);
	assert.match(originMessages[0]!, /Origin-only output\./);
	await emitLifecycle(originHandlers, "message_start", {
		message: { role: "user", content: [{ type: "text", text: originMessages[0] }] },
	}, { cwd: root });
	assert.equal(JSON.parse(await readFile(join(jobDir, "status.json"), "utf8")).followUpSent, true);
	await emitLifecycle(originHandlers, "session_shutdown", {}, {});
});

test("a completion follow-up rejected during shutdown is retried by the next session", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "agent-job-follow-up-retry-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const jobId = "researcher-retry";
	const jobDir = join(root, ".pi", "agent-jobs", jobId);
	const resultPath = join(jobDir, "result.md");
	const createdAt = new Date().toISOString();
	await mkdir(jobDir, { recursive: true });
	await writeFile(resultPath, "Recovered output.\n", "utf8");
	await writeFile(join(jobDir, "status.json"), JSON.stringify({
		jobId,
		agent: "researcher",
		mode: "standard",
		cwd: root,
		createdAt,
		updatedAt: createdAt,
		state: "completed",
		tmuxWindow: "pi-researcher-test",
		jobDir,
		resultPath,
		eventLogPath: join(jobDir, "events.jsonl"),
		followUp: true,
		followUpSent: false,
	}), "utf8");

	let attempts = 0;
	const staleHandlers = activateLifecycleHarness(() => {
		attempts += 1;
		throw new Error("stale extension runtime");
	});
	await emitLifecycle(staleHandlers, "session_start", {}, { cwd: root });
	await waitFor(() => attempts === 1);
	assert.equal(JSON.parse(await readFile(join(jobDir, "status.json"), "utf8")).followUpSent, false);
	await emitLifecycle(staleHandlers, "session_shutdown", {}, {});

	const sent: string[] = [];
	const resumedHandlers = activateLifecycleHarness((content) => sent.push(content));
	await emitLifecycle(resumedHandlers, "session_start", {}, { cwd: root });
	await waitFor(() => sent.length === 1);
	assert.match(sent[0]!, /Recovered output\./);
	await emitLifecycle(resumedHandlers, "message_start", {
		message: { role: "user", content: [{ type: "text", text: sent[0] }] },
	}, { cwd: root });
	assert.equal(JSON.parse(await readFile(join(jobDir, "status.json"), "utf8")).followUpSent, true);
	await emitLifecycle(resumedHandlers, "session_shutdown", {}, {});
});

test("agent job cancellation stays pending until the process exits", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "agent-job-cancel-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const jobId = "fixture-job";
	const jobDir = join(root, ".pi", "agent-jobs", jobId);
	const runScriptPath = join(jobDir, "run.sh");
	await mkdir(jobDir, { recursive: true });
	const readyPath = join(jobDir, "pid");
	await writeFile(runScriptPath, `#!/usr/bin/env bash\ntrap 'exit 130' INT TERM\necho $$ > ${JSON.stringify(readyPath)}\nwhile :; do sleep 1; done\n`, "utf8");
	const processId = await launchDetachedRunScript(root, runScriptPath, readyPath);
	t.after(() => {
		try { process.kill(-processId, "SIGKILL"); } catch {}
	});
	await writeFile(join(jobDir, "status.json"), JSON.stringify({
		jobId,
		cwd: root,
		state: "running",
		processId,
		jobDir,
		updatedAt: new Date().toISOString(),
		followUp: false,
		followUpSent: false,
	}), "utf8");
	const tools = new Map<string, any>();
	agentJobsExtension({
		on() {},
		registerCommand() {},
		registerTool(definition: any) {
			tools.set(definition.name, definition);
		},
	} as any);

	const result = await tools.get("agent_job_cancel").execute("call-1", { jobId }, undefined, undefined, { cwd: root });
	assert.equal(result.details.state, "running");
	assert.ok(result.details.cancelRequestedAt);
	assert.match(result.content[0].text, /Cancellation requested/);
});

test("loop cancellation preserves an exit marker for later finalization", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "loop-job-cancel-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const jobId = "loop-fixture";
	const jobDir = join(root, ".pi", "loop-jobs", jobId);
	const runScriptPath = join(jobDir, "run.sh");
	const exitPath = join(jobDir, "exit.json");
	await mkdir(jobDir, { recursive: true });
	const runScript = buildLoopRunScript({
		cwd: root,
		jobId,
		command: ["bash", "-c", "trap 'exit 130' INT TERM; while :; do sleep 1; done"],
		stdoutPath: join(jobDir, "stdout.log"),
		stderrPath: join(jobDir, "stderr.log"),
		exitPath,
		pidPath: join(jobDir, "pid"),
		resultPath: join(jobDir, "result.md"),
	});
	await writeFile(runScriptPath, runScript, "utf8");
	const processId = await launchDetachedRunScript(root, runScriptPath, join(jobDir, "pid"));
	t.after(() => {
		try { process.kill(-processId, "SIGKILL"); } catch {}
	});
	const createdAt = new Date().toISOString();
	await writeFile(join(jobDir, "status.json"), JSON.stringify({
		jobId,
		feature: "fixture",
		cwd: root,
		createdAt,
		updatedAt: createdAt,
		state: "running",
		processId,
		jobDir,
		runScriptPath,
		stdoutPath: join(jobDir, "stdout.log"),
		stderrPath: join(jobDir, "stderr.log"),
		resultPath: join(jobDir, "result.md"),
		exitPath,
		pidPath: join(jobDir, "pid"),
		loopLogPath: join(jobDir, "loop.log"),
		loopSummaryPath: join(jobDir, "latest-iteration.md"),
		followUp: false,
		followUpSent: false,
	}), "utf8");
	const tools = new Map<string, any>();
	agentJobsExtension({
		on() {},
		registerCommand() {},
		registerTool(definition: any) { tools.set(definition.name, definition); },
	} as any);

	const cancellation = await tools.get("loop_job_cancel").execute("call-1", { jobId, cwd: root }, undefined, undefined, { cwd: root });
	assert.equal(cancellation.details.state, "running");
	await waitFor(async () => Boolean(await readFile(exitPath, "utf8").catch(() => "")), 2000);
	const finalized = await tools.get("loop_job_status").execute("call-2", { jobId, cwd: root }, undefined, undefined, { cwd: root });
	assert.equal(finalized.details.state, "cancelled");
});

test("agentJobsExtension registers background job tools and commands", () => {
	const tools = new Set<string>();
	const commands = new Set<string>();

	const api = {
		on() {},
		registerTool(definition: { name: string }) {
			tools.add(definition.name);
		},
		registerCommand(name: string) {
			commands.add(name);
		},
	} as unknown as ExtensionAPI;

	agentJobsExtension(api);

	assert.deepEqual([...tools].sort(), ["agent_job_cancel", "agent_job_start", "agent_job_status", "loop_job_cancel", "loop_job_start", "loop_job_status"]);
	assert.deepEqual([...commands].sort(), ["agent-job-status", "ask-oracle-bg", "deep-review-bg", "loop-bg", "loop-job-status", "research-bg"]);
});
