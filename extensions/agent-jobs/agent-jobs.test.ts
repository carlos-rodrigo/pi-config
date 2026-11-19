import test, { after } from "node:test";
import { execFileSync } from "node:child_process";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { assertStructuredContent } from "../lib/assert-structured-content.ts";

import agentJobsExtension, {
	buildAgentTask,
	buildRunScript,
	collectReviewContext,
	createJobId,
	launchDetachedRunScript,
	parseAgentEvents,
	parseJobStatusCommandArgs,
	sanitizeJobPart,
	shellQuote,
	shouldTerminateAfterAgentJobStart,
} from "./index.ts";

// An isolated, empty trust store keeps the user's ~/.pi/agent untouched.
const agentDir = await mkdtemp(join(tmpdir(), "agent-jobs-agent-dir-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(async () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(agentDir, { recursive: true, force: true });
});

const testAgent = {
	name: "oracle",
	description: "test oracle",
	tools: ["read", "grep"],
	model: "provider/model",
	systemPrompt: "You are oracle.",
	source: "user" as const,
	filePath: "/tmp/oracle.md",
};

// Waits only for positive conditions, so the generous deadline bounds failures without slowing passing runs under load.
const WAIT_TIMEOUT_MS = 30_000;
// In-process deliveries caused by an immediate trigger (initial poll, post-acknowledgement re-poll) must arrive
// before the watcher's 5 s interval backstop could deliver them instead.
const IMMEDIATE_TRIGGER_TIMEOUT_MS = 2_000;

async function waitFor(predicate: () => boolean | Promise<boolean>, description = "condition", timeoutMs = WAIT_TIMEOUT_MS): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (!(await predicate())) {
		if (performance.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function waitForImmediateTrigger(predicate: () => boolean | Promise<boolean>, description: string): Promise<void> {
	return waitFor(predicate, description, IMMEDIATE_TRIGGER_TIMEOUT_MS);
}

function activateLifecycleHarness(sendUserMessage: (content: string, options?: unknown) => void, onEmit: (name: string) => void = () => {}) {
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
		events: { emit: onEmit },
	} as any);
	return handlers;
}

async function emitLifecycle(handlers: Map<string, Array<(event: any, ctx: any) => unknown>>, event: string, payload: any, ctx: any): Promise<void> {
	for (const handler of handlers.get(event) ?? []) await handler(payload, { isProjectTrusted: () => true, ...ctx });
}

test("session startup no longer emits unused composer job counts", async t => {
	const root = await mkdtemp(join(tmpdir(), "agent-no-count-events-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const emitted: string[] = [];
	const handlers = activateLifecycleHarness(() => {}, name => emitted.push(name));
	await emitLifecycle(handlers, "session_start", {}, { cwd: root });
	await emitLifecycle(handlers, "session_shutdown", {}, { cwd: root });
	assert.ok(!emitted.includes("agent-jobs:running-count"));
});

test("sanitizeJobPart and createJobId produce process-safe names", () => {
	assert.equal(sanitizeJobPart("Researcher Agent!"), "researcher-agent");
	assert.match(createJobId("Oracle Agent", new Date("2026-05-04T12:34:56Z"), "abcdef"), /^oracle-agent-20260504123456-abcdef$/);
});

test("shellQuote escapes single quotes for shell commands", () => {
	assert.equal(shellQuote("/tmp/it's fine"), `'/tmp/it'"'"'s fine'`);
});

test("agent job start keeps explicit polling workflows active", () => {
	assert.equal(shouldTerminateAfterAgentJobStart(true), true);
	assert.equal(shouldTerminateAfterAgentJobStart(false), false);
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
	await waitFor(async () => (await readFile(markerPath, "utf8").catch(() => "")) === "done", `detached script marker ${markerPath}`);
});

test("launchDetachedRunScript reports spawn failures", async () => {
	await assert.rejects(launchDetachedRunScript("/path/that/does/not/exist", "/tmp/run.sh"), /spawn|ENOENT/i);
});

test("parseJobStatusCommandArgs supports project-root polling", () => {
	assert.deepEqual(parseJobStatusCommandArgs("--project-root /tmp/repo oracle-123"), {
		cwd: "/tmp/repo",
		jobId: "oracle-123",
	});
	assert.deepEqual(parseJobStatusCommandArgs("oracle-123"), {
		jobId: "oracle-123",
	});
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

test("session start serially delivers pending agent follow-ups and acknowledges them when received", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "agent-job-pending-follow-up-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const createdAt = new Date().toISOString();
	const agentJobId = "researcher-completed";
	const agentJobDir = join(root, ".pi", "agent-jobs", agentJobId);
	const oracleJobId = "oracle-completed";
	const oracleJobDir = join(root, ".pi", "agent-jobs", oracleJobId);
	await mkdir(agentJobDir, { recursive: true });
	await mkdir(oracleJobDir, { recursive: true });
	await writeFile(join(agentJobDir, "result.md"), "Agent finished output.\n", "utf8");
	await writeFile(join(oracleJobDir, "result.md"), "Oracle finished output.\n", "utf8");
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
	await writeFile(join(oracleJobDir, "status.json"), JSON.stringify({
		jobId: oracleJobId,
		agent: "oracle",
		mode: "standard",
		cwd: root,
		createdAt,
		updatedAt: createdAt,
		state: "completed",
		tmuxWindow: "pi-oracle-test",
		jobDir: oracleJobDir,
		resultPath: join(oracleJobDir, "result.md"),
		eventLogPath: join(oracleJobDir, "events.jsonl"),
		followUp: true,
		followUpSent: false,
	}), "utf8");

	const sent: Array<{ content: string; options?: unknown }> = [];
	const handlers = activateLifecycleHarness((content, options) => sent.push({ content, options }));
	await emitLifecycle(handlers, "session_start", {}, { cwd: root });
	await waitForImmediateTrigger(() => sent.length === 1, "first follow-up delivered at session_start");
	assert.equal(JSON.parse(await readFile(join(agentJobDir, "status.json"), "utf8")).followUpSent, false);
	assert.equal(JSON.parse(await readFile(join(oracleJobDir, "status.json"), "utf8")).followUpSent, false);

	await emitLifecycle(handlers, "message_start", {
		message: { role: "user", content: [{ type: "text", text: sent[0]!.content }] },
	}, { cwd: root });
	await waitForImmediateTrigger(() => sent.length === 2, "second follow-up delivered after acknowledgement");

	assert.ok(sent.some(({ content }) => content.includes("Agent finished output.")));
	assert.ok(sent.some(({ content }) => content.includes("Oracle finished output.")));
	for (const message of sent) assert.deepEqual(message.options, { deliverAs: "followUp" });
	const deliveryStates = [
		JSON.parse(await readFile(join(agentJobDir, "status.json"), "utf8")).followUpSent,
		JSON.parse(await readFile(join(oracleJobDir, "status.json"), "utf8")).followUpSent,
	];
	assert.equal(deliveryStates.filter(Boolean).length, 1);

	await emitLifecycle(handlers, "message_start", {
		message: { role: "user", content: [{ type: "text", text: sent[1]!.content }] },
	}, { cwd: root });
	assert.equal(JSON.parse(await readFile(join(agentJobDir, "status.json"), "utf8")).followUpSent, true);
	assert.equal(JSON.parse(await readFile(join(oracleJobDir, "status.json"), "utf8")).followUpSent, true);
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
	await waitForImmediateTrigger(() => originMessages.length === 1, "follow-up delivered to the origin session");
	assert.match(originMessages[0]!, /Origin-only output\./);
	await emitLifecycle(originHandlers, "message_start", {
		message: { role: "user", content: [{ type: "text", text: originMessages[0] }] },
	}, { cwd: root, sessionManager: { getSessionId: () => "session-origin", getSessionFile: () => "/tmp/origin.jsonl" } });
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
	await waitForImmediateTrigger(() => attempts === 1, "rejected follow-up attempt at session_start");
	assert.equal(JSON.parse(await readFile(join(jobDir, "status.json"), "utf8")).followUpSent, false);
	await emitLifecycle(staleHandlers, "session_shutdown", {}, {});

	const sent: string[] = [];
	const resumedHandlers = activateLifecycleHarness((content) => sent.push(content));
	await emitLifecycle(resumedHandlers, "session_start", {}, { cwd: root });
	await waitForImmediateTrigger(() => sent.length === 1, "follow-up retried by the next session");
	assert.match(sent[0]!, /Recovered output\./);
	await emitLifecycle(resumedHandlers, "message_start", {
		message: { role: "user", content: [{ type: "text", text: sent[0] }] },
	}, { cwd: root });
	assert.equal(JSON.parse(await readFile(join(jobDir, "status.json"), "utf8")).followUpSent, true);
	await emitLifecycle(resumedHandlers, "session_shutdown", {}, {});
});

test("agent job cancellation stays pending until the process exits", async (t) => {
	t.mock.method(ProjectTrustStore.prototype, "get", () => true);
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
		exec: async (command: string, args: string[]) => ({ code: 0, stdout: execFileSync(command, args, { encoding: "utf8" }), stderr: "", killed: false }),
	} as any);

	const result = await tools.get("agent_job_cancel").execute("call-1", { jobId, cwd: root }, undefined, undefined, { cwd: tmpdir(), isProjectTrusted: () => true });
	assert.equal(result.details.state, "running");
	assert.ok(result.details.cancelRequestedAt);
	assert.match(result.content[0].text, /Cancellation requested/);
});

test("agent status and listing accept absolute or relative project roots", async (t) => {
	t.mock.method(ProjectTrustStore.prototype, "get", () => true);
	const parent = await mkdtemp(join(tmpdir(), "agent-status-cross-project-"));
	t.after(() => rm(parent, { recursive: true, force: true }));
	const root = join(parent, "target");
	const jobId = "completed-fixture";
	const jobDir = join(root, ".pi", "agent-jobs", jobId);
	await mkdir(jobDir, { recursive: true });
	const resultPath = join(jobDir, "result.md");
	await writeFile(resultPath, "Review complete.");
	await writeFile(join(jobDir, "status.json"), JSON.stringify({
		jobId, cwd: root, jobDir, agent: "oracle", state: "completed", resultPath,
		createdAt: new Date().toISOString(), followUp: false,
	}));
	const tools = new Map<string, ToolDefinition>();
	agentJobsExtension({
		on() {}, registerCommand() {},
		registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
	} as unknown as ExtensionAPI);
	const ctx = { cwd: parent, isProjectTrusted: () => true } as ExtensionContext;
	for (const cwd of [root, "target"]) {
		const status = await tools.get("agent_job_status")!.execute("status", { jobId, cwd }, undefined, undefined, ctx);
		assert.match(JSON.stringify(status.content), /Review complete/);
		const list = await tools.get("agent_job_status")!.execute("list", { cwd }, undefined, undefined, ctx);
		assert.match(JSON.stringify(list.content), /completed-fixture/);
	}
	await assert.rejects(tools.get("agent_job_status")!.execute("missing", { jobId, cwd: "absent" }, undefined, undefined, ctx), /ENOENT/);
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

	assert.deepEqual([...tools].sort(), ["agent_job_cancel", "agent_job_start", "agent_job_status", "subagent"]);
	assert.deepEqual([...commands].sort(), ["agent-job-status", "agent-notification-retry", "agents", "ask-oracle-bg", "deep-review-bg", "research-bg"]);
});

const PRIVATE_JOB_FIELDS = /processId|tmuxWindow|originSession|runScriptPath|pidPath|promptPath|eventLogPath|stderrPath/;

function registeredJobTools(): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	agentJobsExtension({
		on() {}, registerCommand() {},
		registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
	} as unknown as ExtensionAPI);
	return tools;
}

test("agent_job_status returns structured job state without internal runtime fields", async (t) => {
	t.mock.method(ProjectTrustStore.prototype, "get", () => true);
	const root = await mkdtemp(join(tmpdir(), "agent-status-structured-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const tools = registeredJobTools();
	const tool = tools.get("agent_job_status")!;
	const ctx = { cwd: root, isProjectTrusted: () => true } as ExtensionContext;

	const empty = await tool.execute("empty", {}, undefined, undefined, ctx);
	assert.deepEqual(assertStructuredContent(tool, empty), { jobs: [] });

	const jobDir = join(root, ".pi", "agent-jobs", "oracle-done");
	await mkdir(jobDir, { recursive: true });
	const resultPath = join(jobDir, "result.md");
	await writeFile(resultPath, "Review complete.");
	await writeFile(join(jobDir, "status.json"), JSON.stringify({
		jobId: "oracle-done", agent: "oracle", agentSource: "user", mode: "review", task: "Review the diff", cwd: root,
		createdAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-01T10:05:00.000Z", completedAt: "2026-10-01T10:05:00.000Z",
		state: "completed", exitCode: 0, summary: "Review complete.", model: "openai/gpt", followUp: false, followUpSent: false,
		processId: 4242, tmuxWindow: "pi:1", originSessionId: "session-1", originSessionFile: "/private/session.jsonl",
		jobDir, runScriptPath: join(jobDir, "run.sh"), pidPath: join(jobDir, "pid"), promptPath: join(jobDir, "prompt.md"),
		eventLogPath: join(jobDir, "events.jsonl"), stderrPath: join(jobDir, "stderr.log"), exitPath: join(jobDir, "exit.json"), resultPath,
	}));
	const legacyDir = join(root, ".pi", "agent-jobs", "legacy");
	await mkdir(legacyDir, { recursive: true });
	await writeFile(join(legacyDir, "status.json"), JSON.stringify({ jobId: "legacy", cwd: root, jobDir: legacyDir, agent: "researcher", state: "failed", createdAt: "2026-09-30T10:00:00.000Z" }));

	const explicit = await tool.execute("status", { jobId: "oracle-done" }, undefined, undefined, ctx);
	assert.match(JSON.stringify(explicit.content), /Review complete/);
	const data = assertStructuredContent(tool, explicit);
	assert.equal(data.job.jobId, "oracle-done");
	assert.equal(data.job.state, "completed");
	assert.equal(data.job.mode, "review");
	assert.ok(data.job.resultPath.endsWith("/.pi/agent-jobs/oracle-done/result.md"));
	assert.equal(data.resultPreview, "Review complete.");
	assert.equal(data.jobs, undefined);
	assert.doesNotMatch(JSON.stringify(data), PRIVATE_JOB_FIELDS);

	const listed = assertStructuredContent(tool, await tool.execute("list", {}, undefined, undefined, ctx));
	assert.deepEqual(listed.jobs.map((job: any) => [job.jobId, job.state]).sort(), [["legacy", "failed"], ["oracle-done", "completed"]]);
	assert.doesNotMatch(JSON.stringify(listed), PRIVATE_JOB_FIELDS);
});

test("agent_job_status structured summaries drop malformed fields and bound text and list size", async (t) => {
	t.mock.method(ProjectTrustStore.prototype, "get", () => true);
	const root = await mkdtemp(join(tmpdir(), "agent-status-bounds-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const tool = registeredJobTools().get("agent_job_status")!;
	const ctx = { cwd: root, isProjectTrusted: () => true } as ExtensionContext;
	for (let index = 0; index < 11; index++) {
		const jobId = `job-${String(index).padStart(2, "0")}`;
		const jobDir = join(root, ".pi", "agent-jobs", jobId);
		await mkdir(jobDir, { recursive: true });
		await writeFile(join(jobDir, "status.json"), JSON.stringify({
			jobId, cwd: root, jobDir, agent: "oracle", state: "completed", createdAt: `2026-10-01T10:${String(index).padStart(2, "0")}:00.000Z`,
			task: "x".repeat(5000), mode: null, followUp: null, exitCode: "0",
		}));
	}

	const longResult = `${"head ".repeat(400)}${"y".repeat(6500)}TAIL`;
	await writeFile(join(root, ".pi", "agent-jobs", "job-00", "result.md"), longResult);
	const explicit = assertStructuredContent(tool, await tool.execute("status", { jobId: "job-00" }, undefined, undefined, ctx));
	assert.equal(explicit.resultPreview, `…[truncated ${longResult.length - 6000} chars]…\n${longResult.slice(-6000)}`);
	assert.equal(explicit.job.task.length, 1001);
	assert.equal(explicit.job.mode, undefined);
	assert.equal(explicit.job.followUp, undefined);
	assert.equal(explicit.job.exitCode, undefined);

	const listed = await tool.execute("list", {}, undefined, undefined, ctx);
	assert.equal(assertStructuredContent(tool, listed).jobs.length, 10);
	assert.equal((listed.content[0] as { text: string }).text.split("\n").length, 10);
});
