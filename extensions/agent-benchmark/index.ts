import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { SELF_IMPROVEMENT_DIR } from "../self-improvement-archive/index.ts";

const BENCHMARK_DIR = "benchmarks";
const REGRESSION_SEED_DIR = "benchmark-regressions";
const RESULT_SCHEMA_VERSION = 1;
const BENCHMARK_TIERS = ["smoke", "harness", "scenario", "regression"] as const;
const RESULT_TIER_ORDER = [...BENCHMARK_TIERS, "unknown"] as const;

export type BenchmarkTier = (typeof BENCHMARK_TIERS)[number];
type ResultTier = BenchmarkTier | "unknown";
type BenchmarkStatus = "passed" | "failed";

type BenchmarkCase = {
	id: string;
	tier: BenchmarkTier;
	description: string;
	run(cwd: string): BenchmarkCaseOutcome;
};

type BenchmarkCaseOutcome = {
	id: string;
	status: BenchmarkStatus;
	score: number;
	summary: string;
	details?: Record<string, unknown>;
};

export type BenchmarkCaseResult = BenchmarkCaseOutcome & {
	tier: ResultTier;
	durationMs: number;
};

export type BenchmarkRunResult = {
	schemaVersion: 1;
	id: string;
	startedAt: string;
	finishedAt: string;
	cwd: string;
	tiers: ResultTier[];
	totalScore: number;
	passed: number;
	failed: number;
	durationMs: number;
	results: BenchmarkCaseResult[];
};

type RegressionSeedDefinition = {
	schemaVersion?: unknown;
	id?: unknown;
	description?: unknown;
	source?: unknown;
	expected?: unknown;
	tags?: unknown;
};

type ValidRegressionSeedDefinition = RegressionSeedDefinition & {
	schemaVersion: 1;
	id: string;
	description: string;
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

function regressionSeedRoot(cwd: string): string {
	return join(resolve(cwd), SELF_IMPROVEMENT_DIR, REGRESSION_SEED_DIR);
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
		return { ...result, tier: benchmark.tier, durationMs: Date.now() - start };
	} catch (error) {
		return {
			id: benchmark.id,
			tier: benchmark.tier,
			status: "failed",
			durationMs: Date.now() - start,
			score: 0,
			summary: error instanceof Error ? error.message : String(error),
		};
	}
}

function pass(id: string, summary: string, details?: Record<string, unknown>): BenchmarkCaseOutcome {
	return { id, status: "passed", score: 1, summary, details };
}

function fail(id: string, summary: string, details?: Record<string, unknown>): BenchmarkCaseOutcome {
	return { id, status: "failed", score: 0, summary, details };
}

function isBenchmarkTier(value: string): value is BenchmarkTier {
	return (BENCHMARK_TIERS as readonly string[]).includes(value);
}

function orderedTiers(tiers: Iterable<ResultTier>): ResultTier[] {
	const unique = new Set(tiers);
	return RESULT_TIER_ORDER.filter((tier) => unique.has(tier));
}

function formatTiers(tiers: ResultTier[]): string {
	return tiers.length === 0 ? "none" : tiers.join(", ");
}

function resultTiers(result: Pick<BenchmarkRunResult, "tiers" | "results">): ResultTier[] {
	return orderedTiers(result.tiers ?? result.results.map((item) => item.tier ?? "unknown"));
}

function safeRegressionSeedId(file: string): string {
	const safe = basename(file, ".json").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return safe || "invalid-seed";
}

function isRegressionSeedDefinition(value: unknown): value is ValidRegressionSeedDefinition {
	if (typeof value !== "object" || value === null) return false;
	const seed = value as RegressionSeedDefinition;
	if (seed.schemaVersion !== 1) return false;
	if (typeof seed.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(seed.id)) return false;
	return typeof seed.description === "string" && seed.description.trim().length > 0;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function invalidRegressionSeed(file: string, summary: string, details?: Record<string, unknown>): BenchmarkCase {
	const id = `regression:${safeRegressionSeedId(file)}`;
	return {
		id,
		tier: "regression",
		description: `Invalid regression seed ${basename(file)}`,
		run() {
			return fail(id, summary, { seedPath: file, ...details });
		},
	};
}

function regressionSeedBenchmark(file: string): BenchmarkCase {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readText(file)) as unknown;
	} catch (error) {
		return invalidRegressionSeed(file, `Invalid regression seed JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRegressionSeedDefinition(parsed)) {
		const details = typeof parsed === "object" && parsed !== null ? { schemaVersion: (parsed as RegressionSeedDefinition).schemaVersion, id: (parsed as RegressionSeedDefinition).id } : { valueType: typeof parsed };
		return invalidRegressionSeed(file, "Invalid regression seed. Expected schemaVersion: 1, id, and description.", details);
	}
	const id = `regression:${parsed.id}`;
	const source = optionalString(parsed.source);
	const expected = optionalString(parsed.expected);
	const tags = optionalStringArray(parsed.tags);
	return {
		id,
		tier: "regression",
		description: parsed.description,
		run() {
			return pass(id, `Regression seed represented: ${parsed.description}`, { seedPath: file, source, expected, tags });
		},
	};
}

function regressionSeedBenchmarks(cwd: string): BenchmarkCase[] {
	const root = regressionSeedRoot(cwd);
	try {
		return readdirSync(root)
			.filter((file) => file.endsWith(".json"))
			.sort()
			.map((file) => regressionSeedBenchmark(join(root, file)));
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return [];
		throw error;
	}
}

export function builtInBenchmarks(): BenchmarkCase[] {
	return [
		{
			id: "verify-smoke",
			tier: "smoke",
			description: "repo has a verification gate and targeted verify test script",
			run(cwd) {
				const packageJson = JSON.parse(readText(join(cwd, "package.json"))) as { scripts?: Record<string, string> };
				const hasVerifyScript = existsSync(join(cwd, "scripts", "verify.sh"));
				const hasTest = Boolean(packageJson.scripts?.["test:verify"]);
				if (hasVerifyScript && hasTest) return pass("verify-smoke", "Verification script and test:verify script are present.");
				return fail("verify-smoke", "Missing verification script or test:verify package script.", { hasVerifyScript, hasTest });
			},
		},
		{
			id: "extension-inventory",
			tier: "harness",
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
			tier: "scenario",
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
	];
}

function availableBenchmarks(cwd: string): BenchmarkCase[] {
	return [...builtInBenchmarks(), ...regressionSeedBenchmarks(cwd)];
}

function selectBenchmarks(cwd: string, selectors?: string[]): { selected: BenchmarkCase[]; unknownSelectors: string[]; tiers: ResultTier[] } {
	const benchmarks = availableBenchmarks(cwd);
	if (!selectors || selectors.length === 0) {
		return { selected: benchmarks, unknownSelectors: [], tiers: orderedTiers(benchmarks.map((benchmark) => benchmark.tier)) };
	}

	const selected = new Map<string, BenchmarkCase>();
	const requestedTiers = new Set<ResultTier>();
	const unknownSelectors: string[] = [];
	for (const selector of selectors) {
		if (isBenchmarkTier(selector)) {
			requestedTiers.add(selector);
			for (const benchmark of benchmarks) {
				if (benchmark.tier === selector) selected.set(benchmark.id, benchmark);
			}
			continue;
		}
		const benchmark = benchmarks.find((candidate) => candidate.id === selector);
		if (benchmark) {
			selected.set(benchmark.id, benchmark);
			requestedTiers.add(benchmark.tier);
			continue;
		}
		unknownSelectors.push(selector);
	}
	if (unknownSelectors.length > 0) requestedTiers.add("unknown");
	return { selected: [...selected.values()], unknownSelectors, tiers: orderedTiers(requestedTiers) };
}

function unknownSelectorResult(selector: string): BenchmarkCaseResult {
	return {
		id: `unknown-selector:${selector}`,
		tier: "unknown",
		status: "failed",
		durationMs: 0,
		score: 0,
		summary: `Unknown benchmark id or tier: ${selector}. Use /bench list to see available tiers and benchmark ids.`,
		details: { selector },
	};
}

export function runBenchmarks(cwd: string, ids?: string[]): BenchmarkRunResult {
	const selection = selectBenchmarks(cwd, ids);
	const started = Date.now();
	const startedAt = new Date(started).toISOString();
	const results = [...selection.selected.map((benchmark) => timeCase(benchmark, cwd)), ...selection.unknownSelectors.map(unknownSelectorResult)];
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
		tiers: selection.tiers,
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

export function formatBenchmarkList(cwd?: string): string {
	const benchmarks = cwd ? availableBenchmarks(cwd) : builtInBenchmarks();
	const lines = ["Pi config benchmarks by tier:"];
	for (const tier of BENCHMARK_TIERS) {
		lines.push(`${tier}:`);
		const tierBenchmarks = benchmarks.filter((benchmark) => benchmark.tier === tier);
		if (tierBenchmarks.length === 0) {
			lines.push(tier === "regression" ? `  (no regression seeds configured${cwd ? ` in ${regressionSeedRoot(cwd)}` : ""})` : "  (none configured)");
			continue;
		}
		for (const benchmark of tierBenchmarks) {
			lines.push(`  - ${benchmark.id}: ${benchmark.description}`);
		}
	}
	return lines.join("\n");
}

export function formatBenchmarkResult(result: BenchmarkRunResult, file?: string): string {
	const tiers = resultTiers(result);
	const lines = [
		`Benchmark run ${result.id}`,
		`Tiers: ${formatTiers(tiers)}`,
		`Score: ${result.totalScore.toFixed(2)} (${result.passed} passed / ${result.failed} failed)`,
		`Duration: ${result.durationMs}ms`,
	];
	if (file) lines.push(`Saved: ${file}`);
	lines.push("");
	if (result.results.length === 0) {
		lines.push("- No benchmarks selected for the requested tier or benchmark id.");
	} else {
		for (const item of result.results) {
			lines.push(`- ${item.status === "passed" ? "✓" : "✗"} [${item.tier ?? "unknown"}] ${item.id}: ${item.summary}`);
		}
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
		`Previous: ${previous.id} score ${previous.totalScore.toFixed(2)} (tiers: ${formatTiers(resultTiers(previous))})`,
		`Latest: ${latest.id} score ${latest.totalScore.toFixed(2)} (tiers: ${formatTiers(resultTiers(latest))})`,
		`Delta: ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`,
		`Latest failures: ${latest.results.filter((result) => result.status === "failed").map((result) => `[${result.tier ?? "unknown"}] ${result.id}`).join(", ") || "none"}`,
	].join("\n");
}

function parseBenchArgs(args: string): { action: string; ids: string[] } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	return { action: tokens[0] ?? "list", ids: tokens.slice(1) };
}

export default function agentBenchmarkExtension(pi: ExtensionAPI) {
	pi.registerCommand("bench", {
		description: "Run local Pi config benchmarks: /bench [list|run|compare] [tier|benchmark-id...]",
		handler: async (args, ctx) => {
			const { action, ids } = parseBenchArgs(args);
			if (action === "list") {
				pi.sendMessage?.({ customType: "agent-benchmark", content: formatBenchmarkList(ctx.cwd), display: true, details: {} });
				return;
			}
			if (action === "compare") {
				pi.sendMessage?.({ customType: "agent-benchmark", content: formatBenchmarkCompare(ctx.cwd), display: true, details: {} });
				return;
			}
			if (action !== "run") {
				ctx.ui.notify("Usage: /bench list | /bench run [tier|id...] | /bench compare", "error");
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
			ids: Type.Optional(Type.Array(Type.String(), { description: "Optional benchmark ids or tiers for action=run." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.action === "list") return { content: [{ type: "text" as const, text: formatBenchmarkList(ctx.cwd) }], details: { benchmarks: availableBenchmarks(ctx.cwd).map((benchmark) => ({ id: benchmark.id, tier: benchmark.tier })) } };
			if (params.action === "compare") return { content: [{ type: "text" as const, text: formatBenchmarkCompare(ctx.cwd) }], details: { files: listBenchmarkResults(ctx.cwd) } };
			const result = runBenchmarks(ctx.cwd, params.ids);
			const file = writeBenchmarkResult(ctx.cwd, result);
			return { content: [{ type: "text" as const, text: formatBenchmarkResult(result, file) }], details: { result, file } };
		},
	});
}
