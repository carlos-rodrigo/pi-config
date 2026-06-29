import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import archiveExtension, {
	appendArchiveRecord,
	buildArchiveGuidance,
	formatArchiveReport,
	formatImprovementProposal,
	getArchivePath,
	readArchiveRecords,
	readBenchmarkEvidence,
	recommendModeFromArchive,
	summarizeArchive,
	VERIFICATION_EVENT,
	WARNING_EVENT,
	type ArchiveRecord,
} from "./index.ts";

type Handler = (...args: any[]) => unknown;

function makeTempProject() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-improvement-archive-"));
	return {
		root,
		cleanup() {
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

function record(kind: ArchiveRecord["kind"], extra: Partial<ArchiveRecord> = {}): ArchiveRecord {
	return {
		schemaVersion: 1,
		kind,
		timestamp: "2026-06-26T00:00:00.000Z",
		...extra,
	} as ArchiveRecord;
}

function createHarness() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { description: string; handler: Handler }>();
	const tools = new Map<string, any>();
	const eventBus = new Map<string, Array<(data: unknown) => void>>();
	const sentMessages: any[] = [];

	const pi = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerCommand(name: string, definition: { description: string; handler: Handler }) {
			commands.set(name, definition);
		},
		registerTool(definition: any) {
			tools.set(definition.name, definition);
		},
		sendMessage(message: any) {
			sentMessages.push(message);
		},
		events: {
			on(name: string, handler: (data: unknown) => void) {
				const list = eventBus.get(name) ?? [];
				list.push(handler);
				eventBus.set(name, list);
				return () => {};
			},
			emit(name: string, data: unknown) {
				for (const handler of eventBus.get(name) ?? []) handler(data);
			},
		},
	};

	archiveExtension(pi as any);

	return {
		handlers,
		commands,
		tools,
		sentMessages,
		emitEvent(name: string, data: unknown) {
			pi.events.emit(name, data);
		},
		async emit(name: string, event: unknown, ctx: unknown) {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
	};
}

function createCtx(cwd: string) {
	const notifications: any[] = [];
	const editorTexts: string[] = [];
	return {
		notifications,
		editorTexts,
		ctx: {
			cwd,
			hasUI: true,
			model: { provider: "anthropic", id: "claude-fable-5" },
			sessionManager: { getSessionId: () => "session-a" },
			ui: {
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
				setEditorText(text: string) {
					editorTexts.push(text);
				},
			},
		},
	};
}

test("append/read archive records and summarize common signals", (t) => {
	const fixture = makeTempProject();
	t.after(() => fixture.cleanup());

	appendArchiveRecord(fixture.root, record("run", { toolCounts: { read: 2, edit: 1 }, touchedFiles: ["src/a.ts"] }));
	appendArchiveRecord(
		fixture.root,
		record("verification", { verification: { projectRoot: fixture.root, command: "bash scripts/verify.sh", status: "failed", trigger: "auto", failureSummary: "tests failed" } }),
	);

	const read = readArchiveRecords(fixture.root);
	assert.equal(read.records.length, 2);
	assert.equal(read.errors.length, 0);
	assert.equal(read.path, getArchivePath(fixture.root));

	const summary = summarizeArchive(read.records);
	assert.equal(summary.runs, 1);
	assert.equal(summary.failedVerifications, 1);
	assert.deepEqual(summary.topTools[0], { name: "read", count: 2 });
	assert.deepEqual(summary.topTouchedFiles[0], { path: "src/a.ts", count: 1 });
});

test("readArchiveRecords tolerates missing and malformed archives", (t) => {
	const fixture = makeTempProject();
	t.after(() => fixture.cleanup());

	assert.deepEqual(readArchiveRecords(fixture.root).records, []);
	fs.mkdirSync(path.dirname(getArchivePath(fixture.root)), { recursive: true });
	fs.writeFileSync(getArchivePath(fixture.root), "not-json\n{}\n", "utf8");

	const read = readArchiveRecords(fixture.root);
	assert.equal(read.records.length, 0);
	assert.equal(read.errors.length, 2);
	assert.match(formatArchiveReport("status", read), /Archive read issues/);
});

test("extension records a compact run from events", async (t) => {
	const fixture = makeTempProject();
	t.after(() => fixture.cleanup());
	const harness = createHarness();
	const { ctx } = createCtx(fixture.root);

	await harness.emit("session_start", {}, ctx);
	await harness.emit("agent_start", { prompt: "Implement a tiny fix" }, ctx);
	await harness.emit("tool_call", { toolName: "read", input: { path: "README.md" } }, ctx);
	await harness.emit("tool_call", { toolName: "edit", input: { path: "src/a.ts" } }, ctx);
	await harness.emit("tool_result", { toolName: "edit", isError: true, content: [{ type: "text", text: "oldText not found" }] }, ctx);
	await harness.emit("agent_end", {}, ctx);

	const read = readArchiveRecords(fixture.root);
	assert.equal(read.records.length, 1);
	assert.equal(read.records[0].kind, "run");
	assert.equal(read.records[0].toolCounts?.read, 1);
	assert.equal(read.records[0].toolCounts?.edit, 1);
	assert.equal(read.records[0].toolFailures?.[0].message, "oldText not found");
	assert.ok(read.records[0].touchedFiles?.[0].endsWith(path.join("src", "a.ts")));
});

test("last report displays compact replay-lite trajectory with failures, warnings, and verification", async (t) => {
	const fixture = makeTempProject();
	t.after(() => fixture.cleanup());
	const harness = createHarness();
	const { ctx } = createCtx(fixture.root);
	const longFailure = `boom SECRET_TOKEN=abc123 ${"x".repeat(1_000)}`;

	await harness.emit("session_start", {}, ctx);
	await harness.emit("agent_start", { prompt: "Do not archive full transcripts" }, ctx);
	await harness.emit("tool_call", { toolName: "read", input: { path: "README.md" } }, ctx);
	await harness.emit("tool_result", { toolName: "read", isError: false, content: [{ type: "text", text: "full file output should not be stored" }] }, ctx);
	await harness.emit("tool_call", { toolName: "edit", input: { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] } }, ctx);
	await harness.emit("tool_result", { toolName: "edit", isError: false, content: [{ type: "text", text: "edited" }] }, ctx);
	await harness.emit("tool_call", { toolName: "bash", input: { command: "SECRET_TOKEN=abc123 npm run broken" } }, ctx);
	await harness.emit("tool_result", { toolName: "bash", isError: true, content: [{ type: "text", text: longFailure }] }, ctx);
	harness.emitEvent(WARNING_EVENT, { type: "repeated-tool-error", message: "bash failed twice", toolName: "bash", count: 2 });
	harness.emitEvent(VERIFICATION_EVENT, {
		projectRoot: fixture.root,
		command: "bash scripts/verify.sh --quick",
		status: "failed",
		trigger: "auto",
		failureSummary: "quick gate failed",
		touchedPaths: ["src/a.ts"],
	});
	await harness.emit("agent_end", {}, ctx);

	const read = readArchiveRecords(fixture.root);
	const run = read.records.find((item) => item.kind === "run") as any;
	assert.ok(run.replayLite);
	assert.deepEqual(run.replayLite.steps.map((step: any) => `${step.name}:${step.status}`), ["read:passed", "edit:passed", "bash:failed", "warning:warning", "verification:failed"]);
	assert.ok(run.replayLite.steps[1].touchedFiles[0].endsWith(path.join("src", "a.ts")));
	assert.ok(run.replayLite.steps[2].summary.length < longFailure.length);

	const report = formatArchiveReport("last", read, 5);
	assert.match(report, /Replay-lite:/);
	assert.match(report, /read passed/);
	assert.match(report, /edit passed/);
	assert.match(report, /bash failed/);
	assert.match(report, /npm run broken/);
	assert.match(report, /SECRET_TOKEN=\[redacted\]/);
	assert.match(report, /boom SECRET_TOKEN=\[redacted\] x+/);
	assert.doesNotMatch(report, /abc123/);
	assert.doesNotMatch(report, new RegExp(`x{${900}}`));
	assert.match(report, /warning warning — repeated-tool-error: bash failed twice/);
	assert.match(report, /verification failed/);
	assert.match(report, /quick gate failed/);
	assert.doesNotMatch(report, /full file output should not be stored/);
});

test("replay-lite is capped and legacy or malformed trajectory data stays readable", async (t) => {
	const fixture = makeTempProject();
	t.after(() => fixture.cleanup());
	const harness = createHarness();
	const { ctx } = createCtx(fixture.root);

	appendArchiveRecord(fixture.root, record("run", { toolCounts: { read: 1 } }));
	appendArchiveRecord(fixture.root, record("run", { replayLite: { steps: "not-an-array" } } as any));

	await harness.emit("session_start", {}, ctx);
	await harness.emit("agent_start", { prompt: "many tiny reads" }, ctx);
	for (let i = 0; i < 90; i++) {
		await harness.emit("tool_call", { toolName: "read", input: { path: `file-${i}.md` } }, ctx);
	}
	await harness.emit("agent_end", {}, ctx);

	const read = readArchiveRecords(fixture.root);
	const cappedRun = read.records.at(-1) as any;
	assert.equal(cappedRun.replayLite.steps.length, 80);
	assert.equal(cappedRun.replayLite.truncated, true);

	const report = formatArchiveReport("last", read, 10);
	assert.match(report, /run 0ms, tools=1, touched=0/);
	assert.match(report, /replay-lite unavailable \(malformed\)/);
	assert.match(report, /Replay-lite truncated/);
});

test("extension records verification and warning event bus payloads", async (t) => {
	const fixture = makeTempProject();
	t.after(() => fixture.cleanup());
	const harness = createHarness();
	const { ctx } = createCtx(fixture.root);

	await harness.emit("session_start", {}, ctx);
	harness.emitEvent(VERIFICATION_EVENT, {
		projectRoot: fixture.root,
		command: "bash scripts/verify.sh",
		status: "passed",
		trigger: "auto",
		touchedPaths: ["src/a.ts"],
	});
	harness.emitEvent(WARNING_EVENT, { type: "repeated-tool-error", message: "bash failed twice", toolName: "bash", count: 2 });

	const read = readArchiveRecords(fixture.root);
	assert.equal(read.records.length, 2);
	assert.equal(read.records[0].kind, "verification");
	assert.equal(read.records[1].kind, "warning");
});

test("commands and tool expose status and human-gated proposals", async (t) => {
	const fixture = makeTempProject();
	t.after(() => fixture.cleanup());
	appendArchiveRecord(
		fixture.root,
		record("verification", { verification: { projectRoot: fixture.root, command: "bash scripts/verify.sh", status: "failed", trigger: "auto", failureSummary: "tests failed" } }),
	);

	const harness = createHarness();
	const context = createCtx(fixture.root);
	const command = harness.commands.get("improve-archive");
	assert.ok(command);
	await command.handler("status", context.ctx);
	assert.match(harness.sentMessages[0].content, /Verification: 0 passed \/ 1 failed/);

	await command.handler("proposal", context.ctx);
	assert.match(context.editorTexts.at(-1) ?? "", /# Proposed Pi Config Improvement/);
	assert.match(context.editorTexts.at(-1) ?? "", /Human approval required/);

	const tool = harness.tools.get("archive_analysis");
	assert.ok(tool);
	const result = await tool.execute("tool-1", { action: "failures" }, undefined, undefined, context.ctx);
	assert.match(result.content[0].text, /Recent failures/);
});

test("improvement proposal scorecard ranks full evidence and explains compound value", (t) => {
	const fixture = makeTempProject();
	t.after(() => fixture.cleanup());
	appendArchiveRecord(
		fixture.root,
		record("run", {
			toolCounts: { read: 3, bash: 2 },
			toolFailures: [{ toolName: "bash", message: "grep command failed" }],
			touchedFiles: ["extensions/example/index.ts"],
		}),
	);
	appendArchiveRecord(
		fixture.root,
		record("verification", { verification: { projectRoot: fixture.root, command: "npm run test:self-improvement-archive", status: "failed", trigger: "manual", failureSummary: "proposal test failed" } }),
	);
	appendArchiveRecord(fixture.root, record("warning", { warning: { type: "large-change", message: "large edit warning" } }));
	const benchmarkDir = path.join(fixture.root, ".pi", "self-improvement", "benchmarks");
	fs.mkdirSync(benchmarkDir, { recursive: true });
	fs.writeFileSync(
		path.join(benchmarkDir, "2026-06-26.json"),
		JSON.stringify({ id: "bench-1", totalScore: 1, passed: 3, failed: 0, results: [] }),
		"utf8",
	);

	const proposal = formatImprovementProposal(fixture.root);
	assert.match(proposal, /## Scorecard/);
	assert.match(proposal, /Evidence strength: high/);
	assert.match(proposal, /Confidence: high/);
	assert.match(proposal, /## Compound engineering/);
	assert.match(proposal, /How this helps the next similar task:/);
	assert.match(proposal, /How we verify the learning:/);
	assert.match(proposal, /Will this catch itself or accelerate itself next time\?/);
});

test("improvement proposal scorecard recommends measurement for sparse evidence", (t) => {
	const fixture = makeTempProject();
	t.after(() => fixture.cleanup());

	const proposal = formatImprovementProposal(fixture.root);
	assert.match(proposal, /Evidence strength: low/);
	assert.match(proposal, /Confidence: low/);
	assert.match(proposal, /measure before changing behavior/);
	assert.match(proposal, /Run the local benchmark suite first/);
});

test("improvement proposals include latest benchmark evidence and failure scorecard", (t) => {
	const fixture = makeTempProject();
	t.after(() => fixture.cleanup());
	const benchmarkDir = path.join(fixture.root, ".pi", "self-improvement", "benchmarks");
	fs.mkdirSync(benchmarkDir, { recursive: true });
	fs.writeFileSync(
		path.join(benchmarkDir, "2026-06-26.json"),
		JSON.stringify({
			id: "bench-1",
			totalScore: 0.67,
			passed: 2,
			failed: 1,
			results: [{ id: "extension-inventory", status: "failed" }],
		}),
		"utf8",
	);

	const benchmark = readBenchmarkEvidence(fixture.root);
	assert.equal(benchmark.count, 1);
	assert.deepEqual(benchmark.latest?.failures, ["extension-inventory"]);
	const proposal = formatImprovementProposal(fixture.root);
	assert.match(proposal, /latest benchmark score: 0\.67/);
	assert.match(proposal, /benchmark failures: extension-inventory/);
	assert.match(proposal, /Fix the latest failing local benchmark/);
	assert.match(proposal, /Reproducibility: high/);
	assert.match(proposal, /Expected metric: high/);
	assert.match(proposal, /Test coverage: medium/);
});

test("improvement proposal scorecard degrades safely for corrupt evidence", (t) => {
	const fixture = makeTempProject();
	t.after(() => fixture.cleanup());
	fs.mkdirSync(path.dirname(getArchivePath(fixture.root)), { recursive: true });
	fs.writeFileSync(getArchivePath(fixture.root), "not-json\n", "utf8");
	const benchmarkDir = path.join(fixture.root, ".pi", "self-improvement", "benchmarks");
	fs.mkdirSync(benchmarkDir, { recursive: true });
	fs.writeFileSync(path.join(benchmarkDir, "2026-06-26.json"), "not-json", "utf8");

	const proposal = formatImprovementProposal(fixture.root);
	assert.match(proposal, /## Scorecard/);
	assert.match(proposal, /Archive issue:/);
	assert.match(proposal, /Benchmark issue:/);
	assert.match(proposal, /Evidence strength: low/);
	assert.match(proposal, /Confidence: low/);
	assert.match(proposal, /does not edit files or run agents by itself/);
});

test("archive guidance and mode recommendation degrade safely", (t) => {
	const fixture = makeTempProject();
	t.after(() => fixture.cleanup());

	assert.equal(buildArchiveGuidance(fixture.root), undefined);
	assert.equal(recommendModeFromArchive(fixture.root).mode, "smart");

	for (let i = 0; i < 3; i++) {
		appendArchiveRecord(
			fixture.root,
			record("verification", { verification: { projectRoot: fixture.root, command: "bash scripts/verify.sh", status: "failed", trigger: "auto" } }),
		);
	}
	assert.match(buildArchiveGuidance(fixture.root) ?? "", /verification failure/);
	assert.equal(recommendModeFromArchive(fixture.root).mode, "deep3");
	assert.match(formatImprovementProposal(fixture.root), /Expected metric/);
});
