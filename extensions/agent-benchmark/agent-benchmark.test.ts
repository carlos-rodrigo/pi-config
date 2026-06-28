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

test("built-in benchmarks list local self-improvement checks", () => {
	const ids = builtInBenchmarks().map((benchmark) => benchmark.id);
	assert.deepEqual(ids, ["extension-inventory", "code-navigation-fixture", "verify-smoke"]);
	assert.match(formatBenchmarkList(), /extension-inventory/);
});

test("runBenchmarks scores pass and failure cases", (t) => {
	const fixture = makeFixture({ includeInventoryEntries: false });
	t.after(() => fixture.cleanup());

	const result = runBenchmarks(fixture.root);
	assert.equal(result.results.length, 3);
	assert.equal(result.passed, 2);
	assert.equal(result.failed, 1);
	assert.equal(result.totalScore, 2 / 3);
	assert.match(formatBenchmarkResult(result), /extension-inventory/);
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
	assert.match(formatBenchmarkCompare(fixture.root), /Benchmark comparison/);
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
	assert.match(harness.sentMessages.at(-1).content, /Built-in Pi config benchmarks/);

	await command.handler("run verify-smoke", harness.ctx(fixture.root));
	assert.match(harness.sentMessages.at(-1).content, /Score: 1\.00/);
	assert.equal(listBenchmarkResults(fixture.root).length, 1);

	await command.handler("compare", harness.ctx(fixture.root));
	assert.match(harness.sentMessages.at(-1).content, /Only one benchmark result/);

	const tool = harness.tools.get("agent_benchmark");
	assert.ok(tool);
	const list = await tool.execute("tool-1", { action: "list" }, undefined, undefined, harness.ctx(fixture.root));
	assert.match(list.content[0].text, /verify-smoke/);
});
