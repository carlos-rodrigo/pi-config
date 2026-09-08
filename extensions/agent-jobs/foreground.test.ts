import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import register from "./index.ts";
import { discoverAgents } from "./agents.ts";

async function fixture(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "foreground-agent-"));
	const bin = join(root, "bin");
	await mkdir(bin);
	await mkdir(join(root, ".pi/agents"), { recursive: true });
	await writeFile(join(root, ".pi/agents/fixture.md"), "---\nname: fixture\ndescription: fixture\ntools: [read, grep]\n---\nInspect only.");
	await writeFile(join(bin, "pi"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const prompt = fs.readFileSync(args.find(a => a.startsWith('@')).slice(1), 'utf8');
if (prompt.includes('stubborn')) process.on('SIGTERM', () => {});
console.log(JSON.stringify({type:'tool_execution_start'}));
setTimeout(() => {
 console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:prompt.includes('large') ? '界'.repeat(30000) : prompt}],stopReason:prompt.includes('fail') ? 'error' : 'end',errorMessage:prompt.includes('fail') ? 'fixture failure' : undefined}}));
}, prompt.includes('slow') ? 30000 : 100);
`, { mode: 0o700 });
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath}`;
	const tools = new Map<string, ToolDefinition>();
	const shutdown: Array<() => unknown> = [];
	const followUps: string[] = [];
	register({
		on(name: string, callback: () => unknown) { if (name === "session_shutdown") shutdown.push(callback); },
		registerCommand() {}, registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
		getAllTools: () => [{ name: "read" }, { name: "grep" }],
		sendUserMessage: (text: string) => followUps.push(text),
		events: { emit() {} },
		exec: async (command: string, args: string[]) => ({ code: 0, stdout: execFileSync(command, args, { encoding: "utf8" }), stderr: "", killed: false }),
	} as unknown as ExtensionAPI);
	t.after(async () => {
		for (const stop of shutdown) await stop();
		process.env.PATH = previousPath;
		await rm(root, { recursive: true, force: true });
	});
	const ctx = { cwd: root, isProjectTrusted: () => true, model: { provider: "parent", id: "model" }, thinkingLevel: "high" } as ExtensionContext;
	return { root, tools, ctx, followUps, shutdown };
}
const project = { agentScope: "project", confirmProjectAgents: false };

async function cancelJob(tools: Map<string, ToolDefinition>, ctx: ExtensionContext, jobId: string) {
	await tools.get("agent_job_cancel")!.execute("cleanup", { jobId }, undefined, undefined, ctx);
	const deadline = Date.now() + 3000;
	while (true) {
		const result = await tools.get("agent_job_status")!.execute("cleanup-status", { jobId }, undefined, undefined, ctx);
		if ((result.details as { state: string }).state !== "running") return;
		assert.ok(Date.now() < deadline, "fixture process exited after cancellation");
		await new Promise(resolve => setTimeout(resolve, 20));
	}
}

test("foreground returns durable single result, progress and inherited model without follow-up", async (t) => {
	const { tools, root, ctx, followUps } = await fixture(t);
	const tool = tools.get("subagent");
	assert.ok(tool, "subagent registered");
	const updates: unknown[] = [];
	const result = await tool.execute("single", { ...project, agent: "fixture", task: "inspect" }, undefined, (update) => updates.push(update), ctx);
	assert.match(JSON.stringify(result.content), /Task: inspect/);
	assert.ok(updates.length > 0);
	assert.equal(result.terminate, undefined);
	assert.deepEqual(followUps, []);
	const [job] = await readdir(join(root, ".pi/agent-jobs"));
	const dir = join(root, ".pi/agent-jobs", job!);
	const status = JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
	assert.equal(status.state, "completed");
	assert.equal(status.followUp, false);
	assert.match(await readFile(join(dir, "run.sh"), "utf8"), /'--model' 'parent\/model' '--thinking' 'high'/);
	assert.match(await readFile(join(dir, "result.md"), "utf8"), /inspect/);
});

test("foreground validates modes and aggregates parallel success and failure with bounded output", async (t) => {
	const { tools, ctx } = await fixture(t);
	const tool = tools.get("subagent")!;
	assert.ok(tool);
	for (const params of [{}, { agent: "fixture" }, { tasks: [] }, { agent: "fixture", task: "x", tasks: [{ agent: "fixture", task: "x" }] }, { tasks: Array(9).fill({ agent: "fixture", task: "x" }) }]) {
		await assert.rejects(tool.execute("invalid", { ...project, ...params }, undefined, undefined, ctx), /mode|task|maximum|eight|8/i);
	}
	const assertBounded = (result: { details?: unknown }) => {
		for (const item of (result.details as { results: Array<{ output?: string }> }).results) {
			assert.ok(Buffer.byteLength(item.output ?? "") <= 5000, "details output is bounded too");
		}
	};
	const result = await tool.execute("parallel", { ...project, tasks: [{ agent: "fixture", task: "large" }, { agent: "fixture", task: "fail" }] }, undefined, assertBounded, ctx);
	assertBounded(result);
	const text = result.content.map(part => part.type === "text" ? part.text : "").join("");
	assert.match(text, /completed/);
	assert.match(text, /failed/);
	assert.match(text, /fixture failure/);
	assert.ok(Buffer.byteLength(text) < 50 * 1024);
	await assert.rejects(tool.execute("failure", { ...project, agent: "fixture", task: "fail" }, undefined, undefined, ctx), /fixture failure/);
});

test("foreground abort cancels owned job and does not launch queued work", async (t) => {
	const { tools, root, ctx, followUps } = await fixture(t);
	const tool = tools.get("subagent")!;
	assert.ok(tool);
	const controller = new AbortController();
	await assert.rejects(tool.execute("aborted", { ...project, agent: "fixture", task: "slow" }, AbortSignal.abort(), undefined, ctx), /abort/i);
	const operation = tool.execute("cancel", { ...project, tasks: Array(8).fill({ agent: "fixture", task: "slow" }) }, controller.signal, () => controller.abort(), ctx);
	await assert.rejects(operation, /abort/i);
	const jobs = await readdir(join(root, ".pi/agent-jobs"));
	assert.ok(jobs.length <= 4);
	for (const job of jobs) {
		const status = JSON.parse(await readFile(join(root, ".pi/agent-jobs", job, "status.json"), "utf8"));
		assert.equal(status.state, "cancelled");
		assert.equal(typeof status.exitCode, "number");
		assert.ok(await readFile(status.resultPath, "utf8"));
		assert.ok(status.usage);
	}
	assert.deepEqual(followUps, []);
});

test("foreground forced cancellation preserves an inspectable durable result", async (t) => {
	const { tools, ctx, root } = await fixture(t);
	const controller = new AbortController();
	const result = tools.get("subagent")!.execute("stubborn", { ...project, agent: "fixture", task: "slow stubborn" }, controller.signal,
		update => { if (JSON.stringify(update.content).includes("1 tool calls")) controller.abort(); }, ctx);
	await assert.rejects(result, /abort/i);
	const [job] = await readdir(join(root, ".pi/agent-jobs"));
	const status = JSON.parse(await readFile(join(root, ".pi/agent-jobs", job!, "status.json"), "utf8"));
	assert.equal(status.state, "cancelled");
	assert.equal(status.updatedAt, status.completedAt);
	assert.match(await readFile(status.resultPath, "utf8"), /cancelled/i);
});

test("foreground respects batch concurrency and preserves input result order", async (t) => {
	const { tools, ctx } = await fixture(t);
	let peak = 0;
	let sawQueued = false;
	const result = await tools.get("subagent")!.execute("batch", { ...project,
		tasks: Array.from({ length: 8 }, (_, i) => ({ agent: "fixture", task: `item-${i}` })),
	}, undefined, (update) => {
		const details = update.details as { results: Array<{ state: string }> };
		peak = Math.max(peak, details.results.filter(result => result.state === "running").length);
		sawQueued ||= details.results.some(result => result.state === "queued");
	}, ctx);
	assert.equal(peak, 4);
	assert.ok(sawQueued);
	const details = result.details as { results: Array<{ output: string }> };
	assert.deepEqual(details.results.map(result => result.output.trim()), Array.from({ length: 8 }, (_, i) => `Task: item-${i}`));
});

test("background tool also inherits the parent model and thinking level", async (t) => {
	const { tools, ctx } = await fixture(t);
	const result = await tools.get("agent_job_start")!.execute("background", { ...project, agent: "fixture", task: "slow", followUp: false }, undefined, undefined, ctx);
	const job = result.details as { jobId: string; runScriptPath: string };
	try {
		assert.match(await readFile(job.runScriptPath, "utf8"), /'--model' 'parent\/model' '--thinking' 'high'/);
	} finally {
		await cancelJob(tools, ctx, job.jobId);
	}
});

test("shutdown cancels foreground but leaves detached background work independent", async (t) => {
	const { tools, ctx, shutdown, root } = await fixture(t);
	await writeFile(join(root, ".pi/agents/pinned.md"), "---\nname: pinned\ndescription: pinned\nmodel: chosen/model\n---\nInspect only.");
	const background = await tools.get("agent_job_start")!.execute("bg", { ...project, agent: "pinned", task: "slow", followUp: false }, undefined, undefined, ctx);
	const job = background.details as { jobId: string; runScriptPath: string };
	const script = await readFile(job.runScriptPath, "utf8");
	assert.match(script, /'--model' 'chosen\/model'/);
	assert.doesNotMatch(script, /--thinking/);
	let started!: () => void;
	const ready = new Promise<void>(resolve => { started = resolve; });
	const foreground = tools.get("subagent")!.execute("fg", { ...project, agent: "fixture", task: "slow" }, undefined, () => started(), ctx);
	const rejected = assert.rejects(foreground, /abort/i);
	await ready;
	for (const stop of shutdown) await stop();
	await rejected;
	const status = await tools.get("agent_job_status")!.execute("status", { jobId: job.jobId }, undefined, undefined, ctx);
	assert.equal((status.details as { state: string }).state, "running");
	await cancelJob(tools, ctx, job.jobId);
});

test("shutdown aborts a pending project-agent confirmation without launching a child", async (t) => {
	const { tools, ctx, shutdown, root } = await fixture(t);
	let opened!: () => void;
	const ready = new Promise<void>(resolve => { opened = resolve; });
	const ui = { confirm: async (_title: string, _message: string, options?: { signal?: AbortSignal }) => {
		assert.ok(options?.signal);
		opened();
		return new Promise<boolean>(resolve => options.signal!.addEventListener("abort", () => resolve(false), { once: true }));
	} };
	const operation = tools.get("subagent")!.execute("confirm", { ...project, confirmProjectAgents: true, agent: "fixture", task: "x" }, undefined, undefined,
		{ ...ctx, hasUI: true, ui } as ExtensionContext);
	const rejected = assert.rejects(operation, /abort/i);
	await ready;
	for (const stop of shutdown) await stop();
	await rejected;
	assert.deepEqual(await readdir(join(root, ".pi/agent-jobs")).catch(() => []), []);
});

test("foreground preserves trust and headless project confirmation gates", async (t) => {
	const { tools, ctx } = await fixture(t);
	const tool = tools.get("subagent")!;
	await assert.rejects(tool.execute("trust", { ...project, agent: "fixture", task: "x" }, undefined, undefined,
		{ ...ctx, isProjectTrusted: () => false }), /trusted/i);
	await assert.rejects(tool.execute("confirm", { ...project, confirmProjectAgents: true, agent: "fixture", task: "x" }, undefined, undefined, ctx), /confirmation requires/i);
});

test("discovery accepts YAML arrays and skips incorrectly typed fields", async (t) => {
	const { root } = await fixture(t);
	await writeFile(join(root, ".pi/agents/bad.md"), "---\nname: 42\ndescription: [bad]\ntools: 12\n---\nbad");
	await writeFile(join(root, ".pi/agents/malformed.md"), "---\nname: [\n---\nbad");
	const agents = discoverAgents(root, "project").agents;
	assert.equal(agents.length, 1);
	assert.deepEqual(agents[0]?.tools, ["read", "grep"]);
});
