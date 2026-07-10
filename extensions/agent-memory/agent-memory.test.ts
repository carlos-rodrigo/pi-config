import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { VERIFICATION_OUTCOME_EVENT, type VerificationOutcome } from "../verify/index.ts";
import {
	applyControlCommand,
	createAgentMemoryExtension,
	createOllamaMemoryEmbeddingAdapter,
	formatControlStatus,
	parseAgentMemoryCommand,
	recordRecallEvidence,
	resolveAgentMemoryOllamaBaseUrl,
	type AgentMemoryExtensionOptions,
	type MemoryEmbeddingRequest,
	type MemoryRecord,
	type VectorCacheRequest,
} from "./index.ts";

const execFileAsync = promisify(execFile);

type FakeContext = {
	cwd: string;
	signal?: AbortSignal;
	sessionManager: {
		getEntries(): unknown[];
	};
	ui: {
		setStatus(key: string, value: string | undefined): void;
		notify(message: string, level?: string): void;
	};
};

type EventHandler = (event: unknown, ctx: FakeContext) => unknown | Promise<unknown>;
type EventBusHandler = (event: unknown) => unknown | Promise<unknown>;
type CommandHandler = (args: string, ctx: FakeContext) => unknown | Promise<unknown>;

function createHarness(options: AgentMemoryExtensionOptions = {}) {
	const events = new Map<string, EventHandler>();
	const eventBusHandlers = new Map<string, Set<EventBusHandler>>();
	const commands = new Map<string, { description: string; handler: CommandHandler }>();
	const statuses: Array<{ key: string; value: string | undefined }> = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	const sentMessages: unknown[] = [];
	const sessionEntries: unknown[] = [{ type: "message", message: { role: "user", content: "existing" } }];

	const pi = {
		on(name: string, handler: EventHandler) {
			events.set(name, handler);
		},
		events: {
			on(name: string, handler: EventBusHandler) {
				const handlers = eventBusHandlers.get(name) ?? new Set<EventBusHandler>();
				handlers.add(handler);
				eventBusHandlers.set(name, handlers);
				return () => handlers.delete(handler);
			},
			emit(name: string, event: unknown) {
				for (const handler of eventBusHandlers.get(name) ?? []) void handler(event);
			},
		},
		registerCommand(name: string, definition: { description: string; handler: CommandHandler }) {
			commands.set(name, definition);
		},
		sendMessage(message: unknown) {
			sentMessages.push(message);
		},
	};
	createAgentMemoryExtension(options)(pi as unknown as ExtensionAPI);

	return {
		events,
		commands,
		statuses,
		notifications,
		sentMessages,
		sessionEntries,
		async emitEvent(name: string, event: unknown): Promise<void> {
			await Promise.all([...eventBusHandlers.get(name) ?? []].map((handler) => handler(event)));
		},
		emitEventFireAndForget(name: string, event: unknown): void {
			for (const handler of eventBusHandlers.get(name) ?? []) void handler(event);
		},
		eventBusHandlerCount(name: string): number {
			return eventBusHandlers.get(name)?.size ?? 0;
		},
		ctx(cwd: string): FakeContext {
			return {
				cwd,
				sessionManager: { getEntries: () => sessionEntries },
				ui: {
					setStatus(key, value) {
						statuses.push({ key, value });
					},
					notify(message, level) {
						notifications.push({ message, level });
					},
				},
			};
		},
	};
}

function makeTempDirectory(t: test.TestContext, prefix: string): string {
	const path = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(path, { recursive: true, force: true }));
	return path;
}

function makeProject(t: test.TestContext): string {
	return makeTempDirectory(t, "pi-agent-memory-test-");
}

function readMemoryRecords(path: string): MemoryRecord[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as MemoryRecord);
}

function memoryRecord(id: string, scope: "project" | "global", lesson: string): MemoryRecord {
	return {
		schemaVersion: 1,
		id,
		scope,
		type: "workflow",
		status: "active",
		lesson,
		sourceKind: "manual",
		sourceRef: `test:${id}`,
		redacted: false,
		safety: { redactionKinds: [], explicitScopeApproval: true },
		vectorCacheKey: `mxbai-embed-large:${id}`,
		recalled: 0,
		passed: 0,
		failed: 0,
		confidence: 0,
		createdAt: "2026-07-09T09:00:00.000Z",
		updatedAt: "2026-07-09T09:00:00.000Z",
		lastRecalledAt: null,
	};
}

function writeMemoryRecords(root: string, records: unknown[]): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "memories.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

function readJsonLines(path: string): unknown[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

async function beforeAgentStart(
	harness: ReturnType<typeof createHarness>,
	ctx: FakeContext,
	prompt: string,
	systemPrompt = "BASE SYSTEM",
): Promise<{ systemPrompt: string } | undefined> {
	const handler = harness.events.get("before_agent_start");
	assert.ok(handler, "expected before_agent_start registration");
	return await handler({ prompt, systemPrompt }, ctx) as { systemPrompt: string } | undefined;
}

async function startSession(harness: ReturnType<typeof createHarness>, ctx: FakeContext): Promise<void> {
	const handler = harness.events.get("session_start");
	assert.ok(handler, "expected session_start registration");
	await handler({ reason: "startup" }, ctx);
}

async function runCommand(harness: ReturnType<typeof createHarness>, args: string, ctx: FakeContext): Promise<void> {
	const command = harness.commands.get("agent-memory");
	assert.ok(command, "expected /agent-memory registration");
	await command.handler(args, ctx);
}

function verificationOutcome(
	projectRoot: string,
	status: "passed" | "failed",
	overrides: Partial<VerificationOutcome> = {},
): VerificationOutcome {
	return {
		schemaVersion: 1,
		projectRoot,
		command: "bash scripts/verify.sh",
		status,
		trigger: "auto",
		timestamp: "2026-07-09T13:01:00.000Z",
		...overrides,
	};
}

test("command parser and pure control state cover the shell contract", () => {
	for (const command of ["status", "pause", "resume", "disable", "enable", "reset"] as const) {
		assert.deepEqual(parseAgentMemoryCommand(`  ${command}  `), { ok: true, command });
	}
	assert.deepEqual(parseAgentMemoryCommand(""), { ok: true, command: "status" });
	assert.deepEqual(parseAgentMemoryCommand('add project "Use scripts/run_silent.sh"'), {
		ok: true,
		command: "add",
		scope: "project",
		text: "Use scripts/run_silent.sh",
	});
	assert.deepEqual(parseAgentMemoryCommand("add global Prefer small focused diffs"), {
		ok: true,
		command: "add",
		scope: "global",
		text: "Prefer small focused diffs",
	});
	assert.deepEqual(parseAgentMemoryCommand("review"), { ok: true, command: "review" });
	assert.deepEqual(parseAgentMemoryCommand("archive project mem_1"), {
		ok: true,
		command: "archive",
		scope: "project",
		id: "mem_1",
	});
	assert.deepEqual(parseAgentMemoryCommand('edit global mem_2 "Prefer relative paths"'), {
		ok: true,
		command: "edit",
		scope: "global",
		id: "mem_2",
		text: "Prefer relative paths",
	});
	assert.deepEqual(parseAgentMemoryCommand("delete project mem_3"), {
		ok: true,
		command: "delete",
		scope: "project",
		id: "mem_3",
	});
	assert.deepEqual(parseAgentMemoryCommand("reset all"), { ok: true, command: "reset-memories", scope: "all" });
	assert.deepEqual(parseAgentMemoryCommand("reject global mem_4"), {
		ok: true,
		command: "reject",
		scope: "global",
		id: "mem_4",
	});
	assert.deepEqual(parseAgentMemoryCommand("approve project mem_5"), {
		ok: true,
		command: "approve",
		scope: "project",
		id: "mem_5",
	});
	assert.deepEqual(parseAgentMemoryCommand("restore project mem_6"), {
		ok: true,
		command: "restore",
		scope: "project",
		id: "mem_6",
	});
	assert.deepEqual(parseAgentMemoryCommand("promote mem_7"), { ok: true, command: "promote", id: "mem_7" });
	for (const invalid of [
		"pause later",
		"recall",
		"add team lesson",
		"add project",
		'add project ""',
		"archive team mem_1",
		"edit project mem_1",
		"reset team",
		"promote",
	]) {
		assert.equal(parseAgentMemoryCommand(invalid).ok, false, invalid);
	}

	const running = { enabled: true, paused: false };
	assert.deepEqual(applyControlCommand(running, "pause"), { enabled: true, paused: true });
	assert.deepEqual(applyControlCommand(running, "disable"), { enabled: false, paused: false });
	assert.deepEqual(applyControlCommand({ enabled: false, paused: false }, "enable"), running);
	assert.deepEqual(applyControlCommand({ enabled: false, paused: true }, "reset"), running);
	assert.equal(formatControlStatus(running), "mem: running");
	assert.equal(formatControlStatus({ enabled: true, paused: true }), "mem: paused");
	assert.equal(formatControlStatus({ enabled: false, paused: false }), "mem: disabled");
});

test("fake /agent-memory add stores an active project memory and requests vector caching", async (t) => {
	const cwd = makeProject(t);
	const home = makeTempDirectory(t, "pi-agent-memory-home-");
	const requests: VectorCacheRequest[] = [];
	const harness = createHarness({
		home,
		createId: () => "mem_project_seed",
		now: () => new Date("2026-07-09T10:00:00.000Z"),
		vectorCache: {
			async request(request) {
				requests.push(request);
			},
		},
	});
	const ctx = harness.ctx(cwd);
	await startSession(harness, ctx);

	await runCommand(harness, 'add project "Use scripts/run_silent.sh for quiet verification"', ctx);

	const memoriesPath = join(cwd, ".pi", "agent-memory", "memories.jsonl");
	const [record] = readMemoryRecords(memoriesPath);
	assert.deepEqual(record, {
		schemaVersion: 1,
		id: "mem_project_seed",
		scope: "project",
		type: "workflow",
		status: "active",
		lesson: "Use scripts/run_silent.sh for quiet verification",
		sourceKind: "manual",
		sourceRef: "command:/agent-memory add project",
		redacted: false,
		safety: {
			redactionKinds: [],
			explicitScopeApproval: true,
		},
		vectorCacheKey: "mxbai-embed-large:mem_project_seed",
		recalled: 0,
		passed: 0,
		failed: 0,
		confidence: 0,
		createdAt: "2026-07-09T10:00:00.000Z",
		updatedAt: "2026-07-09T10:00:00.000Z",
		lastRecalledAt: null,
	});
	assert.deepEqual(requests, [{
		memoryId: "mem_project_seed",
		scope: "project",
		root: join(cwd, ".pi", "agent-memory"),
		lesson: "Use scripts/run_silent.sh for quiet verification",
		embeddingModel: "mxbai-embed-large",
		cacheKey: "mxbai-embed-large:mem_project_seed",
		requestedAt: "2026-07-09T10:00:00.000Z",
	}]);
	const confirmation = harness.notifications.at(-1);
	assert.equal(confirmation?.level, "info");
	assert.match(confirmation?.message ?? "", /Scope: project/);
	assert.match(confirmation?.message ?? "", /Source: manual/);
	assert.match(confirmation?.message ?? "", /Redaction: none/);
	assert.match(confirmation?.message ?? "", /State: active/);
	assert.equal(existsSync(join(home, ".pi", "agent-memory", "memories.jsonl")), false);
});

test("manual global add writes only the explicit global scope", async (t) => {
	const cwd = makeProject(t);
	const home = makeTempDirectory(t, "pi-agent-memory-home-");
	const ids = ["mem_global_seed", "mem_global_second"];
	const harness = createHarness({
		home,
		createId: () => ids.shift() ?? assert.fail("unexpected extra memory id"),
		now: () => new Date("2026-07-09T11:00:00.000Z"),
	});
	const ctx = harness.ctx(cwd);
	await startSession(harness, ctx);

	await runCommand(harness, 'add global "Prefer focused reversible changes"', ctx);
	await runCommand(harness, 'add global "Keep append-only records inspectable"', ctx);

	const records = readMemoryRecords(join(home, ".pi", "agent-memory", "memories.jsonl"));
	assert.equal(records.length, 2, "manual adds must append rather than replace prior records");
	assert.deepEqual(records.map((record) => record.id), ["mem_global_seed", "mem_global_second"]);
	assert.equal(records[0]?.scope, "global");
	assert.equal(records[0]?.status, "active");
	assert.equal(records[0]?.sourceKind, "manual");
	assert.equal(records[0]?.safety.explicitScopeApproval, true);
	assert.equal(existsSync(join(cwd, ".pi", "agent-memory", "memories.jsonl")), false);
	assert.match(harness.notifications.at(-1)?.message ?? "", /Scope: global/);

	const vectorCache = JSON.parse(readFileSync(join(home, ".pi", "agent-memory", "vectors.json"), "utf8"));
	assert.equal(vectorCache.embeddingModel, "mxbai-embed-large");
	assert.deepEqual(Object.keys(vectorCache.requests), ["mem_global_seed", "mem_global_second"]);
	assert.deepEqual(vectorCache.requests.mem_global_seed, {
		memoryId: "mem_global_seed",
		scope: "global",
		cacheKey: "mxbai-embed-large:mem_global_seed",
		status: "requested",
		requestedAt: "2026-07-09T11:00:00.000Z",
	});
	assert.equal(
		readdirSync(join(home, ".pi", "agent-memory")).some((name) => name.endsWith(".tmp")),
		false,
		"atomic vector-cache writes must clean temporary files",
	);
});

test("concurrent Pi processes preserve project memories and vector requests", async (t) => {
	const cwd = makeProject(t);
	const home = makeTempDirectory(t, "pi-agent-memory-home-");
	const moduleUrl = new URL("./index.ts", import.meta.url).href;
	const script = `
const [moduleUrl, cwd, home, id, lesson] = process.argv.slice(1);
const { createAgentMemoryExtension } = await import(moduleUrl);
const events = new Map();
const commands = new Map();
const pi = {
  on(name, handler) { events.set(name, handler); },
  events: { on() { return () => {}; } },
  registerCommand(name, definition) { commands.set(name, definition); },
  exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
};
createAgentMemoryExtension({ home, createId: () => id })(pi);
const ctx = { cwd, sessionManager: { getEntries: () => [] }, ui: { setStatus() {}, notify() {} } };
await events.get("session_start")({ reason: "startup" }, ctx);
await commands.get("agent-memory").handler(\`add project \${JSON.stringify(lesson)}\`, ctx);
`;
	await Promise.all([
		execFileAsync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, moduleUrl, cwd, home, "mem_process_a", "First concurrent lesson"], { cwd: process.cwd() }),
		execFileAsync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, moduleUrl, cwd, home, "mem_process_b", "Second concurrent lesson"], { cwd: process.cwd() }),
	]);

	const root = join(cwd, ".pi", "agent-memory");
	assert.deepEqual(readMemoryRecords(join(root, "memories.jsonl")).map((record) => record.id).sort(), ["mem_process_a", "mem_process_b"]);
	const vectors = JSON.parse(readFileSync(join(root, "vectors.json"), "utf8"));
	assert.deepEqual(Object.keys(vectors.requests).sort(), ["mem_process_a", "mem_process_b"]);
	assert.equal(existsSync(join(root, ".write-lock")), false);
});

test("concurrent Pi processes preserve recall and verification counters", async (t) => {
	const cwd = makeProject(t);
	const home = makeTempDirectory(t, "pi-agent-memory-home-");
	const root = join(cwd, ".pi", "agent-memory");
	writeMemoryRecords(root, [memoryRecord("mem_shared_process", "project", "Run concurrent verification")]);
	const moduleUrl = new URL("./index.ts", import.meta.url).href;
	const script = `
const [moduleUrl, cwd, home, now] = process.argv.slice(1);
const { createAgentMemoryExtension } = await import(moduleUrl);
const events = new Map();
let verificationHandler;
const pi = {
  on(name, handler) { events.set(name, handler); },
  events: { on(_name, handler) { verificationHandler = handler; return () => {}; } },
  registerCommand() {},
  exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
};
createAgentMemoryExtension({
  home,
  now: () => new Date(now),
  embeddingAdapter: { async embed(request) { return request.texts.map(() => [1, 0]); } },
})(pi);
const ctx = { cwd, signal: undefined, sessionManager: { getEntries: () => [] }, ui: { setStatus() {}, notify() {} } };
await events.get("session_start")({ reason: "startup" }, ctx);
await events.get("before_agent_start")({ prompt: "concurrent verification", systemPrompt: "BASE" }, ctx);
await verificationHandler({ schemaVersion: 1, projectRoot: cwd, command: "bash scripts/verify.sh", status: "passed", trigger: "auto", timestamp: "2026-07-09T13:01:00.000Z" });
`;
	await Promise.all([
		execFileAsync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, moduleUrl, cwd, home, "2026-07-09T13:00:00.000Z"], { cwd: process.cwd() }),
		execFileAsync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, moduleUrl, cwd, home, "2026-07-09T13:00:01.000Z"], { cwd: process.cwd() }),
	]);

	const latest = readMemoryRecords(join(root, "memories.jsonl")).at(-1);
	assert.equal(latest?.id, "mem_shared_process");
	assert.equal(latest?.recalled, 2);
	assert.equal(latest?.passed, 2);
	assert.equal(latest?.failed, 0);
	assert.ok(Date.parse(latest?.lastRecalledAt ?? "") >= Date.parse("2026-07-09T13:00:01.000Z"));
	assert.ok(Date.parse(latest?.lastRecalledAt ?? "") <= Date.parse(latest?.updatedAt ?? ""));
	assert.equal(existsSync(join(root, ".write-lock")), false);
});

test("invalid manual add scope or empty text is rejected without writing storage", async (t) => {
	const cwd = makeProject(t);
	const home = makeTempDirectory(t, "pi-agent-memory-home-");
	const harness = createHarness({ home });
	const ctx = harness.ctx(cwd);
	await startSession(harness, ctx);

	for (const args of ["add team lesson", "add project", 'add global ""']) {
		await runCommand(harness, args, ctx);
		assert.equal(harness.notifications.at(-1)?.level, "error");
	}

	assert.equal(existsSync(join(cwd, ".pi", "agent-memory")), false);
	assert.equal(existsSync(join(home, ".pi", "agent-memory")), false);
});

test("secret-like command text is redacted and stored as a review candidate", async (t) => {
	const cwd = makeProject(t);
	const home = makeTempDirectory(t, "pi-agent-memory-home-");
	const requests: VectorCacheRequest[] = [];
	const harness = createHarness({
		home,
		createId: () => "mem_redacted_seed",
		now: () => new Date("2026-07-09T12:00:00.000Z"),
		vectorCache: { async request(request) { requests.push(request); } },
	});
	const ctx = harness.ctx(cwd);
	await startSession(harness, ctx);

	await runCommand(
		harness,
		'add project "Send Authorization: Bearer secret-token and fallback Authorization: opaque-credential with password=hunter2, API_KEY=key-value, token: token-value"',
		ctx,
	);

	const memoriesPath = join(cwd, ".pi", "agent-memory", "memories.jsonl");
	const raw = readFileSync(memoriesPath, "utf8");
	assert.doesNotMatch(raw, /secret-token|opaque-credential|hunter2|key-value|token-value/);
	const [record] = readMemoryRecords(memoriesPath);
	assert.equal(
		record.lesson,
		"Send Authorization: Bearer [REDACTED] and fallback Authorization: [REDACTED] with password=[REDACTED], API_KEY=[REDACTED], token: [REDACTED]",
	);
	assert.equal(record.redacted, true);
	assert.equal(record.status, "candidate");
	assert.deepEqual(record.safety.redactionKinds, ["authorization", "password", "api-key", "token"]);
	assert.match(record.reviewOnlyReason ?? "", /redacted final text/i);
	assert.equal(requests[0]?.lesson, record.lesson);
	assert.match(
		harness.notifications.at(-1)?.message ?? "",
		/Redaction: applied \(authorization, password, api-key, token\)/,
	);
	assert.match(harness.notifications.at(-1)?.message ?? "", /State: candidate .*waiting for review/i);
});

test("effective Ollama URL honors the shared tunnel environment", () => {
	assert.equal(resolveAgentMemoryOllamaBaseUrl("http://127.0.0.1:11435", {}), "http://127.0.0.1:11435");
	assert.equal(
		resolveAgentMemoryOllamaBaseUrl("http://127.0.0.1:11435", { OLLAMA_BASE_URL: "http://127.0.0.1:11436/" }),
		"http://127.0.0.1:11436",
	);
	assert.equal(
		resolveAgentMemoryOllamaBaseUrl("http://127.0.0.1:11435", { OLLAMA_HOST: "127.0.0.1:11437" }),
		"http://127.0.0.1:11437",
	);
});

test("Ollama memory adapter uses configured request bounds and normalizes local vectors", async () => {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), init });
		return new Response(JSON.stringify({ embeddings: [[3, 4], [0, 2]] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	const adapter = createOllamaMemoryEmbeddingAdapter(fetchImpl);

	const vectors = await adapter.embed({
		texts: ["a\u0000bcdef", "lesson"],
		model: "mxbai-embed-large",
		baseUrl: "http://127.0.0.1:11434/",
		timeoutMs: 1000,
		maxInputChars: 4,
	});

	assert.deepEqual(vectors, [[0.6, 0.8], [0, 1]]);
	assert.equal(calls[0]?.url, "http://127.0.0.1:11434/api/embed");
	assert.equal(calls[0]?.init?.method, "POST");
	assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
		model: "mxbai-embed-large",
		input: ["a�bc", "less"],
		truncate: true,
	});
});

test("recall consumes pending vector requests and reuses ready memory vectors", async (t) => {
	const cwd = makeProject(t);
	const home = makeTempDirectory(t, "pi-agent-memory-home-");
	const embeddingTexts: string[][] = [];
	const harness = createHarness({
		home,
		createId: () => "mem_cached",
		now: () => new Date("2026-07-09T12:30:00.000Z"),
		embeddingAdapter: {
			async embed(request) {
				embeddingTexts.push(request.texts);
				return request.texts.map(() => [1, 0]);
			},
		},
	});
	const ctx = harness.ctx(cwd);
	await startSession(harness, ctx);
	await runCommand(harness, 'add project "Use quiet verification"', ctx);

	await beforeAgentStart(harness, ctx, "verification");
	await beforeAgentStart(harness, ctx, "verification");

	assert.deepEqual(embeddingTexts, [
		["verification", "Use quiet verification"],
		["verification"],
	]);
	const records = readMemoryRecords(join(cwd, ".pi", "agent-memory", "memories.jsonl"));
	assert.equal(records.at(-1)?.recalled, 2);
	assert.equal(records.at(-1)?.lastRecalledAt, "2026-07-09T12:30:00.002Z");
	assert.deepEqual(records.slice(1).map((record) => record.revision?.action), ["recall", "recall"]);
	const cache = JSON.parse(readFileSync(join(cwd, ".pi", "agent-memory", "vectors.json"), "utf8"));
	assert.deepEqual(cache.requests.mem_cached, {
		memoryId: "mem_cached",
		scope: "project",
		cacheKey: "mxbai-embed-large:mem_cached",
		status: "ready",
		requestedAt: "2026-07-09T12:30:00.000Z",
		embeddedAt: "2026-07-09T12:30:00.000Z",
		embedding: [1, 0],
	});
});

test("recall evidence keeps successful project items when global persistence fails", async (t) => {
	const cwd = makeProject(t);
	const home = makeTempDirectory(t, "pi-agent-memory-home-");
	const projectRecord = memoryRecord("mem_project_evidence", "project", "Use project evidence");
	const globalRecord = memoryRecord("mem_global_evidence", "global", "Use global evidence");
	writeMemoryRecords(join(cwd, ".pi", "agent-memory"), [projectRecord]);
	mkdirSync(join(home, ".pi"), { recursive: true });
	writeFileSync(join(home, ".pi", "agent-memory"), "blocks the global storage directory", "utf8");

	const result = await recordRecallEvidence({
		cwd,
		home,
		timestamp: "2026-07-09T12:30:00.000Z",
		memories: [projectRecord, globalRecord].map((record) => ({
			record,
			score: 0.9,
			embeddingScore: 1,
			lexicalScore: 0.5,
		})),
	});

	assert.deepEqual(result.memories.map((memory) => memory.record.id), ["mem_project_evidence"]);
	assert.deepEqual(result.failures.map((failure) => `${failure.scope}/${failure.memoryId}`), ["global/mem_global_evidence"]);
	const stored = readMemoryRecords(join(cwd, ".pi", "agent-memory", "memories.jsonl")).at(-1);
	assert.equal(stored?.recalled, 1);
	assert.equal(stored?.lastRecalledAt, "2026-07-09T12:30:00.000Z");
});

test("audit-log failure stays visible without cancelling counted prompt injection", async (t) => {
	const cwd = makeProject(t);
	const home = makeTempDirectory(t, "pi-agent-memory-home-");
	const root = join(cwd, ".pi", "agent-memory");
	writeMemoryRecords(root, [memoryRecord("mem_log_failure", "project", "Use quiet verification")]);
	const harness = createHarness({
		home,
		now: () => new Date("2026-07-09T12:30:00.000Z"),
		embeddingAdapter: { async embed(request) { return request.texts.map(() => [1, 0]); } },
		appendRecallEvent: async () => { throw new Error("disk full"); },
	});
	const ctx = harness.ctx(cwd);
	await startSession(harness, ctx);
	const recalled = await beforeAgentStart(harness, ctx, "quiet verification");

	assert.match(recalled?.systemPrompt ?? "", /mem_log_failure/);
	assert.equal(readMemoryRecords(join(root, "memories.jsonl")).at(-1)?.recalled, 1);
	assert.match(harness.statuses.at(-1)?.value ?? "", /mem: ready .* warning/);
	assert.match(harness.notifications.at(-1)?.message ?? "", /audit log could not be written: disk full/);
	assert.equal(existsSync(join(root, "recall-log.jsonl")), false);
	await runCommand(harness, "status", ctx);
	assert.match(harness.notifications.at(-1)?.message ?? "", /Last recall warning:.*disk full/);
});

test("before_agent_start injects project-first advisory recall and logs IDs without session messages", async (t) => {
	const cwd = makeProject(t);
	const home = makeTempDirectory(t, "pi-agent-memory-home-");
	writeMemoryRecords(join(cwd, ".pi", "agent-memory"), [
		memoryRecord("mem_project_quiet", "project", "Use scripts/run_silent.sh for quiet verification"),
		memoryRecord("mem_project_gate", "project", "Run the project verification gate after focused tests"),
	]);
	writeMemoryRecords(join(home, ".pi", "agent-memory"), [
		memoryRecord("mem_global_small", "global", "Prefer small reversible verification changes"),
	]);
	const embeddingRequests: MemoryEmbeddingRequest[] = [];
	const harness = createHarness({
		home,
		now: () => new Date("2026-07-09T13:00:00.000Z"),
		embeddingAdapter: {
			async embed(request) {
				embeddingRequests.push(request);
				return request.texts.map(() => [1, 0]);
			},
		},
	});
	const ctx = harness.ctx(cwd);
	await startSession(harness, ctx);
	const entriesBefore = structuredClone(harness.sessionEntries);

	const result = await beforeAgentStart(harness, ctx, "How should I run verification for this change?");

	assert.ok(result);
	assert.match(result.systemPrompt, /^BASE SYSTEM\n\nAgent Memory/);
	assert.match(result.systemPrompt, /advisory/i);
	assert.match(result.systemPrompt, /system instructions, the user request, AGENTS\.md, PRD\/design, and task briefs/i);
	assert.ok(result.systemPrompt.indexOf("[project/workflow]") < result.systemPrompt.indexOf("[global/workflow]"));
	assert.ok(result.systemPrompt.indexOf("mem_project_quiet") < result.systemPrompt.indexOf("mem_global_small"));
	assert.equal(embeddingRequests.length, 1);
	assert.equal(embeddingRequests[0]?.model, "mxbai-embed-large");
	assert.equal(embeddingRequests[0]?.baseUrl, "http://127.0.0.1:11435");
	assert.deepEqual(embeddingRequests[0]?.texts, [
		"How should I run verification for this change?",
		"Use scripts/run_silent.sh for quiet verification",
		"Run the project verification gate after focused tests",
		"Prefer small reversible verification changes",
	]);
	assert.deepEqual(harness.statuses.slice(-2), [
		{ key: "agent-memory", value: "mem: recalling" },
		{ key: "agent-memory", value: "mem: ready · project 2 · global 1" },
	]);
	assert.deepEqual(harness.sessionEntries, entriesBefore);
	assert.equal(harness.sentMessages.length, 0);

	const [log] = readJsonLines(join(cwd, ".pi", "agent-memory", "recall-log.jsonl")) as Array<{
		status: string;
		matchedIds: string[];
		injectedIds: string[];
		items: Array<{ id: string; scope: string; lesson: string }>;
	}>;
	assert.equal(log?.status, "ready");
	assert.deepEqual(log?.matchedIds.slice(0, 2).sort(), ["mem_project_gate", "mem_project_quiet"]);
	assert.equal(log?.matchedIds[2], "mem_global_small");
	assert.deepEqual(log?.injectedIds, log?.matchedIds);
	assert.deepEqual(log?.items.map((item) => item.scope), ["project", "project", "global"]);
	assert.match(log?.items.find((item) => item.id === "mem_project_quiet")?.lesson ?? "", /run_silent/);
});

test("passed verification boosts only the active memory recalled by the same project task", async (t) => {
	const cwd = makeProject(t);
	const otherProject = makeProject(t);
	const home = makeTempDirectory(t, "pi-agent-memory-home-");
	const projectRoot = join(cwd, ".pi", "agent-memory");
	writeMemoryRecords(projectRoot, [
		memoryRecord("mem_project_1", "project", "Use quiet verification for this task"),
		memoryRecord("mem_unrelated", "project", "Use dashboard colors for navigation"),
	]);
	const harness = createHarness({
		home,
		now: () => new Date("2026-07-09T13:00:00.000Z"),
		embeddingAdapter: {
			async embed(request) {
				return request.texts.map((text) => text.includes("dashboard") ? [0, 1] : [1, 0]);
			},
		},
	});
	const ctx = harness.ctx(cwd);
	await startSession(harness, ctx);

	const recalled = await beforeAgentStart(harness, ctx, "How should I run quiet verification?");
	assert.match(recalled?.systemPrompt ?? "", /mem_project_1/);
	assert.doesNotMatch(recalled?.systemPrompt ?? "", /mem_unrelated/);

	await harness.emitEvent(VERIFICATION_OUTCOME_EVENT, verificationOutcome(otherProject, "passed"));
	const beforeMatchingOutcome = readMemoryRecords(join(projectRoot, "memories.jsonl"));
	assert.equal(beforeMatchingOutcome.at(-1)?.passed, 0, "another project must not consume or score the pending recall");
	assert.equal(beforeMatchingOutcome.at(-1)?.lastRecalledAt, "2026-07-09T13:00:00.000Z");

	await harness.emitEvent(VERIFICATION_OUTCOME_EVENT, verificationOutcome(cwd, "passed"));
	const records = readMemoryRecords(join(projectRoot, "memories.jsonl"));
	const latest = new Map(records.map((record) => [record.id, record]));
	assert.equal(latest.get("mem_project_1")?.recalled, 1);
	assert.equal(latest.get("mem_project_1")?.passed, 1);
	assert.equal(latest.get("mem_project_1")?.failed, 0);
	assert.ok((latest.get("mem_project_1")?.confidence ?? 0) > 0);
	assert.equal(latest.get("mem_project_1")?.revision?.action, "verification-pass");
	assert.match(latest.get("mem_project_1")?.revision?.commandRef ?? "", /bash scripts\/verify\.sh/);
	assert.equal(latest.get("mem_unrelated")?.passed, 0);
	assert.equal(latest.get("mem_unrelated")?.confidence, 0);

	await harness.emitEvent(VERIFICATION_OUTCOME_EVENT, verificationOutcome(cwd, "passed"));
	assert.equal(
		readMemoryRecords(join(projectRoot, "memories.jsonl")).filter((record) => record.id === "mem_project_1").length,
		3,
		"one recall revision and one verification revision must be appended at most once",
	);
	assert.equal(existsSync(join(home, ".pi", "agent-memory", "memories.jsonl")), false);
});

test("fire-and-forget verification is drained before commands and listener ownership follows the session", async (t) => {
	const cwd = makeProject(t);
	const home = makeTempDirectory(t, "pi-agent-memory-home-");
	const root = join(cwd, ".pi", "agent-memory");
	writeMemoryRecords(root, [memoryRecord("mem_async_feedback", "project", "Use verification")]);
	const harness = createHarness({
		home,
		now: () => new Date("2026-07-09T13:00:00.000Z"),
		embeddingAdapter: { async embed(request) { return request.texts.map(() => [1, 0]); } },
	});
	const ctx = harness.ctx(cwd);
	await startSession(harness, ctx);
	assert.equal(harness.eventBusHandlerCount(VERIFICATION_OUTCOME_EVENT), 1);
	await startSession(harness, ctx);
	assert.equal(harness.eventBusHandlerCount(VERIFICATION_OUTCOME_EVENT), 1, "session restart must replace the listener");
	await beforeAgentStart(harness, ctx, "verification");

	harness.emitEventFireAndForget(VERIFICATION_OUTCOME_EVENT, verificationOutcome(cwd, "passed", { trigger: "manual" }));
	harness.emitEventFireAndForget(VERIFICATION_OUTCOME_EVENT, verificationOutcome(cwd, "passed"));
	await runCommand(harness, "review", ctx);
	assert.equal(readMemoryRecords(join(root, "memories.jsonl")).at(-1)?.passed, 1);

	const shutdown = harness.events.get("session_shutdown");
	assert.ok(shutdown);
	await shutdown({}, ctx);
	assert.equal(harness.eventBusHandlerCount(VERIFICATION_OUTCOME_EVENT), 0);
});

test("project memory and verification correlate from a repository subdirectory", async (t) => {
	const project = makeProject(t);
	const cwd = join(project, "packages", "app");
	const home = makeTempDirectory(t, "pi-agent-memory-home-");
	mkdirSync(join(project, "scripts"), { recursive: true });
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(project, "scripts", "verify.sh"), "#!/bin/sh\nexit 0\n", "utf8");
	writeMemoryRecords(join(project, ".pi", "agent-memory"), [
		memoryRecord("mem_project_root", "project", "Run root verification"),
	]);
	const harness = createHarness({
		home,
		now: () => new Date("2026-07-09T13:00:00.000Z"),
		embeddingAdapter: { async embed(request) { return request.texts.map(() => [1, 0]); } },
	});
	const ctx = harness.ctx(cwd);
	await startSession(harness, ctx);
	assert.match((await beforeAgentStart(harness, ctx, "root verification"))?.systemPrompt ?? "", /mem_project_root/);
	await harness.emitEvent(VERIFICATION_OUTCOME_EVENT, verificationOutcome(project, "passed"));

	assert.equal(readMemoryRecords(join(project, ".pi", "agent-memory", "memories.jsonl")).at(-1)?.passed, 1);
	assert.equal(existsSync(join(cwd, ".pi", "agent-memory")), false);
});

test("failed verification weakens recalled memories and creates only a redacted project review candidate", async (t) => {
	const cwd = makeProject(t);
	const home = makeTempDirectory(t, "pi-agent-memory-home-");
	const projectRoot = join(cwd, ".pi", "agent-memory");
	const globalRoot = join(home, ".pi", "agent-memory");
	writeMemoryRecords(projectRoot, [
		memoryRecord("mem_project_used", "project", "Run the verification gate before completion"),
	]);
	writeMemoryRecords(globalRoot, [
		memoryRecord("mem_global_used", "global", "Prefer verification before completion"),
	]);
	const harness = createHarness({
		home,
		createId: () => "mem_failure_candidate",
		now: () => new Date("2026-07-09T13:00:00.000Z"),
		embeddingAdapter: { async embed(request) { return request.texts.map(() => [1, 0]); } },
	});
	const ctx = harness.ctx(cwd);
	await startSession(harness, ctx);
	const recalled = await beforeAgentStart(harness, ctx, "verification before completion");
	assert.match(recalled?.systemPrompt ?? "", /mem_project_used/);
	assert.match(recalled?.systemPrompt ?? "", /mem_global_used/);

	await harness.emitEvent(VERIFICATION_OUTCOME_EVENT, verificationOutcome(cwd, "failed", {
		command: "bash scripts/verify.sh token=secret-value",
		failureSummary: "RAW FAILURE OUTPUT: customer Acme secret-value",
	}));

	const projectRecords = readMemoryRecords(join(projectRoot, "memories.jsonl"));
	const projectLatest = new Map(projectRecords.map((record) => [record.id, record]));
	const scored = projectLatest.get("mem_project_used");
	assert.equal(scored?.failed, 1);
	assert.equal(scored?.passed, 0);
	assert.ok((scored?.confidence ?? 0) < 0);
	assert.equal(scored?.revision?.action, "verification-fail");

	const candidate = projectLatest.get("mem_failure_candidate");
	assert.equal(candidate?.scope, "project");
	assert.equal(candidate?.type, "gotcha");
	assert.equal(candidate?.status, "candidate");
	assert.equal(candidate?.sourceKind, "verification");
	assert.equal(candidate?.safety.explicitScopeApproval, false);
	assert.match(candidate?.reviewOnlyReason ?? "", /failure-only.*review/i);
	assert.match(candidate?.lesson ?? "", /\[REDACTED\]/);
	assert.doesNotMatch(candidate?.lesson ?? "", /secret-value|RAW FAILURE OUTPUT|customer Acme/);
	assert.doesNotMatch(readFileSync(join(projectRoot, "memories.jsonl"), "utf8"), /secret-value|RAW FAILURE OUTPUT|customer Acme/);

	const globalRecords = readMemoryRecords(join(globalRoot, "memories.jsonl"));
	const globalLatest = new Map(globalRecords.map((record) => [record.id, record]));
	assert.deepEqual([...globalLatest.keys()], ["mem_global_used"], "verification must never create a hidden global candidate");
	assert.equal(globalLatest.get("mem_global_used")?.failed, 1);
	assert.ok((globalLatest.get("mem_global_used")?.confidence ?? 0) < 0);
	assert.doesNotMatch(readFileSync(join(globalRoot, "memories.jsonl"), "utf8"), /secret-value|RAW FAILURE OUTPUT|customer Acme/);
});

test("verification with no recalled IDs or disabled memory changes no scores and creates no candidate", async (t) => {
	const emptyCwd = makeProject(t);
	const emptyHome = makeTempDirectory(t, "pi-agent-memory-home-");
	const emptyHarness = createHarness({ home: emptyHome, createId: () => "unexpected_candidate" });
	const emptyCtx = emptyHarness.ctx(emptyCwd);
	await startSession(emptyHarness, emptyCtx);
	assert.equal(await beforeAgentStart(emptyHarness, emptyCtx, "verification"), undefined);
	await emptyHarness.emitEvent(VERIFICATION_OUTCOME_EVENT, verificationOutcome(emptyCwd, "failed"));
	assert.equal(existsSync(join(emptyCwd, ".pi", "agent-memory", "memories.jsonl")), false);
	assert.equal(existsSync(join(emptyHome, ".pi", "agent-memory", "memories.jsonl")), false);

	const disabledCwd = makeProject(t);
	const disabledHome = makeTempDirectory(t, "pi-agent-memory-home-");
	const disabledRoot = join(disabledCwd, ".pi", "agent-memory");
	writeMemoryRecords(disabledRoot, [memoryRecord("mem_disabled", "project", "Use verification")]);
	const disabledHarness = createHarness({
		home: disabledHome,
		createId: () => "unexpected_disabled_candidate",
		embeddingAdapter: { async embed(request) { return request.texts.map(() => [1, 0]); } },
	});
	const disabledCtx = disabledHarness.ctx(disabledCwd);
	await startSession(disabledHarness, disabledCtx);
	assert.match((await beforeAgentStart(disabledHarness, disabledCtx, "verification"))?.systemPrompt ?? "", /mem_disabled/);
	await runCommand(disabledHarness, "disable", disabledCtx);
	await disabledHarness.emitEvent(VERIFICATION_OUTCOME_EVENT, verificationOutcome(disabledCwd, "failed"));
	const disabledRecords = readMemoryRecords(join(disabledRoot, "memories.jsonl"));
	assert.deepEqual(new Set(disabledRecords.map((record) => record.id)), new Set(["mem_disabled"]));
	assert.equal(disabledRecords.at(-1)?.failed, 0);
	assert.equal(disabledRecords.at(-1)?.recalled, 1);
	assert.equal(existsSync(join(disabledHome, ".pi", "agent-memory", "memories.jsonl")), false);
});

test("verification never revives or scores a recalled revision that became inactive", async (t) => {
	const cwd = makeProject(t);
	const home = makeTempDirectory(t, "pi-agent-memory-home-");
	const root = join(cwd, ".pi", "agent-memory");
	const active = memoryRecord("mem_archived_after_recall", "project", "Use verification");
	writeMemoryRecords(root, [active]);
	const harness = createHarness({
		home,
		embeddingAdapter: { async embed(request) { return request.texts.map(() => [1, 0]); } },
	});
	const ctx = harness.ctx(cwd);
	await startSession(harness, ctx);
	assert.match((await beforeAgentStart(harness, ctx, "verification"))?.systemPrompt ?? "", /mem_archived_after_recall/);
	const archived: MemoryRecord = {
		...active,
		status: "archived",
		updatedAt: "2026-07-09T13:00:30.000Z",
		revision: {
			action: "archive",
			commandRef: "/agent-memory archive project mem_archived_after_recall",
			previousUpdatedAt: active.updatedAt,
		},
	};
	writeFileSync(join(root, "memories.jsonl"), `${JSON.stringify(archived)}\n`, { encoding: "utf8", flag: "a" });

	await harness.emitEvent(VERIFICATION_OUTCOME_EVENT, verificationOutcome(cwd, "passed"));
	const records = readMemoryRecords(join(root, "memories.jsonl"));
	assert.equal(records.length, 3);
	assert.equal(records.at(-1)?.status, "archived");
	assert.equal(records.at(-1)?.passed, 0);
});

test("verification does not score recalled content after an active edit", async (t) => {
	const cwd = makeProject(t);
	const home = makeTempDirectory(t, "pi-agent-memory-home-");
	const root = join(cwd, ".pi", "agent-memory");
	writeMemoryRecords(root, [memoryRecord("mem_edited_after_recall", "project", "Use old verification guidance")]);
	const harness = createHarness({
		home,
		now: () => new Date("2026-07-09T13:00:00.000Z"),
		embeddingAdapter: { async embed(request) { return request.texts.map(() => [1, 0]); } },
	});
	const ctx = harness.ctx(cwd);
	await startSession(harness, ctx);
	await beforeAgentStart(harness, ctx, "old verification guidance");
	await runCommand(harness, 'edit project mem_edited_after_recall "Use new verification guidance"', ctx);
	await harness.emitEvent(VERIFICATION_OUTCOME_EVENT, verificationOutcome(cwd, "passed"));

	const latest = readMemoryRecords(join(root, "memories.jsonl")).at(-1);
	assert.equal(latest?.lesson, "Use new verification guidance");
	assert.equal(latest?.revision?.action, "edit");
	assert.equal(latest?.passed, 0);
});

test("embedding setup failure is visible, reviewable, and does not block the task", async (t) => {
	const cwd = makeProject(t);
	const home = makeTempDirectory(t, "pi-agent-memory-home-");
	writeMemoryRecords(join(cwd, ".pi", "agent-memory"), [
		memoryRecord("mem_project_failure", "project", "Use quiet verification"),
	]);
	const harness = createHarness({
		home,
		now: () => new Date("2026-07-09T13:02:00.000Z"),
		embeddingAdapter: {
			async embed() {
				throw new Error('model "mxbai-embed-large" not found');
			},
		},
	});
	const ctx = harness.ctx(cwd);
	await startSession(harness, ctx);
	const entriesBefore = structuredClone(harness.sessionEntries);

	const result = await beforeAgentStart(harness, ctx, "How should I run verification?");

	assert.equal(result, undefined, "failed recall must leave the system prompt unchanged and let the task continue");
	assert.deepEqual(harness.statuses.slice(-2), [
		{ key: "agent-memory", value: "mem: recalling" },
		{ key: "agent-memory", value: "mem: failed · embeddings unavailable · /agent-memory status" },
	]);
	assert.deepEqual(harness.sessionEntries, entriesBefore);
	assert.equal(harness.sentMessages.length, 0);

	const [log] = readJsonLines(join(cwd, ".pi", "agent-memory", "recall-log.jsonl")) as Array<{
		status: string;
		matchedIds: string[];
		injectedIds: string[];
		failure?: {
			code: string;
			reason: string;
			embeddingModel: string;
			generationModel: string;
			recovery: string[];
			cloudFallback: string;
		};
	}>;
	assert.equal(log?.status, "failed");
	assert.deepEqual(log?.matchedIds, []);
	assert.deepEqual(log?.injectedIds, []);
	assert.equal(log?.failure?.code, "embedding-model-unavailable");
	assert.match(log?.failure?.reason ?? "", /model .*mxbai-embed-large.* not found/i);
	assert.equal(log?.failure?.embeddingModel, "mxbai-embed-large");
	assert.equal(log?.failure?.generationModel, "qwen2.5-coder:14b");
	assert.ok(log?.failure?.recovery.some((step) => step.includes("ssh -f -N") && step.includes("127.0.0.1:11435")));
	assert.ok(log?.failure?.recovery.includes("ssh charleshippo@otto ollama pull mxbai-embed-large"));
	assert.equal(log?.failure?.cloudFallback, "disabled");

	await runCommand(harness, "status", ctx);
	assert.equal(harness.statuses.at(-1)?.value, "mem: failed · embeddings unavailable · /agent-memory status");
	assert.equal(harness.notifications.at(-1)?.level, "error");
	const details = harness.notifications.at(-1)?.message ?? "";
	assert.match(details, /Agent Memory recall failed/i);
	assert.match(details, /no memory pack was injected/i);
	assert.match(details, /mxbai-embed-large/);
	assert.match(details, /qwen2\.5-coder:14b/);
	assert.match(details, /ollama pull mxbai-embed-large/);
	assert.match(details, /charleshippo@otto/);
	assert.match(details, /cloud fallback: disabled/i);
});

test("unavailable Ollama and local recall setup errors use distinct failed reasons", async (t) => {
	const home = makeTempDirectory(t, "pi-agent-memory-home-");
	const unavailableCwd = makeProject(t);
	writeMemoryRecords(join(unavailableCwd, ".pi", "agent-memory"), [
		memoryRecord("mem_project_unavailable", "project", "Use quiet verification"),
	]);
	const unavailable = createHarness({
		home,
		embeddingAdapter: { async embed() { throw new Error("fetch failed: ECONNREFUSED"); } },
	});
	const unavailableCtx = unavailable.ctx(unavailableCwd);
	await startSession(unavailable, unavailableCtx);

	assert.equal(await beforeAgentStart(unavailable, unavailableCtx, "verification"), undefined);
	const [unavailableLog] = readJsonLines(join(unavailableCwd, ".pi", "agent-memory", "recall-log.jsonl")) as Array<{
		status: string;
		failure?: { code: string; reason: string };
	}>;
	assert.equal(unavailableLog?.status, "failed");
	assert.equal(unavailableLog?.failure?.code, "ollama-unavailable");
	assert.match(unavailableLog?.failure?.reason ?? "", /ECONNREFUSED/);

	const brokenCacheCwd = makeProject(t);
	const brokenCacheRoot = join(brokenCacheCwd, ".pi", "agent-memory");
	writeMemoryRecords(brokenCacheRoot, [
		memoryRecord("mem_project_broken_cache", "project", "Use quiet verification"),
	]);
	writeFileSync(join(brokenCacheRoot, "vectors.json"), "not-json\n", "utf8");
	let embeddingCalls = 0;
	const brokenCache = createHarness({
		home,
		embeddingAdapter: { async embed() { embeddingCalls++; return []; } },
	});
	const brokenCacheCtx = brokenCache.ctx(brokenCacheCwd);
	await startSession(brokenCache, brokenCacheCtx);

	assert.equal(await beforeAgentStart(brokenCache, brokenCacheCtx, "verification"), undefined);
	const [setupLog] = readJsonLines(join(brokenCacheCwd, ".pi", "agent-memory", "recall-log.jsonl")) as Array<{
		status: string;
		failure?: { code: string; reason: string };
	}>;
	assert.equal(setupLog?.status, "failed");
	assert.equal(setupLog?.failure?.code, "recall-setup-failed");
	assert.match(setupLog?.failure?.reason ?? "", /Unexpected token|JSON/i);
	assert.equal(embeddingCalls, 0, "broken local setup should fail before an embedding request");
});

test("paused or disabled memory does not run embedding setup checks", async (t) => {
	const cwd = makeProject(t);
	const home = makeTempDirectory(t, "pi-agent-memory-home-");
	writeMemoryRecords(join(cwd, ".pi", "agent-memory"), [
		memoryRecord("mem_project_skip_health", "project", "Use quiet verification"),
	]);
	let embeddingCalls = 0;
	const harness = createHarness({
		home,
		embeddingAdapter: {
			async embed() {
				embeddingCalls++;
				throw new Error("setup check should have been skipped");
			},
		},
	});
	const ctx = harness.ctx(cwd);
	await startSession(harness, ctx);

	await runCommand(harness, "pause", ctx);
	assert.equal(await beforeAgentStart(harness, ctx, "verification while paused"), undefined);
	assert.equal(harness.statuses.at(-1)?.value, "mem: paused");

	await runCommand(harness, "disable", ctx);
	assert.equal(await beforeAgentStart(harness, ctx, "verification while disabled"), undefined);
	assert.equal(harness.statuses.at(-1)?.value, "mem: disabled");
	assert.equal(embeddingCalls, 0);
	assert.equal(existsSync(join(cwd, ".pi", "agent-memory", "recall-log.jsonl")), false);
});

test("an empty active store stays no-match without an embedding health call", async (t) => {
	const cwd = makeProject(t);
	const home = makeTempDirectory(t, "pi-agent-memory-home-");
	let embeddingCalls = 0;
	const harness = createHarness({
		home,
		now: () => new Date("2026-07-09T13:04:00.000Z"),
		embeddingAdapter: {
			async embed() {
				embeddingCalls++;
				throw new Error("empty memory should not require Ollama");
			},
		},
	});
	const ctx = harness.ctx(cwd);
	await startSession(harness, ctx);

	assert.equal(await beforeAgentStart(harness, ctx, "verification"), undefined);
	assert.equal(embeddingCalls, 0);
	assert.equal(harness.statuses.at(-1)?.value, "mem: ready · no matches");
	const [log] = readJsonLines(join(cwd, ".pi", "agent-memory", "recall-log.jsonl")) as Array<{ status: string }>;
	assert.equal(log?.status, "no-match");
});

test("recall reports a visible no-match state without injecting or sending messages", async (t) => {
	const cwd = makeProject(t);
	const home = makeTempDirectory(t, "pi-agent-memory-home-");
	writeMemoryRecords(join(cwd, ".pi", "agent-memory"), [
		memoryRecord("mem_project_css", "project", "Use grid for the dashboard layout"),
	]);
	const harness = createHarness({
		home,
		now: () => new Date("2026-07-09T13:05:00.000Z"),
		embeddingAdapter: {
			async embed(request) {
				return request.texts.map((_text, index) => index === 0 ? [1, 0] : [0, 1]);
			},
		},
	});
	const ctx = harness.ctx(cwd);
	await startSession(harness, ctx);

	const result = await beforeAgentStart(harness, ctx, "Investigate database transaction retries");

	assert.equal(result, undefined);
	assert.deepEqual(harness.statuses.slice(-2), [
		{ key: "agent-memory", value: "mem: recalling" },
		{ key: "agent-memory", value: "mem: ready · no matches" },
	]);
	assert.equal(harness.sentMessages.length, 0);
	const [log] = readJsonLines(join(cwd, ".pi", "agent-memory", "recall-log.jsonl")) as Array<{
		status: string;
		matchedIds: string[];
		injectedIds: string[];
	}>;
	assert.deepEqual(log, {
		schemaVersion: 1,
		timestamp: "2026-07-09T13:05:00.000Z",
		status: "no-match",
		matchedIds: [],
		injectedIds: [],
		items: [],
		counts: { project: 0, global: 0 },
	});
});

test("recall enforces project/global item caps and the total prompt-pack character budget", async (t) => {
	const cwd = makeProject(t);
	const home = makeTempDirectory(t, "pi-agent-memory-home-");
	writeMemoryRecords(join(cwd, ".pi", "agent-memory"), Array.from({ length: 5 }, (_unused, index) =>
		memoryRecord(`mem_project_${index}`, "project", `Verification workflow project lesson ${index}`)));
	writeMemoryRecords(join(home, ".pi", "agent-memory"), Array.from({ length: 3 }, (_unused, index) =>
		memoryRecord(`mem_global_${index}`, "global", `Verification workflow global lesson ${index}`)));
	const harness = createHarness({
		home,
		embeddingAdapter: { async embed(request) { return request.texts.map(() => [1, 0]); } },
	});
	const ctx = harness.ctx(cwd);
	await startSession(harness, ctx);

	const capped = await beforeAgentStart(harness, ctx, "verification workflow");

	assert.ok(capped);
	const cappedPack = capped.systemPrompt.slice("BASE SYSTEM\n\n".length);
	assert.ok(cappedPack.length <= 3000, `expected <= 3000 chars, got ${cappedPack.length}`);
	assert.equal((cappedPack.match(/\[project\/workflow\]/g) ?? []).length, 4);
	assert.equal((cappedPack.match(/\[global\/workflow\]/g) ?? []).length, 2);
	assert.doesNotMatch(cappedPack, /mem_project_4|mem_global_2/);

	const hugeCwd = makeProject(t);
	writeMemoryRecords(join(hugeCwd, ".pi", "agent-memory"), [
		memoryRecord("mem_huge", "project", `verification ${"x".repeat(5000)}`),
	]);
	const hugeCtx = harness.ctx(hugeCwd);
	await startSession(harness, hugeCtx);
	const huge = await beforeAgentStart(harness, hugeCtx, "verification");
	assert.ok(huge);
	assert.ok(huge.systemPrompt.slice("BASE SYSTEM\n\n".length).length <= 3000);
	assert.match(huge.systemPrompt, /mem_huge/);
});

test("recall resolves latest record state and never embeds inactive or tombstoned lessons", async (t) => {
	const cwd = makeProject(t);
	const home = makeTempDirectory(t, "pi-agent-memory-home-");
	const archived = { ...memoryRecord("mem_archived", "project", "old active lesson"), status: "archived", updatedAt: "2026-07-09T10:00:00.000Z" };
	writeMemoryRecords(join(cwd, ".pi", "agent-memory"), [
		memoryRecord("mem_archived", "project", "old active lesson"),
		archived,
		{ ...memoryRecord("mem_candidate", "project", "candidate lesson"), status: "candidate" },
		{ ...memoryRecord("mem_deleted", "project", "deleted lesson"), status: "deleted" },
		{ ...memoryRecord("mem_rejected", "project", "rejected lesson"), status: "rejected" },
		{ ...memoryRecord("mem_reset", "project", "reset lesson"), status: "reset" },
		memoryRecord("mem_active", "project", "active verification lesson"),
	]);
	const embeddedTexts: string[][] = [];
	const harness = createHarness({
		home,
		embeddingAdapter: {
			async embed(request) {
				embeddedTexts.push(request.texts);
				return request.texts.map(() => [1, 0]);
			},
		},
	});
	const ctx = harness.ctx(cwd);
	await startSession(harness, ctx);

	const result = await beforeAgentStart(harness, ctx, "verification");

	assert.ok(result);
	assert.deepEqual(embeddedTexts, [["verification", "active verification lesson"]]);
	assert.match(result.systemPrompt, /mem_active/);
	assert.doesNotMatch(result.systemPrompt, /mem_archived|mem_candidate|mem_deleted|mem_rejected|mem_reset/);
});

test("review explains recent influence and archive/restore revisions control later recall", async (t) => {
	const cwd = makeProject(t);
	const home = makeTempDirectory(t, "pi-agent-memory-home-");
	const projectRoot = join(cwd, ".pi", "agent-memory");
	writeMemoryRecords(projectRoot, [
		memoryRecord("mem_reviewed", "project", "Use quiet verification for focused checks"),
		{
			...memoryRecord("mem_candidate", "project", "Use the redacted credential [REDACTED]"),
			status: "candidate",
			redacted: true,
			reviewOnlyReason: "Approve the redacted final text before recall.",
		},
	]);
	const harness = createHarness({
		home,
		now: () => new Date("2026-07-09T14:00:00.000Z"),
		embeddingAdapter: { async embed(request) { return request.texts.map(() => [1, 0]); } },
	});
	const ctx = harness.ctx(cwd);
	await startSession(harness, ctx);

	const firstRecall = await beforeAgentStart(harness, ctx, "How should I run quiet verification?");
	assert.match(firstRecall?.systemPrompt ?? "", /mem_reviewed/);
	await runCommand(harness, "review", ctx);

	const initialReview = harness.notifications.at(-1)?.message ?? "";
	assert.match(initialReview, /Agent Memory review/i);
	assert.match(initialReview, /Recent recall and setup events/i);
	assert.match(initialReview, /2026-07-09T14:00:00\.000Z/);
	assert.match(initialReview, /mem_reviewed \[project\/workflow\]/);
	assert.match(initialReview, /source=test:mem_reviewed/);
	assert.match(initialReview, /score=0\.\d+/);
	assert.match(initialReview, /lastRecalledAt:2026-07-09T14:00:00\.000Z/);
	assert.match(initialReview, /archive project mem_reviewed/);
	assert.match(initialReview, /mem_candidate \[project\/workflow\/candidate\]/);
	assert.match(initialReview, /approve project mem_candidate/);
	assert.match(initialReview, /reject project mem_candidate/);

	await runCommand(harness, "archive project mem_reviewed", ctx);
	assert.match(harness.notifications.at(-1)?.message ?? "", /archived/i);
	const archivedRecall = await beforeAgentStart(harness, ctx, "quiet verification");
	assert.equal(archivedRecall, undefined);
	await runCommand(harness, "review", ctx);
	assert.match(harness.notifications.at(-1)?.message ?? "", /mem_reviewed \[project\/workflow\/archived\]/);
	assert.match(harness.notifications.at(-1)?.message ?? "", /restore project mem_reviewed/);

	await runCommand(harness, "restore project mem_reviewed", ctx);
	const restoredRecall = await beforeAgentStart(harness, ctx, "quiet verification");
	assert.match(restoredRecall?.systemPrompt ?? "", /mem_reviewed/);
	const revisions = readMemoryRecords(join(projectRoot, "memories.jsonl"));
	assert.deepEqual(revisions.filter((record) => record.id === "mem_reviewed").map((record) => record.status), [
		"active",
		"active",
		"archived",
		"active",
		"active",
	]);
	assert.deepEqual(
		revisions.filter((record) => record.id === "mem_reviewed").slice(1).map((record) => record.revision?.action),
		["recall", "archive", "restore", "recall"],
	);
});

test("edit, delete, approve, reject, and scoped reset append decisions that recall honors", async (t) => {
	const cwd = makeProject(t);
	const home = makeTempDirectory(t, "pi-agent-memory-home-");
	const projectRoot = join(cwd, ".pi", "agent-memory");
	writeMemoryRecords(projectRoot, [
		memoryRecord("mem_edit", "project", "Old noisy verification guidance"),
		memoryRecord("mem_delete", "project", "Deleted verification guidance"),
		{ ...memoryRecord("mem_approve", "project", "Approved verification guidance"), status: "candidate" },
		{ ...memoryRecord("mem_reject", "project", "Rejected verification guidance"), status: "candidate" },
		memoryRecord("mem_reset", "project", "Reset verification guidance"),
	]);
	const vectorRequests: VectorCacheRequest[] = [];
	const harness = createHarness({
		home,
		now: () => new Date("2026-07-09T14:10:00.000Z"),
		vectorCache: { async request(request) { vectorRequests.push(request); } },
		embeddingAdapter: { async embed(request) { return request.texts.map(() => [1, 0]); } },
	});
	const ctx = harness.ctx(cwd);
	await startSession(harness, ctx);

	await runCommand(harness, 'edit project mem_edit "New focused verification guidance"', ctx);
	await runCommand(harness, "delete project mem_delete", ctx);
	await runCommand(harness, "approve project mem_approve", ctx);
	await runCommand(harness, "reject project mem_reject", ctx);

	const correctedRecall = await beforeAgentStart(harness, ctx, "verification guidance");
	assert.match(correctedRecall?.systemPrompt ?? "", /New focused verification guidance/);
	assert.match(correctedRecall?.systemPrompt ?? "", /mem_approve/);
	assert.match(correctedRecall?.systemPrompt ?? "", /mem_reset/);
	assert.doesNotMatch(
		correctedRecall?.systemPrompt ?? "",
		/Old noisy verification guidance|mem_delete|mem_reject/,
	);
	assert.equal(vectorRequests.at(-1)?.memoryId, "mem_edit");
	assert.equal(vectorRequests.at(-1)?.lesson, "New focused verification guidance");
	assert.notEqual(vectorRequests.at(-1)?.cacheKey, "mxbai-embed-large:mem_edit");

	await runCommand(harness, "reset project", ctx);
	assert.match(harness.notifications.at(-1)?.message ?? "", /reset 3 project memories/i);
	assert.equal(await beforeAgentStart(harness, ctx, "verification guidance"), undefined);

	const records = readMemoryRecords(join(projectRoot, "memories.jsonl"));
	const latest = new Map(records.map((record) => [record.id, record]));
	assert.equal(latest.get("mem_edit")?.status, "reset");
	assert.equal(latest.get("mem_edit")?.revision?.commandRef, "/agent-memory reset project");
	assert.equal(latest.get("mem_delete")?.status, "deleted");
	assert.equal(latest.get("mem_approve")?.status, "reset");
	assert.equal(latest.get("mem_reject")?.status, "rejected");
	assert.equal(latest.get("mem_reset")?.status, "reset");
	assert.equal(latest.get("mem_edit")?.lesson, "New focused verification guidance");

	await runCommand(harness, "restore project mem_reset", ctx);
	assert.equal(harness.notifications.at(-1)?.level, "error");
	assert.match(harness.notifications.at(-1)?.message ?? "", /recreate.*agent-memory add project/i);
	await runCommand(harness, "review", ctx);
	assert.match(harness.notifications.at(-1)?.message ?? "", /add project.*New focused verification guidance/i);
});

test("project-to-global promotion stays candidate until explicit safe-text approval", async (t) => {
	const cwd = makeProject(t);
	const home = makeTempDirectory(t, "pi-agent-memory-home-");
	writeMemoryRecords(join(cwd, ".pi", "agent-memory"), [
		memoryRecord("mem_safe_project", "project", "Prefer focused reversible changes"),
		memoryRecord("mem_client_project", "project", "Client Acme stores config at /Users/acme/private/config.ts"),
	]);
	const ids = ["mem_global_candidate", "mem_client_global_candidate"];
	const harness = createHarness({
		home,
		createId: () => ids.shift() ?? assert.fail("unexpected promotion id"),
		now: () => new Date("2026-07-09T14:20:00.000Z"),
		embeddingAdapter: { async embed(request) { return request.texts.map(() => [1, 0]); } },
	});
	const ctx = harness.ctx(cwd);
	await startSession(harness, ctx);

	await runCommand(harness, "promote mem_safe_project", ctx);
	let globalRecords = readMemoryRecords(join(home, ".pi", "agent-memory", "memories.jsonl"));
	assert.equal(globalRecords.at(-1)?.status, "candidate");
	assert.equal(globalRecords.at(-1)?.scope, "global");
	assert.equal(globalRecords.at(-1)?.promotion?.sourceMemoryId, "mem_safe_project");
	assert.match(harness.notifications.at(-1)?.message ?? "", /approve global mem_global_candidate/);
	const beforeApproval = await beforeAgentStart(harness, ctx, "focused reversible changes");
	assert.doesNotMatch(beforeApproval?.systemPrompt ?? "", /mem_global_candidate/);

	await runCommand(harness, "approve global mem_global_candidate", ctx);
	const afterApproval = await beforeAgentStart(harness, ctx, "focused reversible changes");
	assert.match(afterApproval?.systemPrompt ?? "", /\[global\/workflow\].*mem_global_candidate/);

	await runCommand(harness, "promote mem_client_project", ctx);
	assert.equal(harness.notifications.at(-1)?.level, "warning");
	assert.match(harness.notifications.at(-1)?.message ?? "", /edit global mem_client_global_candidate/i);
	assert.match(harness.notifications.at(-1)?.message ?? "", /path|client/i);
	await runCommand(harness, "approve global mem_client_global_candidate", ctx);
	assert.equal(harness.notifications.at(-1)?.level, "error");
	assert.match(harness.notifications.at(-1)?.message ?? "", /edit.*before approval/i);
	globalRecords = readMemoryRecords(join(home, ".pi", "agent-memory", "memories.jsonl"));
	assert.equal(new Map(globalRecords.map((record) => [record.id, record])).get("mem_client_global_candidate")?.status, "candidate");

	await runCommand(
		harness,
		'edit global mem_client_global_candidate "Prefer repository-relative configuration examples"',
		ctx,
	);
	await runCommand(harness, "approve global mem_client_global_candidate", ctx);
	const generalizedRecall = await beforeAgentStart(harness, ctx, "repository relative configuration examples");
	assert.match(generalizedRecall?.systemPrompt ?? "", /\[global\/workflow\].*mem_client_global_candidate/);
	const generalizedGlobalLine = generalizedRecall?.systemPrompt
		.split("\n")
		.find((line) => line.includes("mem_client_global_candidate")) ?? "";
	assert.doesNotMatch(generalizedGlobalLine, /Client Acme|\/Users\/acme/);
});

test("review renders failed recall events as setup evidence with recovery", async (t) => {
	const cwd = makeProject(t);
	const home = makeTempDirectory(t, "pi-agent-memory-home-");
	writeMemoryRecords(join(cwd, ".pi", "agent-memory"), [
		memoryRecord("mem_setup_failure", "project", "Use quiet verification"),
	]);
	const harness = createHarness({
		home,
		now: () => new Date("2026-07-09T14:30:00.000Z"),
		embeddingAdapter: { async embed() { throw new Error('model "mxbai-embed-large" not found'); } },
	});
	const ctx = harness.ctx(cwd);
	await startSession(harness, ctx);
	await beforeAgentStart(harness, ctx, "verification");

	await runCommand(harness, "review", ctx);
	const review = harness.notifications.at(-1)?.message ?? "";
	assert.match(review, /setup evidence/i);
	assert.match(review, /embedding-model-unavailable/);
	assert.match(review, /model .*mxbai-embed-large.* not found/i);
	assert.match(review, /ollama pull mxbai-embed-large/);
	assert.match(review, /cloud fallback=disabled/i);
});

test("fake Pi session exposes default-on status and every control without injecting context", async (t) => {
	const cwd = makeProject(t);
	const harness = createHarness();
	const ctx = harness.ctx(cwd);

	await startSession(harness, ctx);
	assert.deepEqual(harness.statuses.at(-1), { key: "agent-memory", value: "mem: running" });
	assert.match(harness.notifications.at(-1)?.message ?? "", /project \+ global/i);
	assert.match(harness.notifications.at(-1)?.message ?? "", /\.pi\/agent-memory/);
	assert.match(harness.notifications.at(-1)?.message ?? "", /configured user-controlled Ollama endpoint/i);
	assert.match(harness.notifications.at(-1)?.message ?? "", /\/agent-memory pause/);
	assert.equal(existsSync(join(cwd, ".pi", "agent-memory")), false, "session start must not create memory state");

	await runCommand(harness, "pause later", ctx);
	assert.equal(harness.notifications.at(-1)?.level, "error");
	assert.match(harness.notifications.at(-1)?.message ?? "", /Usage: \/agent-memory/);
	assert.equal(harness.statuses.at(-1)?.value, "mem: running");

	await runCommand(harness, "status", ctx);
	assert.match(harness.notifications.at(-1)?.message ?? "", /Agent Memory is running/i);
	await runCommand(harness, "pause", ctx);
	assert.deepEqual(harness.statuses.at(-1), { key: "agent-memory", value: "mem: paused" });
	assert.match(harness.notifications.at(-1)?.message ?? "", /\/agent-memory resume/);
	await runCommand(harness, "resume", ctx);
	assert.deepEqual(harness.statuses.at(-1), { key: "agent-memory", value: "mem: running" });
	await runCommand(harness, "disable", ctx);
	assert.deepEqual(harness.statuses.at(-1), { key: "agent-memory", value: "mem: disabled" });
	assert.match(harness.notifications.at(-1)?.message ?? "", /\/agent-memory enable/);
	await runCommand(harness, "enable", ctx);
	assert.deepEqual(harness.statuses.at(-1), { key: "agent-memory", value: "mem: running" });
	await runCommand(harness, "reset", ctx);
	assert.match(harness.notifications.at(-1)?.message ?? "", /reset/i);

	assert.deepEqual([...harness.events.keys()], ["session_start", "session_shutdown", "before_agent_start"]);
	await runCommand(harness, "pause", ctx);
	assert.equal(await beforeAgentStart(harness, ctx, "This prompt must not recall while paused"), undefined);
	assert.equal(harness.statuses.at(-1)?.value, "mem: paused");
	assert.equal(harness.sentMessages.length, 0);
});

test("disable persists across sessions while pause stays session-local", async (t) => {
	const cwd = makeProject(t);
	const first = createHarness();
	await startSession(first, first.ctx(cwd));
	await runCommand(first, "pause", first.ctx(cwd));
	assert.equal(first.statuses.at(-1)?.value, "mem: paused");

	const second = createHarness();
	await startSession(second, second.ctx(cwd));
	assert.equal(second.statuses.at(-1)?.value, "mem: running");
	await runCommand(second, "disable", second.ctx(cwd));

	const settingsPath = join(cwd, ".pi", "agent-memory", "settings.json");
	assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { schemaVersion: 1, enabled: false });

	const third = createHarness();
	await startSession(third, third.ctx(cwd));
	assert.equal(third.statuses.at(-1)?.value, "mem: disabled");
	await runCommand(third, "enable", third.ctx(cwd));
	await runCommand(third, "pause", third.ctx(cwd));

	const fourth = createHarness();
	await startSession(fourth, fourth.ctx(cwd));
	assert.equal(fourth.statuses.at(-1)?.value, "mem: running");
});

test("reset restores controls without deleting future memory data", async (t) => {
	const cwd = makeProject(t);
	const memoryDir = join(cwd, ".pi", "agent-memory");
	const memoriesPath = join(memoryDir, "memories.jsonl");
	mkdirSync(memoryDir, { recursive: true });
	writeFileSync(memoriesPath, "future-memory-sentinel\n", "utf8");

	const harness = createHarness();
	const ctx = harness.ctx(cwd);
	await startSession(harness, ctx);
	await runCommand(harness, "disable", ctx);
	await runCommand(harness, "reset", ctx);

	assert.equal(readFileSync(memoriesPath, "utf8"), "future-memory-sentinel\n");
	assert.deepEqual(JSON.parse(readFileSync(join(memoryDir, "settings.json"), "utf8")), {
		schemaVersion: 1,
		enabled: true,
	});
	assert.equal(harness.statuses.at(-1)?.value, "mem: running");
	assert.match(harness.notifications.at(-1)?.message ?? "", /no memory records were changed/i);
});

test("checked-in model configuration preserves local remote-Ollama defaults", () => {
	const config = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
	assert.equal(config.modelHost.kind, "user-controlled-remote-ollama");
	assert.equal(config.tunnel.sshTarget, "charleshippo@otto");
	assert.equal(config.tunnel.localPort, 11435);
	assert.equal(config.ollama.baseUrl, "http://127.0.0.1:11435");
	assert.equal(config.ollama.embeddingModel, "mxbai-embed-large");
	assert.equal(config.ollama.generationModel, "qwen2.5-coder:14b");
	assert.equal(config.failurePolicy.cloudFallback, "disabled");
});
