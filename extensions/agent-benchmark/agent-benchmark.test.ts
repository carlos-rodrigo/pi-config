import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import agentBenchmarkExtension, {
	benchmarkResultPath,
	builtInBenchmarks,
	formatBenchmarkCompare,
	formatBenchmarkList,
	formatBenchmarkResult,
	listBenchmarkResults,
	runBenchmarks,
	writeBenchmarkResult,
} from "./index.ts";

function makeFixture(options?: { includeInventoryEntries?: boolean }) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-benchmark-"));
	fs.mkdirSync(path.join(root, "extensions", "code-intel"), { recursive: true });
	fs.mkdirSync(path.join(root, "extensions"), { recursive: true });
	fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
	fs.writeFileSync(path.join(root, "scripts", "verify.sh"), "#!/bin/bash\nexit 0\n", "utf8");
	fs.writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({ scripts: { "test:verify": "node --test extensions/verify/verify.test.ts" } }),
		"utf8",
	);
	fs.writeFileSync(
		path.join(root, "extensions", "code-intel", "index.ts"),
		["code_find", "symbol_search", "dependency_map", "git_pickaxe", "ast_search"].map((name) => `pi.registerTool({ name: \"${name}\" });`).join("\n"),
		"utf8",
	);
	const inventory = options?.includeInventoryEntries
		? "self-improvement-archive\nagent-benchmark\noverseer\n"
		: "self-improvement-archive\n";
	fs.writeFileSync(path.join(root, "extensions", "README.md"), inventory, "utf8");
	return {
		root,
		cleanup() {
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

function createHarness() {
	const commands = new Map<string, { description: string; handler: (...args: any[]) => unknown }>();
	const tools = new Map<string, any>();
	const sentMessages: any[] = [];
	const statuses: any[] = [];
	const notifications: any[] = [];
	const pi = {
		registerCommand(name: string, definition: { description: string; handler: (...args: any[]) => unknown }) {
			commands.set(name, definition);
		},
		registerTool(definition: any) {
			tools.set(definition.name, definition);
		},
		sendMessage(message: any) {
			sentMessages.push(message);
		},
	};
	agentBenchmarkExtension(pi as any);
	return {
		commands,
		tools,
		sentMessages,
		statuses,
		notifications,
		ctx(cwd: string) {
			return {
				cwd,
				ui: {
					setStatus(key: string, value: string | undefined) {
						statuses.push({ key, value });
					},
					notify(message: string, level: string) {
						notifications.push({ message, level });
					},
				},
			};
		},
	};
}

test("built-in benchmarks list local self-improvement checks by tier", (t) => {
	const fixture = makeFixture({ includeInventoryEntries: true });
	t.after(() => fixture.cleanup());

	const benchmarks = builtInBenchmarks().map((benchmark) => ({ id: benchmark.id, tier: benchmark.tier }));
	assert.deepEqual(benchmarks, [
		{ id: "verify-smoke", tier: "smoke" },
		{ id: "extension-inventory", tier: "harness" },
		{ id: "code-navigation-fixture", tier: "scenario" },
	]);
	const list = formatBenchmarkList(fixture.root);
	assert.match(list, /smoke/);
	assert.match(list, /harness/);
	assert.match(list, /scenario/);
	assert.match(list, /regression/);
	assert.match(list, /no regression seeds configured/);
	assert.match(list, /extension-inventory/);
});

test("runBenchmarks scores pass and failure cases", (t) => {
	const fixture = makeFixture({ includeInventoryEntries: false });
	t.after(() => fixture.cleanup());

	const result = runBenchmarks(fixture.root);
	assert.deepEqual(result.tiers, ["smoke", "harness", "scenario"]);
	assert.equal(result.results.length, 3);
	assert.equal(result.passed, 2);
	assert.equal(result.failed, 1);
	assert.equal(result.totalScore, 2 / 3);
	assert.equal(result.results.find((item) => item.id === "extension-inventory")?.tier, "harness");
	assert.match(formatBenchmarkResult(result), /\[harness\] extension-inventory/);
});

test("runBenchmarks selects tiers and reports unknown selectors", (t) => {
	const fixture = makeFixture({ includeInventoryEntries: true });
	t.after(() => fixture.cleanup());

	const smoke = runBenchmarks(fixture.root, ["smoke"]);
	assert.deepEqual(smoke.tiers, ["smoke"]);
	assert.deepEqual(smoke.results.map((item) => item.id), ["verify-smoke"]);
	assert.equal(smoke.results[0].tier, "smoke");
	assert.equal(smoke.passed, 1);

	const unknown = runBenchmarks(fixture.root, ["not-a-benchmark"]);
	assert.deepEqual(unknown.tiers, ["unknown"]);
	assert.equal(unknown.failed, 1);
	assert.equal(unknown.results[0].tier, "unknown");
	assert.match(formatBenchmarkResult(unknown), /Unknown benchmark id or tier: not-a-benchmark/);
});

test("regression seed definitions are listed and run without agent execution", (t) => {
	const fixture = makeFixture({ includeInventoryEntries: true });
	t.after(() => fixture.cleanup());
	const seedDir = path.join(fixture.root, ".pi", "self-improvement", "benchmark-regressions");
	fs.mkdirSync(seedDir, { recursive: true });
	fs.writeFileSync(
		path.join(seedDir, "missing-active-refresh.json"),
		JSON.stringify({
			schemaVersion: 1,
			id: "missing-active-refresh",
			description: "A prior loop had a stale _active.md board.",
			source: "TASK-008 test fixture",
			expected: "List and validate the seed only; do not launch an agent.",
		}),
		"utf8",
	);

	const list = formatBenchmarkList(fixture.root);
	assert.match(list, /regression:missing-active-refresh/);
	const result = runBenchmarks(fixture.root, ["regression"]);
	assert.deepEqual(result.tiers, ["regression"]);
	assert.equal(result.results.length, 1);
	assert.equal(result.results[0].id, "regression:missing-active-refresh");
	assert.equal(result.results[0].tier, "regression");
	assert.match(result.results[0].summary, /Regression seed represented/);
	assert.match(formatBenchmarkResult(result), /\[regression\] regression:missing-active-refresh/);
});

test("benchmark results are written, listed, and compared", (t) => {
	const fixture = makeFixture({ includeInventoryEntries: true });
	t.after(() => fixture.cleanup());

	const first = runBenchmarks(fixture.root, ["verify-smoke"]);
	writeBenchmarkResult(fixture.root, first);
	const second = runBenchmarks(fixture.root);
	writeBenchmarkResult(fixture.root, second);

	const files = listBenchmarkResults(fixture.root);
	assert.equal(files.length, 2);
	assert.equal(files[0], benchmarkResultPath(fixture.root, first.id));
	const compare = formatBenchmarkCompare(fixture.root);
	assert.match(compare, /Benchmark comparison/);
	assert.match(compare, /Previous: .*tiers: smoke/);
	assert.match(compare, /Latest: .*tiers: smoke, harness, scenario/);
});

test("compare reports empty state without crashing", (t) => {
	const fixture = makeFixture({ includeInventoryEntries: true });
	t.after(() => fixture.cleanup());
	assert.match(formatBenchmarkCompare(fixture.root), /No benchmark results yet/);
});

test("command and tool expose list, run, and compare", async (t) => {
	const fixture = makeFixture({ includeInventoryEntries: true });
	t.after(() => fixture.cleanup());
	const harness = createHarness();

	const command = harness.commands.get("bench");
	assert.ok(command);
	await command.handler("list", harness.ctx(fixture.root));
	assert.match(harness.sentMessages.at(-1).content, /Pi config benchmarks by tier/);

	await command.handler("run smoke", harness.ctx(fixture.root));
	assert.match(harness.sentMessages.at(-1).content, /Tiers: smoke/);
	assert.match(harness.sentMessages.at(-1).content, /Score: 1\.00/);
	assert.equal(listBenchmarkResults(fixture.root).length, 1);

	await command.handler("compare", harness.ctx(fixture.root));
	assert.match(harness.sentMessages.at(-1).content, /Only one benchmark result/);

	const tool = harness.tools.get("agent_benchmark");
	assert.ok(tool);
	const list = await tool.execute("tool-1", { action: "list" }, undefined, undefined, harness.ctx(fixture.root));
	assert.match(list.content[0].text, /verify-smoke/);
	assert.match(list.content[0].text, /no regression seeds configured/);

	const toolRun = await tool.execute("tool-2", { action: "run", ids: ["smoke"] }, undefined, undefined, harness.ctx(fixture.root));
	assert.match(toolRun.content[0].text, /Tiers: smoke/);
});
