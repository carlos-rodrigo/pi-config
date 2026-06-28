import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { SELF_IMPROVEMENT_DIR } from "../self-improvement-archive/index.ts";

const BENCHMARK_DIR = "benchmarks";
const RESULT_SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 5_000;

type BenchmarkStatus = "passed" | "failed";

type BenchmarkCase = {
	id: string;
	description: string;
	run(cwd: string): BenchmarkCaseResult;
};

export type BenchmarkCaseResult = {
	id: string;
	status: BenchmarkStatus;
	durationMs: number;
	score: number;
	summary: string;
	details?: Record<string, unknown>;
};

export type BenchmarkRunResult = {
	schemaVersion: 1;
	id: string;
	startedAt: string;
	finishedAt: string;
	cwd: string;
	totalScore: number;
	passed: number;
	failed: number;
	durationMs: number;
	results: BenchmarkCaseResult[];
};

let lastIdTimestamp = "";
let sameTimestampIdCounter = 0;

function nowId(): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	if (timestamp === lastIdTimestamp) {
		sameTimestampIdCounter += 1;
	} else {
		lastIdTimestamp = timestamp;
		sameTimestampIdCounter = 0;
	}
	const sequence = String(sameTimestampIdCounter).padStart(4, "0");
	return `${timestamp}-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
}

function benchmarkRoot(cwd: string): string {
	return join(resolve(cwd), SELF_IMPROVEMENT_DIR, BENCHMARK_DIR);
}

export function benchmarkResultPath(cwd: string, id: string): string {
	return join(benchmarkRoot(cwd), `${id}.json`);
}

function readText(path: string): string {
	return readFileSync(path, "utf8");
}

function timeCase(benchmark: BenchmarkCase, cwd: string): BenchmarkCaseResult {
	const start = Date.now();
	try {
		const result = benchmark.run(cwd);
		return { ...result, durationMs: Date.now() - start };
	} catch (error) {
		return {
			id: benchmark.id,
			status: "failed",
			durationMs: Date.now() - start,
			score: 0,
			summary: error instanceof Error ? error.message : String(error),
		};
	}
}

function pass(id: string, summary: string, details?: Record<string, unknown>): BenchmarkCaseResult {
	return { id, status: "passed", durationMs: 0, score: 1, summary, details };
}

function fail(id: string, summary: string, details?: Record<string, unknown>): BenchmarkCaseResult {
	return { id, status: "failed", durationMs: 0, score: 0, summary, details };
}

export function builtInBenchmarks(): BenchmarkCase[] {
	return [
		{
			id: "extension-inventory",
			description: "extensions/README.md lists self-improvement extensions for users",
			run(cwd) {
				const readme = readText(join(cwd, "extensions", "README.md"));
				const required = ["self-improvement-archive", "agent-benchmark", "overseer"];
				const missing = required.filter((name) => !readme.includes(name));
				return missing.length === 0
					? pass("extension-inventory", "Extension inventory lists the self-improvement extensions.")
					: fail("extension-inventory", `Missing extension inventory entries: ${missing.join(", ")}`, { missing });
			},
		},
		{
			id: "code-navigation-fixture",
			description: "code-intel exposes the core navigation tools used in improvement work",
			run(cwd) {
				const source = readText(join(cwd, "extensions", "code-intel", "index.ts"));
				const required = ["code_find", "symbol_search", "dependency_map", "git_pickaxe", "ast_search"];
				const missing = required.filter((tool) => !source.includes(`name: \"${tool}\"`));
				return missing.length === 0
					? pass("code-navigation-fixture", "code-intel navigation tools are registered.")
					: fail("code-navigation-fixture", `Missing code-intel tool registration(s): ${missing.join(", ")}`, { missing });
			},
		},
		{
			id: "verify-smoke",
			description: "repo has a verification gate and targeted verify test script",
			run(cwd) {
				const packageJson = JSON.parse(readText(join(cwd, "package.json"))) as { scripts?: Record<string, string> };
				const hasVerifyScript = existsSync(join(cwd, "scripts", "verify.sh"));
				const hasTest = Boolean(packageJson.scripts?.["test:verify"]);
				if (hasVerifyScript && hasTest) return pass("verify-smoke", "Verification script and test:verify script are present.");
				return fail("verify-smoke", "Missing verification script or test:verify package script.", { hasVerifyScript, hasTest });
			},
		},
	];
}

export function runBenchmarks(cwd: string, ids?: string[]): BenchmarkRunResult {
	const selected = ids && ids.length > 0 ? builtInBenchmarks().filter((benchmark) => ids.includes(benchmark.id)) : builtInBenchmarks();
	const started = Date.now();
	const startedAt = new Date(started).toISOString();
	const results = selected.map((benchmark) => timeCase(benchmark, cwd));
	const finishedAt = new Date().toISOString();
	const passed = results.filter((result) => result.status === "passed").length;
	const failed = results.length - passed;
	const totalScore = results.length === 0 ? 0 : results.reduce((sum, result) => sum + result.score, 0) / results.length;
	return {
		schemaVersion: RESULT_SCHEMA_VERSION,
		id: nowId(),
		startedAt,
		finishedAt,
		cwd: resolve(cwd),
		totalScore,
		passed,
		failed,
		durationMs: Date.now() - started,
		results,
	};
}

export function writeBenchmarkResult(cwd: string, result: BenchmarkRunResult): string {
	const file = benchmarkResultPath(cwd, result.id);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, "utf8");
	return file;
}

export function listBenchmarkResults(cwd: string): string[] {
	const root = benchmarkRoot(cwd);
	try {
		return readdirSync(root)
			.filter((file) => file.endsWith(".json"))
			.sort()
			.map((file) => join(root, file));
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return [];
		throw error;
	}
}

export function readBenchmarkResult(path: string): BenchmarkRunResult {
	return JSON.parse(readFileSync(path, "utf8")) as BenchmarkRunResult;
}

export function formatBenchmarkList(): string {
	const lines = ["Built-in Pi config benchmarks:"];
	for (const benchmark of builtInBenchmarks()) {
		lines.push(`- ${benchmark.id}: ${benchmark.description}`);
	}
	return lines.join("\n");
}

export function formatBenchmarkResult(result: BenchmarkRunResult, file?: string): string {
	const lines = [
		`Benchmark run ${result.id}`,
		`Score: ${result.totalScore.toFixed(2)} (${result.passed} passed / ${result.failed} failed)` ,
		`Duration: ${result.durationMs}ms`,
	];
	if (file) lines.push(`Saved: ${file}`);
	lines.push("");
	for (const item of result.results) {
		lines.push(`- ${item.status === "passed" ? "✓" : "✗"} ${item.id}: ${item.summary}`);
	}
	return lines.join("\n");
}

export function formatBenchmarkCompare(cwd: string): string {
	const files = listBenchmarkResults(cwd);
	if (files.length === 0) return "No benchmark results yet. Run /bench run first.";
	if (files.length === 1) return `Only one benchmark result exists: ${files[0]}. Run /bench run again to compare.`;
	const previous = readBenchmarkResult(files[files.length - 2]);
	const latest = readBenchmarkResult(files[files.length - 1]);
	const delta = latest.totalScore - previous.totalScore;
	return [
		"Benchmark comparison",
		`Previous: ${previous.id} score ${previous.totalScore.toFixed(2)}`,
		`Latest: ${latest.id} score ${latest.totalScore.toFixed(2)}`,
		`Delta: ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`,
		`Latest failures: ${latest.results.filter((result) => result.status === "failed").map((result) => result.id).join(", ") || "none"}`,
	].join("\n");
}

function parseBenchArgs(args: string): { action: string; ids: string[] } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	return { action: tokens[0] ?? "list", ids: tokens.slice(1) };
}

export default function agentBenchmarkExtension(pi: ExtensionAPI) {
	pi.registerCommand("bench", {
		description: "Run local Pi config benchmarks: /bench [list|run|compare] [benchmark-id...]",
		handler: async (args, ctx) => {
			const { action, ids } = parseBenchArgs(args);
			if (action === "list") {
				pi.sendMessage?.({ customType: "agent-benchmark", content: formatBenchmarkList(), display: true, details: {} });
				return;
			}
			if (action === "compare") {
				pi.sendMessage?.({ customType: "agent-benchmark", content: formatBenchmarkCompare(ctx.cwd), display: true, details: {} });
				return;
			}
			if (action !== "run") {
				ctx.ui.notify("Usage: /bench list | /bench run [id...] | /bench compare", "error");
				return;
			}
			ctx.ui.setStatus?.("agent-benchmark", "benching…");
			try {
				const result = runBenchmarks(ctx.cwd, ids);
				const file = writeBenchmarkResult(ctx.cwd, result);
				pi.sendMessage?.({ customType: "agent-benchmark", content: formatBenchmarkResult(result, file), display: true, details: { result, file } });
				ctx.ui.notify(`Benchmark score ${result.totalScore.toFixed(2)} (${result.passed}/${result.results.length})`, result.failed > 0 ? "warning" : "info");
			} finally {
				ctx.ui.setStatus?.("agent-benchmark", undefined);
			}
		},
	});

	pi.registerTool({
		name: "agent_benchmark",
		label: "Agent Benchmark",
		description: "List, run, or compare cheap local Pi config benchmarks. Does not launch background agents unless a future explicit option is added.",
		promptSnippet: "Run cheap local Pi config benchmarks and compare results",
		promptGuidelines: [
			"Use agent_benchmark to measure Pi config changes before proposing self-improvement conclusions.",
			"agent_benchmark is local and cheap; it does not run hidden background agents.",
		],
		parameters: Type.Object({
			action: StringEnum(["list", "run", "compare"] as const, { description: "Benchmark action." }),
			ids: Type.Optional(Type.Array(Type.String(), { description: "Optional benchmark ids for action=run." })),
			timeoutMs: Type.Optional(Type.Number({ description: `Reserved timeout hint for future agent-backed benchmarks (default ${DEFAULT_TIMEOUT_MS}).`, minimum: 1, maximum: 60_000 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.action === "list") return { content: [{ type: "text" as const, text: formatBenchmarkList() }], details: { benchmarks: builtInBenchmarks().map((benchmark) => benchmark.id) } };
			if (params.action === "compare") return { content: [{ type: "text" as const, text: formatBenchmarkCompare(ctx.cwd) }], details: { files: listBenchmarkResults(ctx.cwd) } };
			const result = runBenchmarks(ctx.cwd, params.ids);
			const file = writeBenchmarkResult(ctx.cwd, result);
			return { content: [{ type: "text" as const, text: formatBenchmarkResult(result, file) }], details: { result, file } };
		},
	});
}
