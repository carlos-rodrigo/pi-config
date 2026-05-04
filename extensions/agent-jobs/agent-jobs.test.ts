import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import agentJobsExtension, {
	buildRunScript,
	buildTmuxNewWindowArgs,
	collectReviewContext,
	createJobId,
	parseAgentEvents,
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

test("buildTmuxNewWindowArgs creates a detached window that keeps results inspectable", () => {
	const args = buildTmuxNewWindowArgs("pi-oracle-abcdef", "/tmp/repo", "/tmp/repo/.pi/agent-jobs/job/run.sh");

	assert.deepEqual(args.slice(0, 6), ["new-window", "-d", "-n", "pi-oracle-abcdef", "-c", "/tmp/repo"]);
	assert.match(args[6]!, /bash '\/tmp\/repo\/\.pi\/agent-jobs\/job\/run\.sh'/);
	assert.match(args[6]!, /Press Enter to close/);
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

	assert.deepEqual([...tools].sort(), ["agent_job_cancel", "agent_job_start", "agent_job_status"]);
	assert.deepEqual([...commands].sort(), ["agent-job-status", "ask-oracle-bg", "deep-review-bg", "research-bg"]);
});
