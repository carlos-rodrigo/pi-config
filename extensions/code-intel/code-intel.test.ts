import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

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

function symbolSearchTool(): ToolDefinition {
	let tool: ToolDefinition | undefined;
	codeIntelExtension({
		registerTool(definition) {
			if (definition.name === "symbol_search") tool = definition;
		},
	} as Pick<ExtensionAPI, "registerTool"> as ExtensionAPI);
	assert.ok(tool);
	return tool;
}

test("symbol_search exposes schema-valid structured results without changing text or details", async (t) => {
	const dir = makeProject({
		"src/checkout.ts": "export function checkout() { return true; }\n",
		"src/session.ts": "export function readSession() { return true; }\n",
	});
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const tool = symbolSearchTool();
	assert.ok(tool.outputSchema, "codemode needs an output schema to receive structured data");
	assert.equal(tool.exposure ?? "direct", "direct");

	const outputs = await Promise.all(["checkout", "readSession", "missingSymbol"].map(async (query) => {
		const result = await tool.execute("call-" + query, { query, limit: 1 }, undefined, undefined, { cwd: dir } as ExtensionToolContext);
		const expected = { query, results: searchSymbols(dir, { query, limit: 1 }) };
		assert.deepEqual(result.structuredContent, expected);
		assert.deepEqual(result.details, expected);
		assert.equal(Value.Check(tool.outputSchema!, result.structuredContent), true);
		assert.deepEqual(result.content, [{ type: "text", text: formatSymbolResults(query, expected.results) }]);
		return result.structuredContent as typeof expected;
	}));
	assert.equal(outputs[2].results.length, 0);
	assert.equal(Value.Check(tool.outputSchema, { query: "checkout", results: [{ name: "checkout" }] }), false);
	assert.equal(Value.Check(tool.outputSchema, { query: "checkout", results: [{ ...outputs[0].results[0], kind: "invalid" }] }), false);
	assert.equal(Value.Check(tool.outputSchema, { query: "checkout", results: [{ ...outputs[0].results[0], line: 0 }] }), false);

	// Consumers can use reported paths and lines without parsing the display text.
	const result = outputs[0].results[0];
	const source = await readFile(join(dir, result.path), "utf8");
	assert.equal(source.split("\n")[result.line - 1], result.signature);
});

test("symbol_search structured output preserves cancellation", async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		symbolSearchTool().execute("cancelled", { query: "checkout" }, controller.signal, undefined, { cwd: process.cwd() } as ExtensionToolContext),
		(error: unknown) => error instanceof Error && error.name === "AbortError",
	);
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
