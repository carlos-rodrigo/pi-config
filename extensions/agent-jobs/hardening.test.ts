import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { promises as mutableFs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { withJobLock } from "./lifecycle-lock.ts";
import { AgentSession, InteractiveMode, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import register, { buildRunScript, buildLoopRunScript, shellQuote, launchDetachedRunScript } from "./index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
async function fixture(t: test.TestContext) {
	const root = await fs.mkdtemp(join(tmpdir(), "job-hardening-"));
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	const handlers = new Map<string, Handler[]>();
	const sent: string[] = [];
	let queued = false;
	let idle = true;
	const api = {
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); }, registerCommand(name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) { commands.set(name, command); }, getThinkingLevel: () => "off",
		sendUserMessage(text: string) { sent.push(text); queued = true; },
		exec: async (command: string, args: string[]) => {
			try { return { code: 0, stdout: execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "", killed: false }; }
			catch (error) { const e = error as { status?: number; stdout?: string; stderr?: string }; return { code: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? ""), killed: false }; }
		}, events: { emit() {} },
	};
	register(api as unknown as ExtensionAPI);
	const ctx = { cwd: root, isProjectTrusted: () => true, isIdle: () => idle, hasPendingMessages: () => queued } as unknown as ExtensionContext;
	async function emit(name: string, event: unknown = {}, context = ctx) { for (const handler of handlers.get(name) ?? []) await handler(event, context); }
	t.after(async () => { await emit("session_shutdown"); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
	async function seed(kind: "agent" | "loop", id: string, extra: Record<string, unknown> = {}) {
		const jobDir = join(root, ".pi", `${kind}-jobs`, id);
		await fs.mkdir(jobDir, { recursive: true });
		const resultPath = join(jobDir, "result.md");
		await fs.writeFile(resultPath, `Result ${id}`);
		const status = { jobId: id, jobDir, cwd: root, feature: "fixture", agent: "fixture", mode: "standard", createdAt: new Date().toISOString(), state: "completed", resultPath, followUp: true, followUpSent: false, ...extra };
		await fs.writeFile(join(jobDir, "status.json"), JSON.stringify(status));
		return status;
	}
	async function reload() {
		await emit("session_shutdown");
		handlers.clear();
		const fresh = await import(`${new URL("./index.ts", import.meta.url).href}?reload=${Math.random()}`);
		fresh.default(api as unknown as ExtensionAPI);
		await emit("session_start");
	}
	return { root, tools, commands, ctx, api, emit, seed, sent, reload, setQueued(value: boolean) { queued = value; }, setIdle(value: boolean) { idle = value; } };
}
async function waitFor(condition: () => boolean | Promise<boolean>) {
	const end = Date.now() + 2000;
	while (!await condition()) { assert.ok(Date.now() < end, "condition settled"); await new Promise(r => setTimeout(r, 10)); }
}

async function resistantJob(t: test.TestContext, f: Awaited<ReturnType<typeof fixture>>, kind: "agent" | "loop", id: string) {
	const status = await f.seed(kind, id, { state: "running", followUp: false });
	const descendantFile = join(status.jobDir, "descendant.pid");
	const descendantCode = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(descendantFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
	const program = join(status.jobDir, "child.cjs");
	await fs.writeFile(program, `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], {stdio:'ignore'}); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);`);
	const script = join(status.jobDir, "run.sh");
	const exitPath = join(status.jobDir, "exit.json");
	const pidPath = join(status.jobDir, "pid");
	await fs.writeFile(script, buildLoopRunScript({ cwd: f.root, jobId: id, command: [process.execPath, program], stdoutPath: join(status.jobDir, kind === "agent" ? "events.jsonl" : "stdout.log"), stderrPath: join(status.jobDir, "stderr.log"), resultPath: status.resultPath, exitPath, pidPath }));
	const pid = await launchDetachedRunScript(f.root, script, pidPath);
	t.after(() => { try { process.kill(-pid, "SIGKILL"); } catch {} });
	await waitFor(async () => !!await fs.readFile(descendantFile, "utf8").catch(() => ""));
	const descendant = Number(await fs.readFile(descendantFile, "utf8"));
	t.after(() => { try { process.kill(descendant, "SIGKILL"); } catch {} });
	await fs.writeFile(join(status.jobDir, "status.json"), JSON.stringify({ ...status, processId: pid }));
	return { ...status, pid, descendant, exitPath };
}

test("untrusted startup and all loop tools fail closed without outside-file reads", async t => {
	const f = await fixture(t);
	const outside = join(f.root, "outside.txt");
	await fs.writeFile(outside, "OUTSIDE_SENTINEL");
	await f.seed("loop", "valid-completed");
	await f.seed("loop", "valid-running", { state: "running" });
	await f.seed("loop", "hostile", { resultPath: outside });
	const ctx = { ...f.ctx, isProjectTrusted: () => false };
	await f.emit("session_start", {}, ctx);
	assert.deepEqual(f.sent, []);
	for (const name of ["loop_job_start", "loop_job_status", "loop_job_cancel"]) {
		await assert.rejects(f.tools.get(name)!.execute("call", { jobId: "hostile", feature: "fixture" }, undefined, undefined, ctx), /trusted Pi session/);
	}
	assert.equal(await fs.readFile(outside, "utf8"), "OUTSIDE_SENTINEL");
});

test("trusted loop reads reject escaped metadata, symlinks and traversal without overwriting files", async t => {
	const f = await fixture(t);
	const outside = join(f.root, "outside.txt");
	await fs.writeFile(outside, "UNCHANGED");
	for (const [field, value] of [["resultPath", outside], ["stdoutPath", outside], ["loopLogPath", outside], ["jobDir", f.root], ["feature", "../escape"]] as const) {
		const status = await f.seed("loop", "hostile", { [field]: value, state: "running" });
		await fs.writeFile(join(status.jobDir === f.root ? join(f.root, ".pi/loop-jobs/hostile") : status.jobDir, "exit.json"), JSON.stringify({ exitCode: 0, finishedAt: new Date().toISOString() }));
		await assert.rejects(f.tools.get("loop_job_status")!.execute("call", { jobId: "hostile" }, undefined, undefined, f.ctx), /Invalid loop/);
		assert.equal(await fs.readFile(outside, "utf8"), "UNCHANGED");
	}
	const safe = await f.seed("loop", "hostile");
	await fs.rm(safe.resultPath);
	await fs.symlink(outside, safe.resultPath);
	await assert.rejects(f.tools.get("loop_job_status")!.execute("call", { jobId: "hostile" }, undefined, undefined, f.ctx), /symlink/);
	await assert.rejects(f.tools.get("loop_job_status")!.execute("call", { jobId: "../outside" }, undefined, undefined, f.ctx), /Invalid.*id/i);
});

test("loop feature artifacts are permitted but symlinked feature directories are rejected", async t => {
	const f = await fixture(t);
	const artifacts = join(f.root, ".features/fixture/artifacts/loop");
	await fs.mkdir(artifacts, { recursive: true });
	const status = await f.seed("loop", "valid", { state: "running", loopSummaryPath: join(artifacts, "latest-iteration.md") });
	await fs.writeFile(join(artifacts, "latest-iteration.md"), "Legitimate feature result");
	await fs.writeFile(join(status.jobDir, "exit.json"), JSON.stringify({ exitCode: 0, finishedAt: new Date().toISOString() }));
	const result = await f.tools.get("loop_job_status")!.execute("call", { jobId: "valid" }, undefined, undefined, f.ctx);
	assert.match(JSON.stringify(result), /Legitimate feature result/);
	await fs.rename(join(f.root, ".features/fixture"), join(f.root, "feature-outside"));
	await fs.symlink(join(f.root, "feature-outside"), join(f.root, ".features/fixture"));
	await assert.rejects(f.tools.get("loop_job_status")!.execute("call", { jobId: "valid" }, undefined, undefined, f.ctx), /symlink/);
});

test("both script builders treat metacharacters in names and paths literally", async t => {
	const f = await fixture(t);
	const dir = join(f.root, "literal $UNSET `printf bad` \" quote");
	await fs.mkdir(dir);
	const bin = join(f.root, "bin");
	await fs.mkdir(bin);
	await fs.writeFile(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	const marker = join(f.root, "marker");
	const name = `fixture $(printf BAD > ${shellQuote(marker)})`;
	const paths = { cwd: dir, jobId: name, stderrPath: join(dir, "stderr.log"), resultPath: join(dir, "result.md"), exitPath: join(dir, "exit.json"), pidPath: join(dir, "pid") };
	const scripts = [buildRunScript({ ...paths, agent: { name, description: "fixture", systemPrompt: "", source: "user", filePath: "fixture" }, promptPath: join(dir, "prompt.md"), eventLogPath: join(dir, "events.jsonl") }), buildLoopRunScript({ ...paths, command: ["bash", "-c", "printf loop-fixture"], stdoutPath: join(dir, "stdout.log") })];
	for (const script of scripts) {
		const path = join(dir, "run.sh");
		await fs.writeFile(path, script);
		const output = execFileSync("bash", [path], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
		assert.match(output, /literal \$UNSET/);
		assert.equal(JSON.parse(await fs.readFile(paths.exitPath, "utf8")).exitCode, 0);
		await assert.rejects(fs.readFile(marker), /ENOENT/);
	}
});

test("dequeued completion releases the gate only when idle and empty, retains its ack, and accepts appended text", async t => {
	const f = await fixture(t);
	await f.seed("agent", "first");
	await f.emit("session_start");
	await waitFor(() => f.sent.length === 1);
	const originalNow = Date.now;
	t.mock.method(Date, "now", () => originalNow() + 6000);
	await f.seed("loop", "second");
	await f.emit("session_start");
	await new Promise(r => setTimeout(r, 30));
	assert.equal(f.sent.length, 1, "queued first message must not be duplicated or bypassed");
	let editor = "additional instructions";
	const restore = (InteractiveMode.prototype as unknown as { restoreQueuedMessagesToEditor(this: object): number }).restoreQueuedMessagesToEditor;
	assert.equal(restore.call({
		clearAllQueues() { f.setQueued(false); return { steering: [], followUp: [f.sent[0]] }; },
		editor: { getText: () => editor, setText: (value: string) => { editor = value; } },
		updatePendingMessagesDisplay() {},
	}), 1);
	assert.match(editor, /additional instructions/);
	editor = ""; // The user discards editor-owned text; this is not a receipt.
	f.setIdle(false);
	await f.emit("agent_end");
	await new Promise(r => setTimeout(r, 30));
	assert.equal(f.sent.length, 1, "busy agent keeps serialization");
	f.setIdle(true);
	await f.emit("agent_end");
	await waitFor(() => f.sent.length === 2);
	assert.match(f.sent[1]!, /second/);
	await f.emit("message_start", { message: { role: "user", content: `${f.sent[0]}\nAdditional user instruction.` } });
	const status = JSON.parse(await fs.readFile(join(f.root, ".pi/agent-jobs/first/status.json"), "utf8"));
	assert.equal(status.followUpSent, true);
});

test("dead verified jobs reconcile but mismatched or unavailable inspection preserves uncertainty", async t => {
	const f = await fixture(t);
	const realExec = f.api.exec;
	for (const kind of ["agent", "loop"] as const) {
		const status = await f.seed(kind, "dead", { state: "running", processId: 123456789, followUp: false });
		await fs.writeFile(join(status.jobDir, "pid"), "123456789");
		f.api.exec = async (_command, args) => ({ code: args[0] === "-axo" ? 0 : 1, stdout: "", stderr: "", killed: false });
		const result = await f.tools.get(`${kind}_job_status`)!.execute("call", { jobId: "dead" }, undefined, undefined, f.ctx);
		assert.equal((result.details as { state: string }).state, "failed");
		assert.match(JSON.stringify(result), /without an exit marker/);
		await f.seed(kind, "dead", { state: "running", processId: 123456789, followUp: false });
		f.api.exec = async () => ({ code: 2, stdout: "", stderr: "ps unavailable", killed: false });
		const uncertain = await f.tools.get(`${kind}_job_status`)!.execute("call", { jobId: "dead" }, undefined, undefined, f.ctx);
		assert.equal((uncertain.details as { state: string }).state, "running");
		await fs.writeFile(join(status.jobDir, "pid"), "999");
		f.api.exec = async () => ({ code: 1, stdout: "", stderr: "", killed: false });
		await assert.rejects(f.tools.get(`${kind}_job_cancel`)!.execute("call", { jobId: "dead" }, undefined, undefined, f.ctx), /PID file/);
	}
	f.api.exec = realExec;
});

test("completion appearing during the cancellation probe is finalized rather than relabelled", async t => {
	const f = await fixture(t);
	for (const kind of ["agent", "loop"] as const) {
		const status = await f.seed(kind, "race", { state: "running", processId: 123456789, followUp: false });
		const script = join(status.jobDir, "run.sh");
		await fs.writeFile(script, "fixture");
		await fs.writeFile(join(status.jobDir, "pid"), "123456789");
		let probes = 0;
		f.api.exec = async () => {
			if (++probes === 1) return { code: 0, stdout: `123456789 123456789 bash ${script}`, stderr: "", killed: false };
			await fs.writeFile(join(status.jobDir, "exit.json"), JSON.stringify({ exitCode: 0, finishedAt: new Date().toISOString() }));
			return { code: 1, stdout: "", stderr: "", killed: false };
		};
		const result = await f.tools.get(`${kind}_job_cancel`)!.execute("call", { jobId: "race" }, undefined, undefined, f.ctx);
		assert.equal((result.details as { state: string }).state, "completed");
		assert.equal(probes, 2, "the marker appears after initial finalization, during the cancellation identity probe");
	}
});

test("a post-spawn persistence failure cleans up both agent and loop process groups", async t => {
	const f = await fixture(t);
	const bin = join(f.root, "bin");
	await fs.mkdir(bin);
	const descendantFile = join(f.root, "descendant.pid");
	const descendantCode = `require('node:fs').writeFileSync(${JSON.stringify(descendantFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
	await fs.writeFile(join(bin, "pi"), `#!/usr/bin/env node\nrequire('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], {stdio:'ignore'}); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
	await fs.mkdir(join(f.root, ".pi/agents"), { recursive: true });
	await fs.writeFile(join(f.root, ".pi/agents/fixture.md"), "---\nname: fixture\ndescription: fixture\ntools: [read]\n---\nInspect only.");
	await fs.mkdir(join(f.root, ".features/fixture/tasks"), { recursive: true });
	await fs.writeFile(join(f.root, ".features/fixture/tasks/001.md"), "---\nid: TASK-001\nstatus: ready\n---\n# Task");
	const loopScriptPath = join(f.root, "loop.sh");
	await fs.writeFile(loopScriptPath, `#!/bin/sh\nexec ${shellQuote(join(bin, "pi"))}\n`);
	const oldPath = process.env.PATH;
	process.env.PATH = `${bin}:${oldPath}`;
	t.after(() => { process.env.PATH = oldPath; });
	const rename = mutableFs.rename;
	let failedPid: number | undefined;
	let descendantPid: number | undefined;
	let failNext = true;
	t.mock.method(mutableFs, "rename", async (from: string, to: string) => {
		if (failNext && to.endsWith("status.json")) {
			const status = JSON.parse(await fs.readFile(from, "utf8"));
			if (status.processId) {
				failedPid = status.processId;
				const group = failedPid;
				t.after(() => { try { process.kill(-group, "SIGKILL"); } catch {} });
				await waitFor(async () => !!await fs.readFile(descendantFile, "utf8").catch(() => ""));
				descendantPid = Number(await fs.readFile(descendantFile, "utf8"));
				const descendant = descendantPid;
				t.after(() => { try { process.kill(descendant, "SIGKILL"); } catch {} });
				failNext = false;
				throw new Error("injected persistence failure");
			}
		}
		return rename(from, to);
	});
	for (const kind of ["agent", "loop"] as const) {
		failNext = true;
		failedPid = undefined;
		descendantPid = undefined;
		await fs.rm(descendantFile, { force: true });
		const params = kind === "agent" ? { agent: "fixture", task: "slow", agentScope: "project", confirmProjectAgents: false, followUp: false } : { feature: "fixture", loopScriptPath, followUp: false };
		await assert.rejects(f.tools.get(`${kind}_job_start`)!.execute("start", params, undefined, undefined, f.ctx), /injected persistence failure/);
		assert.ok(failedPid);
		const pid = failedPid;
		assert.ok(descendantPid);
		for (const stopped of [pid, descendantPid]) {
			await waitFor(() => {
				try { return execFileSync("ps", ["-p", String(stopped), "-o", "stat="], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().startsWith("Z"); }
				catch { return true; }
			});
		}
		const dirs = await fs.readdir(join(f.root, ".pi", `${kind}-jobs`));
		const status = JSON.parse(await fs.readFile(join(f.root, ".pi", `${kind}-jobs`, dirs[0]!, "status.json"), "utf8"));
		assert.equal(status.state, "failed");
		assert.equal(status.processId, pid);
	}
});

test("loop launch tools and commands reject pre-existing symlinked artifact files before spawning", async t => {
	const f = await fixture(t);
	const artifacts = join(f.root, ".features/fixture/artifacts/loop");
	await fs.mkdir(artifacts, { recursive: true });
	await fs.mkdir(join(f.root, ".features/fixture/tasks"));
	const marker = join(f.root, "started");
	const script = join(f.root, "loop.sh");
	await fs.writeFile(script, `printf started > ${shellQuote(marker)}\n`);
	const outside = join(f.root, "outside.txt");
	await fs.writeFile(outside, "UNCHANGED");
	for (const file of ["loop.log", "latest-iteration.md", "progress.txt"]) {
		const artifact = join(artifacts, file);
		await fs.symlink(outside, artifact);
		await assert.rejects(f.tools.get("loop_job_start")!.execute("call", { feature: "fixture", loopScriptPath: script }, undefined, undefined, f.ctx), /symlink/);
		const notices: string[] = [];
		const command = f.commands.get("loop-bg")!;
		await command.handler(`--feature fixture --loop-script ${shellQuote(script)}`, { ...f.ctx, ui: { notify(text: string) { notices.push(text); } } } as unknown as Parameters<typeof command.handler>[1]);
		assert.match(notices.join("\n"), /symlink/);
		assert.equal(await fs.readFile(outside, "utf8"), "UNCHANGED");
		await assert.rejects(fs.readFile(marker), /ENOENT/);
		await fs.rm(artifact);
	}
});

test("combined editor completions acknowledge every authentic marker and are not redelivered after restart", async t => {
	const f = await fixture(t);
	await f.seed("agent", "first");
	await f.emit("session_start");
	await waitFor(() => f.sent.length === 1);
	const now = Date.now;
	t.mock.method(Date, "now", () => now() + 6000);
	f.setQueued(false);
	await f.seed("loop", "second");
	await f.emit("session_start");
	await waitFor(() => f.sent.length === 2);
	await f.emit("message_start", { message: { role: "user", content: `<!-- pi-agent-jobs-follow-up:agent:first:${"a".repeat(32)} -->` } });
	assert.equal(JSON.parse(await fs.readFile(join(f.root, ".pi/agent-jobs/first/status.json"), "utf8")).followUpSent, false, "unrelated comments cannot acknowledge a queued completion");
	await f.emit("message_start", { message: { role: "user", content: f.sent.join("\n\n") + "\nAdditional instructions." } });
	for (const kind of ["agent", "loop"] as const) {
		const id = kind === "agent" ? "first" : "second";
		assert.equal(JSON.parse(await fs.readFile(join(f.root, ".pi", `${kind}-jobs`, id, "status.json"), "utf8")).followUpSent, true);
	}
	await f.emit("session_shutdown");
	f.setQueued(false);
	await f.emit("session_start");
	await new Promise(r => setTimeout(r, 30));
	assert.equal(f.sent.length, 2);
});

test("untrusted commands and cross-project loop targets fail closed", async t => {
	const f = await fixture(t);
	await f.seed("loop", "valid");
	const notices: string[] = [];
	const command = f.commands.get("loop-job-status")!;
	const context = { ...f.ctx, isProjectTrusted: () => false, ui: { notify(text: string) { notices.push(text); } } } as unknown as Parameters<typeof command.handler>[1];
	for (const args of ["", "valid"]) await command.handler(args, context);
	assert.equal(notices.length, 2);
	assert.ok(notices.every(message => message.includes("trusted Pi session")));
	const target = join(f.root, "other-project");
	await fs.mkdir(target);
	for (const name of ["loop_job_start", "loop_job_status", "loop_job_cancel"]) {
		await assert.rejects(f.tools.get(name)!.execute("call", { cwd: target, jobId: "valid", feature: "fixture" }, undefined, undefined, f.ctx), /not trusted/);
	}
});

test("PID-file fallback retains cancellation ownership after interrupted PID persistence", async t => {
	const f = await fixture(t);
	for (const kind of ["agent", "loop"] as const) {
		const status = await f.seed(kind, "fallback", { state: "running", followUp: false });
		const script = join(status.jobDir, "run.sh");
		const pidPath = join(status.jobDir, "pid");
		await fs.writeFile(script, buildLoopRunScript({ cwd: f.root, jobId: "fallback", command: ["bash", "-c", "trap 'exit 130' TERM INT; while :; do sleep 1; done"], stdoutPath: join(status.jobDir, kind === "agent" ? "events.jsonl" : "stdout.log"), stderrPath: join(status.jobDir, "stderr.log"), resultPath: status.resultPath, exitPath: join(status.jobDir, "exit.json"), pidPath }));
		const pid = await launchDetachedRunScript(f.root, script, pidPath);
		t.after(() => { try { process.kill(-pid, "SIGKILL"); } catch {} });
		const result = await f.tools.get(`${kind}_job_cancel`)!.execute("call", { jobId: "fallback" }, undefined, undefined, f.ctx);
		assert.ok((result.details as { cancelRequestedAt?: string }).cancelRequestedAt);
		await waitFor(async () => !!await fs.readFile(join(status.jobDir, "exit.json"), "utf8").catch(() => ""));
	}
});

test("watcher and cancellation transitions serialize instead of overwriting cancellation state", async t => {
	const f = await fixture(t);
	const status = await f.seed("agent", "concurrent", { state: "running", followUp: false });
	const script = join(status.jobDir, "run.sh");
	const pidPath = join(status.jobDir, "pid");
	await fs.writeFile(script, buildLoopRunScript({ cwd: f.root, jobId: "concurrent", command: ["bash", "-c", "trap 'exit 130' TERM INT; while :; do sleep 1; done"], stdoutPath: join(status.jobDir, "events.jsonl"), stderrPath: join(status.jobDir, "stderr.log"), resultPath: status.resultPath, exitPath: join(status.jobDir, "exit.json"), pidPath }));
	const pid = await launchDetachedRunScript(f.root, script, pidPath);
	t.after(() => { try { process.kill(-pid, "SIGKILL"); } catch {} });
	await fs.writeFile(join(status.jobDir, "status.json"), JSON.stringify({ ...status, processId: pid }));
	const exec = f.api.exec;
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	let paused = false;
	f.api.exec = async (command, args) => {
		if (!paused && args[0] === "-p") { paused = true; await gate; }
		return exec(command, args);
	};
	await f.emit("session_start");
	await waitFor(() => paused);
	let finished = false;
	const cancellation = f.tools.get("agent_job_cancel")!.execute("call", { jobId: "concurrent" }, undefined, undefined, f.ctx).then(result => { finished = true; return result; });
	cancellation.catch(() => {});
	try {
		await new Promise(r => setTimeout(r, 30));
		assert.equal(finished, false, "cancellation cannot write through the watcher's transition");
	} finally { release(); }
	await cancellation;
	await waitFor(async () => !!await fs.readFile(join(status.jobDir, "exit.json"), "utf8").catch(() => ""));
	const final = await f.tools.get("agent_job_status")!.execute("call", { jobId: "concurrent" }, undefined, undefined, f.ctx);
	assert.equal((final.details as { state: string }).state, "cancelled");
	assert.ok((final.details as { cancelRequestedAt?: string }).cancelRequestedAt);
});

test("lifecycle file ordering serializes independent processes and ignores dead owners without deleting their files", async t => {
	const root = await fs.mkdtemp(join(tmpdir(), "lifecycle-order-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const counter = join(root, "counter");
	await fs.writeFile(counter, "0");
	const module = pathToFileURL(resolve("extensions/agent-jobs/lifecycle-lock.ts")).href;
	const code = `import {withJobLock} from ${JSON.stringify(module)}; import * as fs from 'node:fs/promises'; for(let i=0;i<6;i++) await withJobLock(${JSON.stringify(root)}, async()=>{const n=Number(await fs.readFile(${JSON.stringify(counter)},'utf8')); await new Promise(r=>setTimeout(r,10)); await fs.writeFile(${JSON.stringify(counter)},String(n+1));});`;
	await Promise.all(Array.from({ length: 3 }, () => new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
		t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
		let errors = "";
		child.stderr.on("data", data => { errors += String(data); });
		child.on("error", reject);
		child.on("close", exit => exit === 0 ? resolve() : reject(new Error(errors)));
	})));
	assert.equal(await fs.readFile(counter, "utf8"), "18");
	const directory = join(root, ".lifecycle");
	assert.deepEqual(await fs.readdir(directory), []);
	const stale = join(directory, `123456789-${"a".repeat(32)}.json`);
	await fs.writeFile(stale, JSON.stringify({ pid: 123456789, ticket: 1, choosing: false }));
	await assert.rejects(withJobLock(root, async () => { throw new Error("action failed"); }), /action failed/);
	await withJobLock(root, async () => {});
	assert.deepEqual(await fs.readdir(directory), [stale.split("/").at(-1)]);
});

test("a missing supervisor with live descendants remains uncertain and cannot be falsely cancelled", async t => {
	const f = await fixture(t);
	const status = await f.seed("agent", "survivors", { state: "running", processId: 123456789, followUp: false });
	await fs.writeFile(join(status.jobDir, "pid"), "123456789");
	f.api.exec = async (_command, args) => ({ code: args[0] === "-axo" ? 0 : 1, stdout: args[0] === "-axo" ? "67890 123456789 S known-start" : "", stderr: "", killed: false });
	const result = await f.tools.get("agent_job_status")!.execute("call", { jobId: "survivors" }, undefined, undefined, f.ctx);
	assert.equal((result.details as { state: string }).state, "running");
	await assert.rejects(f.tools.get("agent_job_cancel")!.execute("call", { jobId: "survivors" }, undefined, undefined, f.ctx), /process-group exit is unverified/);
	assert.equal(JSON.parse(await fs.readFile(join(status.jobDir, "status.json"), "utf8")).state, "running");
});

test("matching PID files do not grant cancellation of a wrong group or run script", async t => {
	const f = await fixture(t);
	for (const kind of ["agent", "loop"] as const) {
		const status = await f.seed(kind, "identity", { state: "running", processId: 123456789, followUp: false });
		const script = join(status.jobDir, "run.sh");
		const other = join(f.root, "other.sh");
		await fs.writeFile(script, "fixture");
		await fs.writeFile(other, "not this job");
		await fs.writeFile(join(status.jobDir, "pid"), "123456789");
		for (const output of [`123456789 111 bash ${script}`, `123456789 123456789 bash ${other}`]) {
			f.api.exec = async () => ({ code: 0, stdout: output, stderr: "", killed: false });
			await assert.rejects(f.tools.get(`${kind}_job_cancel`)!.execute("call", { jobId: "identity" }, undefined, undefined, f.ctx), /identity/);
		}
	}
});

test("failed cleanup inspection preserves the live PID and an uncertain running record", async t => {
	const f = await fixture(t);
	const bin = join(f.root, "bin");
	await fs.mkdir(bin);
	await fs.writeFile(join(bin, "pi"), "#!/bin/sh\nsleep 30\n", { mode: 0o700 });
	await fs.mkdir(join(f.root, ".pi/agents"), { recursive: true });
	await fs.writeFile(join(f.root, ".pi/agents/fixture.md"), "---\nname: fixture\ndescription: fixture\ntools: [read]\n---\nInspect only.");
	const oldPath = process.env.PATH;
	process.env.PATH = `${bin}:${oldPath}`;
	t.after(() => { process.env.PATH = oldPath; });
	const rename = mutableFs.rename;
	let captured = false;
	t.mock.method(mutableFs, "rename", async (from: string, to: string) => {
		if (!captured && to.endsWith("status.json")) {
			const status = JSON.parse(await fs.readFile(from, "utf8"));
			if (status.processId) {
				captured = true;
				const pid = status.processId;
				t.after(() => { try { process.kill(-pid, "SIGKILL"); } catch {} });
				throw new Error("persistence unavailable");
			}
		}
		return rename(from, to);
	});
	f.api.exec = async () => { throw new Error("inspection unavailable"); };
	await assert.rejects(f.tools.get("agent_job_start")!.execute("call", { agent: "fixture", task: "slow", agentScope: "project", confirmProjectAgents: false, followUp: false }, undefined, undefined, f.ctx), /cleanup could not be verified/);
	const [job] = await fs.readdir(join(f.root, ".pi/agent-jobs"));
	const status = JSON.parse(await fs.readFile(join(f.root, ".pi/agent-jobs", job!, "status.json"), "utf8"));
	assert.equal(status.state, "running");
	assert.ok(status.processId);
	assert.match(status.errorMessage, /inspection unavailable/);
});

test("deferred completion dispatch waits for acknowledgement without duplicating the message", async t => {
	const f = await fixture(t);
	const dispatch: string[] = [];
	f.api.sendUserMessage = text => { dispatch.push(text); };
	await f.seed("agent", "first");
	await f.seed("loop", "second");
	await f.emit("session_start");
	await waitFor(() => dispatch.length === 1);
	await f.emit("agent_end");
	await new Promise(r => setTimeout(r, 30));
	assert.equal(dispatch.length, 1);
	await f.emit("message_start", { message: { role: "user", content: dispatch[0] } });
	await waitFor(() => dispatch.length === 2);
});

test("forced cancellation retries an earlier failed inspection for both job kinds", async t => {
	const f = await fixture(t);
	const exec = f.api.exec;
	for (const kind of ["agent", "loop"] as const) {
		const job = await resistantJob(t, f, kind, "retry");
		f.api.exec = async () => { throw new Error("inspection unavailable"); };
		await assert.rejects(f.tools.get(`${kind}_job_cancel`)!.execute("call", { jobId: "retry", killWindow: true }, undefined, undefined, f.ctx), /inspection unavailable/);
		const pending = JSON.parse(await fs.readFile(join(job.jobDir, "status.json"), "utf8"));
		assert.equal(pending.state, "running");
		assert.ok(pending.cancelRequestedAt);
		f.api.exec = exec;
		const result = await f.tools.get(`${kind}_job_cancel`)!.execute("call", { jobId: "retry", killWindow: true }, undefined, undefined, f.ctx);
		assert.equal((result.details as { state: string }).state, "cancelled");
		await assert.rejects(fs.readFile(join(job.jobDir, ".cleanup-pending.json")), /ENOENT/);
	}
});

test("post-TERM inspection failure retains uncertainty despite an exit marker, then permits verified retry", async t => {
	const f = await fixture(t);
	const exec = f.api.exec;
	for (const kind of ["agent", "loop"] as const) {
		const job = await resistantJob(t, f, kind, "after-term");
		let groupProbes = 0;
		f.api.exec = async (command, args) => {
			if (args[0] === "-axo" && ++groupProbes >= 2) throw new Error("inspection failed after TERM");
			return exec(command, args);
		};
		await assert.rejects(f.tools.get(`${kind}_job_cancel`)!.execute("call", { jobId: "after-term", killWindow: true }, undefined, undefined, f.ctx), /after TERM/);
		await waitFor(async () => !!await fs.readFile(job.exitPath, "utf8").catch(() => ""));
		const uncertain = await f.tools.get(`${kind}_job_status`)!.execute("call", { jobId: "after-term" }, undefined, undefined, f.ctx);
		assert.equal((uncertain.details as { state: string }).state, "running");
		assert.match(JSON.stringify(uncertain), /after TERM/);
		f.api.exec = exec;
		const stillAlive = await f.tools.get(`${kind}_job_status`)!.execute("call", { jobId: "after-term" }, undefined, undefined, f.ctx);
		assert.equal((stillAlive.details as { state: string }).state, "running", "the wrapper exit does not establish descendant cleanup");
		const retry = await f.tools.get(`${kind}_job_cancel`)!.execute("call", { jobId: "after-term", killWindow: true }, undefined, undefined, f.ctx);
		assert.equal((retry.details as { state: string }).state, "cancelled");
	}
});

test("restart preserves cleanup uncertainty and journal data never grants permission to kill survivors", async t => {
	const f = await fixture(t);
	const exec = f.api.exec;
	const job = await resistantJob(t, f, "loop", "restart");
	let probes = 0;
	f.api.exec = async (command, args) => {
		if (args[0] === "-axo" && ++probes >= 2) throw new Error("inspection failed after TERM");
		return exec(command, args);
	};
	await assert.rejects(f.tools.get("loop_job_cancel")!.execute("call", { jobId: "restart", killWindow: true }, undefined, undefined, f.ctx), /after TERM/);
	await waitFor(async () => !!await fs.readFile(job.exitPath, "utf8").catch(() => ""));
	await f.emit("session_shutdown");
	f.api.exec = exec;
	await f.emit("session_start");
	const result = await f.tools.get("loop_job_status")!.execute("call", { jobId: "restart" }, undefined, undefined, f.ctx);
	assert.equal((result.details as { state: string }).state, "running");
	await assert.rejects(f.tools.get("loop_job_cancel")!.execute("call", { jobId: "restart", killWindow: true }, undefined, undefined, f.ctx), /ownership/);
	assert.ok(!execFileSync("ps", ["-p", String(job.descendant), "-o", "stat="], { encoding: "utf8" }).includes("Z"));
	// Only the fixture's creator has authority here; persisted data is deliberately insufficient.
	process.kill(-job.pid, "SIGKILL");
	await waitFor(async () => {
		const state = await f.tools.get("loop_job_status")!.execute("call", { jobId: "restart" }, undefined, undefined, f.ctx);
		return (state.details as { state: string }).state === "cancelled";
	});
	assert.deepEqual(f.sent, []);
});

test("post-spawn cleanup uncertainty survives exit markers and restart until the whole group is gone", async t => {
	const f = await fixture(t);
	const bin = join(f.root, "bin");
	await fs.mkdir(bin);
	const ready = join(f.root, "descendant.pid");
	const code = `process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid)); setInterval(()=>{},1000);`;
	await fs.writeFile(join(bin, "pi"), `#!/usr/bin/env node\nrequire('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(code)}],{stdio:'ignore'}); process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);`, { mode: 0o700 });
	await fs.mkdir(join(f.root, ".pi/agents"), { recursive: true });
	await fs.writeFile(join(f.root, ".pi/agents/fixture.md"), "---\nname: fixture\ndescription: fixture\ntools: [read]\n---\nInspect only.");
	const oldPath = process.env.PATH;
	process.env.PATH = `${bin}:${oldPath}`;
	t.after(() => { process.env.PATH = oldPath; });
	const rename = mutableFs.rename;
	let pid = 0;
	t.mock.method(mutableFs, "rename", async (from: string, to: string) => {
		if (!pid && to.endsWith("status.json")) {
			const status = JSON.parse(await fs.readFile(from, "utf8"));
			if (status.processId) {
				pid = status.processId;
				const owned = pid;
				t.after(() => { try { process.kill(-owned, "SIGKILL"); } catch {} });
				await waitFor(async () => !!await fs.readFile(ready, "utf8").catch(() => ""));
				throw new Error("injected launch persistence failure");
			}
		}
		return rename(from, to);
	});
	const exec = f.api.exec;
	let groups = 0;
	f.api.exec = async (command, args) => {
		if (args[0] === "-axo" && ++groups >= 2) throw new Error("group inspection failed after TERM");
		return exec(command, args);
	};
	await assert.rejects(f.tools.get("agent_job_start")!.execute("call", { agent: "fixture", task: "slow", agentScope: "project", confirmProjectAgents: false, followUp: false }, undefined, undefined, f.ctx), /cleanup could not be verified/);
	const [id] = await fs.readdir(join(f.root, ".pi/agent-jobs"));
	const dir = join(f.root, ".pi/agent-jobs", id!);
	await waitFor(async () => !!await fs.readFile(join(dir, "exit.json"), "utf8").catch(() => ""));
	await f.emit("session_shutdown");
	f.api.exec = exec;
	await f.emit("session_start");
	const active = await f.tools.get("agent_job_status")!.execute("call", { jobId: id }, undefined, undefined, f.ctx);
	assert.equal((active.details as { state: string }).state, "running");
	assert.match(JSON.stringify(active), /injected launch persistence failure/);
	process.kill(-pid, "SIGKILL");
	await waitFor(async () => {
		const stopped = await f.tools.get("agent_job_status")!.execute("call", { jobId: id }, undefined, undefined, f.ctx);
		return (stopped.details as { state: string }).state === "failed";
	});
	await assert.rejects(fs.readFile(join(dir, ".cleanup-pending.json")), /ENOENT/);
	assert.deepEqual(f.sent, []);
});

test("queued completion receipts survive an actual module reload without resending", async t => {
	const f = await fixture(t);
	const job = await f.seed("agent", "reload");
	await f.emit("session_start");
	await waitFor(() => f.sent.length === 1);
	await f.reload();
	assert.equal(f.sent.length, 1);
	await f.emit("message_start", { message: { role: "user", content: f.sent[0] } });
	assert.equal(JSON.parse(await fs.readFile(join(job.jobDir, "status.json"), "utf8")).followUpSent, true);
	assert.equal(f.sent.length, 1);
});

test("a received completion retries failed acknowledgement persistence, not delivery", async t => {
	const f = await fixture(t);
	const job = await f.seed("loop", "receipt");
	await f.emit("session_start");
	await waitFor(() => f.sent.length === 1);
	const rename = mutableFs.rename;
	let unavailable = true;
	t.mock.method(mutableFs, "rename", async (from: string, to: string) => {
		if (unavailable && to.endsWith("status.json")) throw new Error("ack persistence unavailable");
		return rename(from, to);
	});
	await f.emit("message_start", { message: { role: "user", content: f.sent[0] } });
	assert.equal(JSON.parse(await fs.readFile(join(job.jobDir, "status.json"), "utf8")).followUpSent, false);
	f.setQueued(false);
	unavailable = false;
	await f.reload();
	await waitFor(async () => JSON.parse(await fs.readFile(join(job.jobDir, "status.json"), "utf8")).followUpSent);
	assert.equal(f.sent.length, 1);
});

test("an authentic receipt submitted to a different session cannot acknowledge its origin", async t => {
	const f = await fixture(t);
	const context = { ...f.ctx, sessionManager: { getSessionId: () => "origin" } } as unknown as ExtensionContext;
	const job = await f.seed("agent", "scoped", { originSessionId: "origin" });
	await f.emit("session_start", {}, context);
	await waitFor(() => f.sent.length === 1);
	const other = { ...f.ctx, sessionManager: { getSessionId: () => "other" } } as unknown as ExtensionContext;
	await f.emit("message_start", { message: { role: "user", content: f.sent[0] } }, other);
	assert.equal(JSON.parse(await fs.readFile(join(job.jobDir, "status.json"), "utf8")).followUpSent, false);
	await f.emit("message_start", { message: { role: "user", content: f.sent[0] } }, context);
	assert.equal(JSON.parse(await fs.readFile(join(job.jobDir, "status.json"), "utf8")).followUpSent, true);
});

test("session replacement loses its queue but returning to the origin recovers one notification", async t => {
	const f = await fixture(t);
	const origin = { ...f.ctx, sessionManager: { getSessionId: () => "A" } } as unknown as ExtensionContext;
	const other = { ...f.ctx, sessionManager: { getSessionId: () => "B" } } as unknown as ExtensionContext;
	const job = await f.seed("loop", "switch", { originSessionId: "A" });
	await f.emit("session_start", {}, origin);
	await waitFor(() => f.sent.length === 1);
	await f.emit("session_shutdown", { reason: "resume" }, origin);
	f.setQueued(false); // A replacement AgentSession does not inherit this queue.
	await f.emit("session_start", {}, other);
	await new Promise(r => setTimeout(r, 30));
	assert.equal(f.sent.length, 1, "session B must not receive A's completion");
	await f.emit("session_shutdown", { reason: "resume" }, other);
	await f.emit("session_start", {}, origin);
	await waitFor(() => f.sent.length === 2);
	await f.emit("message_start", { message: { role: "user", content: f.sent[1] } }, origin);
	assert.equal(JSON.parse(await fs.readFile(join(job.jobDir, "status.json"), "utf8")).followUpSent, true);
	assert.equal(f.sent.length, 2);
});

test("real SDK pre-queue async rejection permits an explicit scoped notification retry", async t => {
	const f = await fixture(t);
	const errors: Error[] = [];
	const send = f.api.sendUserMessage;
	const rejectedSession = { prompt: AgentSession.prototype.prompt, _compactionAbortController: new AbortController() } as unknown as AgentSession;
	// Mirror Pi's void wrapper around the real async SDK send; the extension cannot catch its rejection.
	f.api.sendUserMessage = text => { void AgentSession.prototype.sendUserMessage.call(rejectedSession, text, { deliverAs: "followUp" }).catch(error => errors.push(error)); };
	let editor = "";
	let confirm = false;
	const ctx = { ...f.ctx, hasUI: true, sessionManager: { getSessionId: () => "origin" }, ui: { getEditorText: () => editor, confirm: async () => confirm } } as unknown as ExtensionContext;
	const job = await f.seed("agent", "async-failure", { originSessionId: "origin" });
	await f.emit("session_start", {}, ctx);
	await waitFor(() => errors.length === 1);
	assert.match(errors[0]!.message, /compaction/);
	assert.equal(f.sent.length, 0);
	assert.equal(JSON.parse(await fs.readFile(join(job.jobDir, "status.json"), "utf8")).followUpSent, false);
	f.api.sendUserMessage = send;
	const retry = f.commands.get("agent-notification-retry")!;
	const wrong = { ...ctx, sessionManager: { getSessionId: () => "wrong" } } as unknown as ExtensionContext;
	await assert.rejects(retry.handler("agent async-failure", wrong as never), /originating conversation/);
	await retry.handler("agent async-failure", ctx as never);
	assert.equal(f.sent.length, 0, "declining confirmation does not reset suppression");
	confirm = true;
	f.setQueued(true);
	await assert.rejects(retry.handler("agent async-failure", ctx as never), /queue is empty/);
	f.setQueued(false);
	await retry.handler("agent async-failure", ctx as never);
	assert.equal(f.sent.length, 1);
	editor = f.sent[0]!;
	f.setQueued(false);
	await assert.rejects(retry.handler("agent async-failure", ctx as never), /still in the editor/);
	await f.emit("message_start", { message: { role: "user", content: f.sent[0] } }, ctx);
	assert.equal(JSON.parse(await fs.readFile(join(job.jobDir, "status.json"), "utf8")).followUpSent, true);
	assert.equal(f.sent.length, 1);
});
