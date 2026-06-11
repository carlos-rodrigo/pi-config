import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import codeIntelExtension, {
	buildAstGrepArgs,
	buildDependencyGraph,
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

test("code-intel extension registers non-semantic code navigation tools", () => {
	const tools = new Map<string, any>();
	codeIntelExtension({
		registerTool(definition: any) {
			tools.set(definition.name, definition);
		},
	} as any);

	assert.ok(tools.has("code_find"));
	assert.ok(tools.has("symbol_search"));
	assert.ok(tools.has("dependency_map"));
	assert.ok(tools.has("git_pickaxe"));
	assert.ok(tools.has("ast_search"));
});
