import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import agentJobsExtension, {
	buildLoopCommandArgs,
	buildLoopRunScript,
	buildRunScript,
	buildTmuxNewWindowArgs,
	collectReviewContext,
	createJobId,
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

test("sanitizeJobPart and createJobId produce tmux-safe names", () => {
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

test("buildTmuxNewWindowArgs creates a detached window that exits when the job finishes", () => {
	const args = buildTmuxNewWindowArgs("pi-oracle-abcdef", "/tmp/repo", "/tmp/repo/.pi/agent-jobs/job/run.sh");

	assert.deepEqual(args.slice(0, 6), ["new-window", "-d", "-n", "pi-oracle-abcdef", "-c", "/tmp/repo"]);
	assert.equal(args[6], "bash '/tmp/repo/.pi/agent-jobs/job/run.sh'");
	assert.doesNotMatch(args[6]!, /read _|Press Enter to close/);
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

test("agent job launch rejects a nonzero tmux result", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "agent-job-launch-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, ".pi", "agents"), { recursive: true });
	await writeFile(
		join(root, ".pi", "agents", "fixture.md"),
		"---\nname: fixture\ndescription: fixture agent\n---\n\nReview the task.\n",
		"utf8",
	);
	const tools = new Map<string, any>();
	const previousTmux = process.env.TMUX;
	process.env.TMUX = "/tmp/tmux-test";
	t.after(() => {
		if (previousTmux === undefined) delete process.env.TMUX;
		else process.env.TMUX = previousTmux;
	});

	agentJobsExtension({
		on() {},
		registerCommand() {},
		registerTool(definition: any) {
			tools.set(definition.name, definition);
		},
		getAllTools() {
			return [];
		},
		exec: async () => ({ stdout: "", stderr: "tmux launch failed", code: 1, killed: false }),
	} as any);

	await assert.rejects(
		tools.get("agent_job_start").execute(
			"call-1",
			{ agent: "fixture", task: "check launch", cwd: root, agentScope: "project", confirmProjectAgents: false, followUp: false },
			undefined,
			undefined,
			{ cwd: root, signal: undefined, hasUI: false, ui: {} },
		),
		/tmux launch failed/,
	);
});

test("agent job cancellation stays pending until the process exits", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "agent-job-cancel-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const jobId = "fixture-job";
	const jobDir = join(root, ".pi", "agent-jobs", jobId);
	await mkdir(jobDir, { recursive: true });
	await writeFile(join(jobDir, "status.json"), JSON.stringify({
		jobId,
		cwd: root,
		state: "running",
		tmuxWindow: "pi-fixture",
		jobDir,
		updatedAt: new Date().toISOString(),
	}), "utf8");
	const tools = new Map<string, any>();
	agentJobsExtension({
		on() {},
		registerCommand() {},
		registerTool(definition: any) {
			tools.set(definition.name, definition);
		},
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
	} as any);

	const result = await tools.get("agent_job_cancel").execute("call-1", { jobId }, undefined, undefined, { cwd: root });
	assert.equal(result.details.state, "running");
	assert.ok(result.details.cancelRequestedAt);
	assert.match(result.content[0].text, /Cancellation requested/);
});

for (const fixture of [
	{ kind: "agent", directory: "agent-jobs", tool: "agent_job_cancel" },
	{ kind: "loop", directory: "loop-jobs", tool: "loop_job_cancel" },
] as const) {
	test(`${fixture.kind} hard cancellation failure remains pending`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), `${fixture.kind}-job-hard-cancel-`));
		t.after(() => rm(root, { recursive: true, force: true }));
		const jobId = "fixture-job";
		const jobDir = join(root, ".pi", fixture.directory, jobId);
		await mkdir(jobDir, { recursive: true });
		await writeFile(join(jobDir, "status.json"), JSON.stringify({
			jobId,
			cwd: root,
			state: "running",
			tmuxWindow: "pi-fixture",
			jobDir,
			updatedAt: new Date().toISOString(),
		}), "utf8");
		const tools = new Map<string, any>();
		let execCalls = 0;
		agentJobsExtension({
			on() {},
			registerCommand() {},
			registerTool(definition: any) {
				tools.set(definition.name, definition);
			},
			exec: async () => {
				execCalls += 1;
				return execCalls === 1
					? { stdout: "", stderr: "", code: 0, killed: false }
					: { stdout: "", stderr: "kill failed", code: 1, killed: false };
			},
		} as any);

		await assert.rejects(
			tools.get(fixture.tool).execute("call-1", { jobId, cwd: root, killWindow: true }, undefined, undefined, { cwd: root }),
			/soft cancellation remains pending/,
		);
		const status = JSON.parse(await readFile(join(jobDir, "status.json"), "utf8"));
		assert.equal(status.state, "running");
		assert.ok(status.cancelRequestedAt);
	});
}

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
