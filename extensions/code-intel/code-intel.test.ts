import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertStructuredContent } from "../lib/assert-structured-content.ts";

import codeIntelExtension, {
	buildAstGrepArgs,
	buildDependencyGraph,
	isDependencyGraphFresh,
	taskContextGraph,
	formatTaskContextGraph,
	codeFind,
	formatCodeFindResults,
	formatDependencyMap,
	formatGitPickaxeResults,
	formatSymbolResults,
	inferCodeFindStrategies,
	parseGitPickaxeLog,
	searchSymbols,
} from "./index.ts";

function makeProject(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-code-intel-test-"));
	for (const [relativePath, content] of Object.entries(files)) {
		const fullPath = join(dir, relativePath);
		mkdirSync(join(fullPath, ".."), { recursive: true });
		writeFileSync(fullPath, content, "utf8");
	}
	return dir;
}

test("symbol_search finds exported functions, classes, and types", () => {
	const dir = makeProject({
		"src/payments/checkout.ts": `export async function createCheckoutSession(customerId: string) {
	return customerId;
}

export class CheckoutController {}
export type CheckoutStatus = "open" | "paid";
`,
		"src/auth/session.ts": "export function readSessionToken(cookie: string) { return cookie; }\n",
	});
	try {
		const results = searchSymbols(dir, { query: "checkout", limit: 10 });
		const formatted = formatSymbolResults("checkout", results);

		assert.deepEqual(new Set(results.map((result) => result.name)), new Set([
			"createCheckoutSession",
			"CheckoutController",
			"CheckoutStatus",
		]));
		assert.match(formatted, /src\/payments\/checkout\.ts:1/);
		assert.match(formatted, /function createCheckoutSession/);
		assert.match(formatted, /class CheckoutController/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("dependency_map resolves local imports and reverse dependents", () => {
	const dir = makeProject({
		"src/payments/checkout.ts": `import { formatMoney } from "../money";
import Stripe from "stripe";
export function checkout() { return formatMoney(42); }
`,
		"src/money.ts": "export function formatMoney(value: number) { return `$${value}`; }\n",
		"src/app.ts": "import { checkout } from './payments/checkout';\ncheckout();\n",
	});
	try {
		const graph = buildDependencyGraph(dir);
		const formatted = formatDependencyMap(graph, "src/payments/checkout.ts");

		assert.match(formatted, /Imports:/);
		assert.match(formatted, /src\/money\.ts/);
		assert.match(formatted, /External: stripe/);
		assert.match(formatted, /Imported by:/);
		assert.match(formatted, /src\/app\.ts/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("repository graph includes symbols, test associations, and freshness", () => {
	const dir = makeProject({
		"src/money.ts": "export function formatMoney(value: number) { return `$${value}`; }\n",
		"src/payments/checkout.ts": "import { formatMoney } from '../money';\nexport function checkout() { return formatMoney(42); }\n",
		"src/payments/checkout.test.ts": "import { checkout } from './checkout';\ncheckout();\n",
	});
	try {
		const graph = buildDependencyGraph(dir);
		assert.deepEqual(graph.testFiles, ["src/payments/checkout.test.ts"]);
		assert.equal(graph.nodes["src/payments/checkout.ts"]?.symbols[0]?.name, "checkout");
		assert.deepEqual(graph.nodes["src/payments/checkout.ts"]?.tests, ["src/payments/checkout.test.ts"]);
		assert.equal(isDependencyGraphFresh(graph), true);

		writeFileSync(join(dir, "src/money.ts"), "export function formatMoney(value: number) { return String(value); }\n", "utf8");
		assert.equal(isDependencyGraphFresh(graph), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("repository graph handles an empty repository", () => {
	const dir = makeProject({});
	try {
		const graph = buildDependencyGraph(dir);
		assert.deepEqual(graph.files, []);
		assert.deepEqual(graph.testFiles, []);
		assert.match(graph.fingerprint, /^[a-f0-9]{64}$/);
		assert.equal(isDependencyGraphFresh(graph), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("code_find combines exact, symbol, and semantic candidates", async () => {
	const dir = makeProject({
		"src/payments/checkout.ts": `export async function createCheckoutSession(customerId: string) {
	return stripe.checkout.sessions.create({ mode: "payment", customer: customerId });
}
`,
		"src/auth/session.ts": "export function readSessionToken(cookie: string) { return cookie; }\n",
	});
	try {
		const report = await codeFind(dir, { query: "where do we charge a customer?", limit: 5, useSemantic: true });
		const formatted = formatCodeFindResults(report);
		const checkout = report.results.find((result) => result.path === "src/payments/checkout.ts");

		assert.ok(checkout, "expected checkout file to be returned");
		assert.ok(checkout!.strategies.some((strategy) => ["exact", "symbol", "semantic"].includes(strategy)));
		assert.match(formatted, /Code find results/);
		assert.match(formatted, /src\/payments\/checkout\.ts/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("task context graph returns bounded, explainable code and documentation context", async () => {
	const dir = makeProject({
		"src/money.ts": "export function formatMoney(value: number) { return `$${value}`; }\n",
		"src/payments/checkout.ts": "import { formatMoney } from '../money';\nexport function checkout() { return formatMoney(42); }\n",
		"src/payments/checkout.test.ts": "import { checkout } from './checkout';\ncheckout();\n",
		"src/app.ts": "import { checkout } from './payments/checkout';\ncheckout();\n",
		"docs/payments.md": "Checkout payment behavior and verification.\n",
	});
	try {
		const report = await taskContextGraph(dir, { task: "checkout payment", limit: 3, useSemantic: false });
		const formatted = formatTaskContextGraph(report);
		assert.equal(report.files.length, 3);
		assert.ok(report.files.some((file) => file.path === "src/payments/checkout.ts"));
		assert.ok(report.files.some((file) => file.tests.includes("src/payments/checkout.test.ts")));
		assert.ok(report.documentation.some((result) => result.path === "docs/payments.md"));
		assert.ok(report.files.every((file) => file.reasons.length > 0));
		assert.match(formatted, /Suggested verification:/);
		assert.match(formatted, /bash scripts\/verify\.sh/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("code_find auto strategy inference favors exact and symbol search for identifiers", () => {
	assert.deepEqual(inferCodeFindStrategies({ query: "createCheckoutSession", intent: "auto" }), ["exact", "symbol", "semantic"]);
	assert.deepEqual(inferCodeFindStrategies({ query: "why did checkout behavior change", intent: "auto" }), ["semantic", "history", "exact", "symbol"]);
	assert.deepEqual(inferCodeFindStrategies({ query: "checkout", intent: "impact", path: "src/payments/checkout.ts" }), ["impact"]);
});

test("git pickaxe parser formats commit hits", () => {
	const log = [
		["abc123def456", "abc123d", "2026-05-03", "Alice", "Add checkout charge flow"].join("\x1f"),
		["def456abc123", "def456a", "2026-05-04", "Bob", "Rename billing helper"].join("\x1f"),
	].join("\n");

	const results = parseGitPickaxeLog(log);
	const formatted = formatGitPickaxeResults("stripe.checkout", "string", results);

	assert.equal(results.length, 2);
	assert.equal(results[0].shortHash, "abc123d");
	assert.match(formatted, /Add checkout charge flow/);
	assert.match(formatted, /Alice/);
});

test("ast_search builds safe ast-grep arguments", () => {
	assert.deepEqual(buildAstGrepArgs({ pattern: "console.log($A)", lang: "ts", paths: ["src"] }), [
		"--pattern",
		"console.log($A)",
		"--lang",
		"ts",
		"--json",
		"src",
	]);
});

test("code-intel tools honor already-aborted signals", async () => {
	const tools = new Map<string, any>();
	codeIntelExtension({
		registerTool(definition: any) {
			tools.set(definition.name, definition);
		},
	} as any);
	const controller = new AbortController();
	controller.abort();

	await assert.rejects(
		tools.get("git_pickaxe").execute("call-1", { query: "value" }, controller.signal, undefined, { cwd: process.cwd() }),
		(error: any) => error?.name === "AbortError",
	);
});

test("task_context_graph tool executes a read-only report", async () => {
	const dir = makeProject({ "src/checkout.ts": "export function checkout() { return true; }\n" });
	try {
		const tools = new Map<string, any>();
		codeIntelExtension({ registerTool(definition: any) { tools.set(definition.name, definition); } } as any);
		const result = await tools.get("task_context_graph").execute("call-1", { task: "checkout", limit: 2, useSemantic: false }, new AbortController().signal, undefined, { cwd: dir });
		assert.match(result.content[0].text, /Task context for/);
		assert.match(result.content[0].text, /src\/checkout\.ts/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("code-intel extension registers non-semantic code navigation tools", () => {
	const tools = new Map<string, any>();
	codeIntelExtension({
		registerTool(definition: any) {
			tools.set(definition.name, definition);
		},
	} as any);

	assert.ok(tools.has("code_find"));
	assert.ok(tools.has("task_context_graph"));
	assert.ok(tools.has("symbol_search"));
	assert.ok(tools.has("dependency_map"));
	assert.ok(tools.has("git_pickaxe"));
	assert.ok(tools.has("ast_search"));
});

function registeredTools(): Map<string, any> {
	const tools = new Map<string, any>();
	codeIntelExtension({ registerTool(definition: any) { tools.set(definition.name, definition); } } as any);
	return tools;
}

async function runTool(name: string, params: Record<string, unknown>, cwd: string) {
	const tool = registeredTools().get(name);
	const result = await tool.execute("call-1", params, new AbortController().signal, undefined, { cwd });
	return { result, data: assertStructuredContent(tool, result) };
}

async function withPath<T>(pathValue: string, run: () => Promise<T>): Promise<T> {
	const previous = process.env.PATH;
	process.env.PATH = pathValue;
	try {
		return await run();
	} finally {
		process.env.PATH = previous;
	}
}

async function withFakeAstGrep<T>(stdout: string, run: () => Promise<T>): Promise<T> {
	const binDir = mkdtempSync(join(tmpdir(), "pi-code-intel-sg-"));
	writeFileSync(join(binDir, "sg"), `#!/bin/sh\ncat <<'JSON'\n${stdout}\nJSON\n`, "utf8");
	chmodSync(join(binDir, "sg"), 0o755);
	try {
		return await withPath(`${binDir}:/usr/bin:/bin`, run);
	} finally {
		rmSync(binDir, { recursive: true, force: true });
	}
}

function astGrepJson(count: number): string {
	return JSON.stringify(Array.from({ length: count }, (_, index) => ({
		text: `console.log(${index + 1})`,
		file: `src/file${index + 1}.ts`,
		language: "TypeScript",
		range: { byteOffset: { start: 0, end: 14 }, start: { line: index, column: 2 }, end: { line: index, column: 16 } },
	})));
}

test("code_find and symbol_search return structured locations for Code Mode", async () => {
	const dir = makeProject({ "src/checkout.ts": "export function createCheckout() {\n\treturn true;\n}\n" });
	try {
		const found = await runTool("code_find", { query: "createCheckout", intent: "symbol" }, dir);
		assert.match(found.result.content[0].text, /Code find results/);
		assert.equal(found.data.query, "createCheckout");
		assert.ok(found.data.results.some((hit: any) => hit.path === "src/checkout.ts" && hit.line === 1 && hit.strategies.includes("symbol")));

		const empty = await runTool("code_find", { query: "zzzNoSuchSymbol", intent: "exact" }, dir);
		assert.deepEqual(empty.data.results, []);

		const symbols = await runTool("symbol_search", { query: "createCheckout" }, dir);
		assert.match(symbols.result.content[0].text, /createCheckout/);
		assert.deepEqual(symbols.data.results.map((symbol: any) => [symbol.path, symbol.line, symbol.kind]), [["src/checkout.ts", 1, "function"]]);

		const noSymbols = await runTool("symbol_search", { query: "zzzNoSuchSymbol" }, dir);
		assert.deepEqual(noSymbols.data, { query: "zzzNoSuchSymbol", results: [] });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("task_context_graph returns structured files with bounded symbols", async () => {
	const functions = Array.from({ length: 25 }, (_, index) => `export function checkoutStep${index}() { return ${index}; }`).join("\n");
	const dir = makeProject({ "src/checkout.ts": `${functions}\n` });
	try {
		const { result, data } = await runTool("task_context_graph", { task: "checkoutStep", limit: 2, useSemantic: false }, dir);
		assert.equal(data.task, "checkoutStep");
		assert.equal(data.graph.files, 1);
		const file = data.files.find((candidate: any) => candidate.path === "src/checkout.ts");
		assert.equal(file.symbolCount, 25);
		assert.equal(file.symbols.length, 20);
		assert.equal(result.details.files[0].symbols.length, 25);

		const unrelated = await runTool("task_context_graph", { task: "zzzNoSuchTask", useSemantic: false }, dir);
		assert.deepEqual(unrelated.data.files, []);
		assert.deepEqual(unrelated.data.documentation, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("code_find structure and impact results carry located data while keeping text", async () => {
	const dir = makeProject({ "src/a.ts": "import { b } from './b';\nexport const a = b;\n", "src/b.ts": "export const b = 1;\n" });
	try {
		const impact = await runTool("code_find", { query: "impact", intent: "impact", path: "src/b.ts" }, dir);
		assert.match(impact.result.content[0].text, /Dependency map for src\/b\.ts/);
		assert.deepEqual(impact.data.results[0].dependencies.file, { path: "src/b.ts", imports: [], importedBy: ["src/a.ts"], external: [] });

		await withFakeAstGrep(astGrepJson(3), async () => {
			const { result, data } = await runTool("code_find", { query: "console.log($A)", intent: "structure", limit: 2 }, dir);
			const structure = data.results.find((hit: any) => hit.strategies.includes("structure"));
			assert.deepEqual(structure.matches.map((match: any) => `${match.path}:${match.line}`), ["src/file1.ts:1", "src/file2.ts:2"]);
			assert.equal(structure.matchesTruncated, true);
			assert.match(result.content[0].text, /ast-grep structural search/);
		});
		await withFakeAstGrep("not json", async () => {
			const { result, data } = await runTool("code_find", { query: "console.log($A)", intent: "structure" }, dir);
			const structure = data.results.find((hit: any) => hit.strategies.includes("structure"));
			assert.equal(structure.preview.trim(), "not json");
			assert.equal(structure.matches, undefined);
			assert.match(result.content[0].text, /not json/);
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("dependency_map returns structured target and overview relationships", async () => {
	const dir = makeProject({
		"src/a.ts": "import { b } from './b';\nimport z from 'zod';\nexport const a = b;\n",
		"src/b.ts": "export const b = 1;\n",
	});
	try {
		const target = await runTool("dependency_map", { path: "src/a.ts" }, dir);
		assert.equal(target.result.content[0].text, "Dependency map for src/a.ts:\n\nImports:\n- src/b.ts\n- External: zod\n\nImported by:\n- none");
		assert.deepEqual(target.data.file, { path: "src/a.ts", imports: ["src/b.ts"], importedBy: [], external: ["zod"] });
		assert.equal(target.data.topFiles, undefined);

		const overview = await runTool("dependency_map", { path: "missing.ts" }, dir);
		assert.equal(overview.result.content[0].text, "Dependency map (2 source files):\n\n1. src/a.ts — imports 1, imported by 0\n2. src/b.ts — imports 0, imported by 1");
		assert.equal(overview.data.requestedPath, "missing.ts");
		assert.equal(overview.data.file, undefined);
		assert.deepEqual(overview.data.topFiles.map((file: any) => [file.path, file.importCount, file.importedByCount]), [["src/a.ts", 1, 0], ["src/b.ts", 0, 1]]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("git_pickaxe returns structured commits", async () => {
	const dir = makeProject({ "src/flag.ts": "export const featureFlag = true;\n" });
	try {
		const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd: dir, stdio: "ignore" });
		git("init", "-q");
		git("add", ".");
		git("commit", "-q", "-m", "Add feature flag");

		const { data } = await runTool("git_pickaxe", { query: "featureFlag" }, dir);
		assert.equal(data.mode, "string");
		assert.deepEqual(data.results.map((commit: any) => [commit.subject, commit.author]), [["Add feature flag", "Test"]]);
		assert.match(data.results[0].hash, /^[0-9a-f]{40}$/);

		const empty = await runTool("git_pickaxe", { query: "notInHistory" }, dir);
		assert.deepEqual(empty.data.results, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("ast_search returns bounded structured matches from ast-grep JSON", async () => {
	const dir = makeProject({});
	try {
		await withFakeAstGrep(astGrepJson(3), async () => {
			const { result, data } = await runTool("ast_search", { pattern: "console.log($A)", lang: "ts", limit: 2 }, dir);
			assert.match(result.content[0].text, /console\.log\(1\)/);
			assert.equal(data.available, true);
			assert.equal(data.truncated, true);
			assert.deepEqual(data.matches[0], { path: "src/file1.ts", line: 1, column: 3, endLine: 1, endColumn: 17, text: "console.log(1)" });
			assert.equal(data.matches.length, 2);
		});
		await withFakeAstGrep("[]", async () => {
			const { data } = await runTool("ast_search", { pattern: "console.log($A)" }, dir);
			assert.deepEqual(data, { pattern: "console.log($A)", available: true, matches: [], truncated: false });
		});
		await withFakeAstGrep("not json", async () => {
			const tool = registeredTools().get("ast_search");
			await assert.rejects(tool.execute("call-1", { pattern: "console.log($A)" }, new AbortController().signal, undefined, { cwd: dir }), /did not return a JSON match array/);
		});
		await withPath("/usr/bin:/bin", async () => {
			const { result, data } = await runTool("ast_search", { pattern: "console.log($A)" }, dir);
			assert.match(result.content[0].text, /requires ast-grep CLI/);
			assert.deepEqual(data, { pattern: "console.log($A)", available: false, matches: [], truncated: false });
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

