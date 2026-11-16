import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import register, { loadAgentManagerSnapshot, readAgentManagerPreview, requestAgentCancellation } from "./index.ts";
import { ForegroundRegistry, buildManagerSnapshot, type ManagerPreview } from "./manager-model.ts";
import { AgentManagerComponent, showAgentManager, type ManagerOperations } from "./manager.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}
function theme(): Theme {
	return { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
}
const snapshot = () => buildManagerSnapshot("/project", ["a", "b"].map(jobId => ({
	jobId, agent: `agent-${jobId}`, task: `inspect ${jobId}`, state: "running", createdAt: "2026-10-01T10:00:00Z",
})), [], "session");
function component(operations: Partial<ManagerOperations> = {}, options: { autoRefresh?: boolean } = {}) {
	let renders = 0;
	let closes = 0;
	const terminal = { rows: 36 };
	const instance = new AgentManagerComponent({ terminal, requestRender() { renders++; } }, theme(), snapshot(), {
		load: async () => snapshot(), preview: async (_cwd, id) => ({ output: `output ${id}`, errors: `error ${id}` }),
		cancel: async () => "Cancellation requested.", ...operations,
	}, () => { closes++; }, { autoRefresh: false, ...options });
	return { instance, terminal, renders: () => renders, closes: () => closes };
}
async function diskFixture(t: test.TestContext) {
	const cwd = await mkdtemp(join(tmpdir(), "agent-manager-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const ctx = { cwd, isProjectTrusted: () => true, sessionManager: { getSessionId: () => "session" } } as unknown as ExtensionContext;
	const put = async (jobId: string, extra: Record<string, unknown> = {}) => {
		const dir = join(cwd, ".pi/agent-jobs", jobId);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "status.json"), JSON.stringify({
			jobId, cwd, jobDir: dir, agent: "researcher", task: "inspect only", state: "running",
			createdAt: "2026-10-01T10:00:00Z", originSessionId: "session", followUp: false, ...extra,
		}));
		return dir;
	};
	return { cwd, ctx, put };
}

test("navigation renders immediately and rejects late previews from old selections", async () => {
	const a = deferred<ManagerPreview>();
	const b = deferred<ManagerPreview>();
	const { instance, renders } = component({ preview: async (_cwd, id) => id === "a" ? a.promise : b.promise });
	instance.handleInput("j");
	assert.match(instance.render(140).join("\n"), /> agent-b/);
	assert.ok(renders() > 0);
	b.resolve({ output: "LATEST-B", errors: "ERROR-B" });
	await tick();
	a.resolve({ output: "STALE-A", errors: "ERROR-A" });
	await tick();
	assert.match(instance.render(140).join("\n"), /LATEST-B/);
	assert.doesNotMatch(instance.render(140).join("\n"), /STALE-A/);
	instance.handleInput("\t");
	assert.match(instance.render(140).join("\n"), /ERROR-B/);
	instance.dispose();
});

test("refresh failure keeps good snapshot; preview failure never leaks another job's output", async () => {
	const { instance } = component({
		load: async () => { throw new Error("disk offline"); },
		preview: async (_cwd, id) => { if (id === "b") throw new Error("unavailable"); return { output: "PRIVATE-A", errors: "" }; },
	});
	await tick();
	assert.match(instance.render(140).join("\n"), /PRIVATE-A/);
	instance.handleInput("j");
	await tick();
	assert.doesNotMatch(instance.render(140).join("\n"), /PRIVATE-A/);
	instance.handleInput("\t");
	assert.match(instance.render(140).join("\n"), /Preview unavailable/);
	await instance.refresh();
	const rendered = instance.render(160).join("\n");
	assert.match(rendered, /agent-b/);
	assert.match(rendered, /Refresh failed.*disk offline/);
	instance.dispose();
});

test("inline confirmation freezes identity, restores navigation, deduplicates cancellation", async () => {
	const cancelled: string[] = [];
	const request = deferred<string>();
	const { instance } = component({ cancel: async (cwd, id) => { cancelled.push(`${cwd}:${id}`); return request.promise; } });
	await tick();
	instance.handleInput("c");
	assert.match(instance.render(140).join("\n"), /y\/Enter cancel.*Cancel agent-a/);
	instance.handleInput("j");
	assert.match(instance.render(140).join("\n"), /> agent-a/);
	instance.handleInput("\x1b");
	instance.handleInput("j");
	instance.handleInput("c");
	instance.handleInput("y");
	instance.handleInput("c");
	instance.handleInput("y");
	assert.deepEqual(cancelled, ["/project:b"]);
	request.resolve("Cancellation requested.");
	await tick();
	instance.handleInput("k");
	assert.match(instance.render(140).join("\n"), /> agent-a/);
	instance.dispose();
});

test("encoded CSI-u letter shortcuts open and confirm cancellation, then restore navigation", async () => {
	const ids: string[] = [];
	const { instance, closes } = component({ cancel: async (_cwd, id) => { ids.push(id); return "Cancellation requested."; } });
	instance.handleInput("\x1b[99u"); // c
	assert.match(instance.render(140).join("\n"), /y\/Enter cancel/);
	instance.handleInput("\x1b[121u"); // y
	await tick();
	assert.deepEqual(ids, ["a"]);
	instance.handleInput("\x1b[106u"); // j
	assert.match(instance.render(140).join("\n"), /> agent-b/);
	instance.handleInput("\x1b[99u");
	instance.handleInput("\x1b[110u"); // n
	assert.doesNotMatch(instance.render(140).join("\n"), /y\/Enter cancel/);
	instance.handleInput("\x1b[113u"); // q
	assert.equal(closes(), 1);
});

test("closing aborts reads, discards late updates, stops polling and never cancels jobs", async () => {
	const pending = deferred<ReturnType<typeof snapshot>>();
	let loadSignal: AbortSignal | undefined;
	let cancels = 0;
	const { instance, closes, renders } = component({
		load: async signal => { loadSignal = signal; return pending.promise; },
		cancel: async () => { cancels++; return ""; },
	}, { autoRefresh: true });
	await tick();
	const refresh = instance.refresh();
	instance.handleInput("q");
	const previousRenders = renders();
	assert.equal(loadSignal?.aborted, true);
	pending.resolve(snapshot());
	await refresh;
	assert.equal(renders(), previousRenders);
	assert.equal(closes(), 1);
	assert.equal(cancels, 0);
	instance.close();
	assert.equal(closes(), 1);
});

test("manager draws a theme-colored frame and divider without exceeding its viewport", () => {
	const colored: string[] = [];
	const frameTheme = { fg: (color: string, text: string) => {
		if (color === "accent") colored.push(text);
		return text;
	}, bold: (text: string) => text } as unknown as Theme;
	const terminal = { rows: 30 };
	const instance = new AgentManagerComponent({ terminal, requestRender() {} }, frameTheme, snapshot(), {
		load: async () => snapshot(), preview: async () => ({ output: "", errors: "" }), cancel: async () => "",
	}, () => {}, { autoRefresh: false });
	for (const width of [60, 100]) {
		const lines = instance.render(width);
		assert.match(lines[0]!, /^┌─+┐$/);
		assert.match(lines.at(-1)!, /^└─+┘$/);
		assert.ok(lines.slice(1, -1).every(line => line.startsWith("│ ") && line.endsWith(" │")));
		assert.ok(lines.every(line => visibleWidth(line) === width));
		if (width === 100) assert.ok(lines.some(line => (line.match(/│/g) ?? []).length === 3), "wide layout includes a pane divider");
	}
	assert.ok(colored.some(text => text.startsWith("┌")), "top border uses theme accent");
	assert.ok(colored.includes("│"), "sides and divider use theme accent");
	assert.ok(colored.some(text => text.startsWith("└")), "bottom border uses theme accent");
	instance.dispose();
});

test("narrow/wide/short layouts fit visible columns and selected rows remain visible", async () => {
	const { instance, terminal } = component({ preview: async () => ({ output: "界".repeat(200) + "\x1bc\x1b]52;c;secret", errors: "" }) });
	await tick();
	for (const rows of [4, 6, 8, 9, 10, 24, 40]) {
		terminal.rows = rows;
		for (const width of [1, 20, 60, 80, 130]) {
			const lines = instance.render(width);
			assert.ok(lines.every(line => visibleWidth(line) <= width), `${width} columns`);
			assert.ok(lines.length <= Math.max(1, Math.min(rows - 2, Math.floor(rows * 0.9))), `${rows} rows with overlay margins`);
			assert.doesNotMatch(lines.join("\n"), /\x1bc|\x1b\]52/);
		}
	}
	instance.handleInput("j");
	assert.match(instance.render(60).join("\n"), /> agent-b/);
	instance.handleInput("c");
	for (const rows of [4, 6, 8, 9, 10, 24]) {
		terminal.rows = rows;
		const lines = instance.render(80);
		const composited = lines.slice(0, Math.max(1, Math.min(rows - 2, Math.floor(rows * 0.9))));
		assert.match(composited.join("\n"), /y\/Enter cancel.*n\/Esc back/);
	}
	instance.dispose();
});

test("snapshot recovers durable jobs across sessions and isolates bad records without finalizing", async t => {
	const { ctx, put, cwd } = await diskFixture(t);
	const dir = await put("exited");
	await writeFile(join(dir, "exit.json"), '{"exitCode":0}');
	await put("other", { originSessionId: "another" });
	await put("legacy", { originSessionId: null, agent: null, task: 42, createdAt: [] });
	await put("done", { state: "completed", followUp: true, followUpSent: false });
	const bad = await put("broken");
	await writeFile(join(bad, "status.json"), "not json");
	await symlink(dir, join(cwd, ".pi/agent-jobs", "symlink-job"));
	const registry = new ForegroundRegistry();
	const result = await loadAgentManagerSnapshot(ctx, registry);
	assert.equal(result.running, 3);
	assert.equal(result.rows.length, 4);
	assert.equal(result.rows.find(row => row.jobId === "other")?.origin, "other");
	assert.equal(result.rows.find(row => row.jobId === "legacy")?.origin, "unknown");
	assert.equal(result.rows.find(row => row.jobId === "exited")?.exitRecorded, true);
	assert.ok(result.warnings.length >= 3);
	assert.equal(JSON.parse(await readFile(join(dir, "status.json"), "utf8")).state, "running");
	await assert.rejects(loadAgentManagerSnapshot({ ...ctx, isProjectTrusted: () => false }, registry), /trusted/);
});

test("preview reads selected bounded artifacts, strips controls and ignores reasoning", async t => {
	const { ctx, cwd, put } = await diskFixture(t);
	const dir = await put("selected");
	await put("unselected");
	await symlink("/not/readable", join(cwd, ".pi/agent-jobs/unselected/events.jsonl"));
	const event = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [
		{ type: "thinking", thinking: "SECRET-REASONING" }, { type: "text", text: "PUBLIC-TEXT\x1b[31m!\x1b[0m" },
	] } });
	await writeFile(join(dir, "events.jsonl"), "x".repeat(70000) + "\n" + event + "\n");
	let preview = await readAgentManagerPreview(ctx, cwd, "selected");
	assert.match(preview.output, /PUBLIC-TEXT!/);
	assert.match(preview.output, /Truncated/);
	assert.doesNotMatch(preview.output, /SECRET-REASONING|\x1b/);
	await writeFile(join(dir, "result.md"), "HEAD" + "x".repeat(70000) + "TAIL\x1bc");
	await writeFile(join(dir, "stderr.log"), Array(400).fill("error\x1b7").join("\n"));
	preview = await readAgentManagerPreview(ctx, cwd, "selected");
	assert.ok(Buffer.byteLength(preview.output) < 66000);
	assert.match(preview.output, /TAIL/);
	assert.doesNotMatch(preview.output, /HEAD|\x1b/);
	assert.ok(preview.errors.split("\n").length <= 200);
	await assert.rejects(readAgentManagerPreview(ctx, cwd, "unselected"), /symlink|Invalid/);
	await assert.rejects(readAgentManagerPreview(ctx, cwd, "../escape"), /Invalid job id/);
	await assert.rejects(readAgentManagerPreview(ctx, cwd, "selected", AbortSignal.abort()), /abort/i);
});

test("shared cancellation rechecks terminal state, pending requests and process identity", async t => {
	const { ctx, put } = await diskFixture(t);
	const terminal = await put("terminal", { state: "completed" });
	await put("pending", { cancelRequestedAt: "2026-10-01T10:01:00Z" });
	const dir = await put("wrong-pid", { processId: 12345 });
	await writeFile(join(dir, "pid"), "54321");
	let signals = 0;
	const api = { exec: async () => { signals++; throw new Error("must not inspect a mismatched PID"); } } as unknown as ExtensionAPI;
	assert.match((await requestAgentCancellation(api, ctx, { jobId: "terminal" })).text, /already completed/);
	assert.match((await requestAgentCancellation(api, ctx, { jobId: "pending" })).text, /already pending/);
	await assert.rejects(requestAgentCancellation(api, ctx, { jobId: "wrong-pid" }), /identity/);
	assert.equal(signals, 0);
	assert.equal(JSON.parse(await readFile(join(terminal, "status.json"), "utf8")).state, "completed");
});

test("manager entrypoint supports non-TUI guidance and session shutdown closes the overlay", async t => {
	const { ctx } = await diskFixture(t);
	const notifications: string[] = [];
	await showAgentManager({ ...ctx, mode: "rpc", ui: { notify: (text: string) => notifications.push(text) } } as ExtensionContext,
		{ load: async () => { throw new Error("must not load outside TUI"); } } as ManagerOperations, new AbortController().signal);
	assert.match(notifications[0]!, /agent_job_status/);
	type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
	const commands = new Map<string, Command>();
	const shutdown: Array<() => unknown> = [];
	register({ on: (name: string, handler: () => unknown) => { if (name === "session_shutdown") shutdown.push(handler); },
		registerCommand: (name: string, definition: Command) => commands.set(name, definition), registerTool() {},
	} as unknown as ExtensionAPI);
	const opened = deferred<void>();
	let closed = false;
	const operation = commands.get("agents")!.handler("", { ...ctx, mode: "tui", ui: {
		notify: (text: string) => notifications.push(text),
		custom: async (factory: (tui: unknown, theme: Theme, bindings: unknown, done: () => void) => AgentManagerComponent) => new Promise<void>(resolve => {
			factory({ terminal: { rows: 24 }, requestRender() {} }, theme(), {}, () => { closed = true; resolve(); });
			opened.resolve();
		}),
	} } as unknown as Parameters<Command["handler"]>[1]);
	await opened.promise;
	for (const handler of shutdown) await handler();
	await operation;
	assert.equal(closed, true);
	assert.equal(notifications.length, 1);
});
