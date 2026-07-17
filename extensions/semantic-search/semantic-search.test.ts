import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import semanticSearchExtension, {
	buildRebuildProgressSnapshot,
	buildSearchIndex,
	buildSearchIndexWithEmbeddings,
	createRepoMap,
	formatBackgroundRebuildIndicator,
	formatOllamaTunnelSshCommand,
	formatRepoMap,
	formatSearchResults,
	getIndexStatus,
	loadSearchIndex,
	parseIndexCommandArgs,
	parseOllamaTunnelCommandArgs,
	parseSearchIndexJson,
	resolveOllamaEmbeddingConfig,
	resolveOllamaSummaryConfig,
	searchIndex,
	searchIndexWithEmbeddings,
	serializeSearchIndexForJson,
} from "./index.ts";

function makeProject(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-semantic-search-test-"));
	for (const [relativePath, content] of Object.entries(files)) {
		const fullPath = join(dir, relativePath);
		mkdirSync(join(fullPath, ".."), { recursive: true });
		writeFileSync(fullPath, content, "utf8");
	}
	return dir;
}

test("semantic indexing never includes local .env secret files", () => {
	const dir = makeProject({
		"src/index.ts": "export const value = 1;\n",
		".env.local": "SECRET=do-not-index\n",
	});
	try {
		const index = buildSearchIndex(dir, { writeToDisk: false });
		assert.ok(index.files.some((file) => file.path === "src/index.ts"));
		assert.ok(!index.files.some((file) => file.path === ".env.local"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a copied semantic index relocates to a new worktree and validates unchanged content by hash", () => {
	const source = makeProject({ "src/index.ts": "export const value = 1;\n" });
	const target = makeProject({ "src/index.ts": "export const value = 1;\n" });

	try {
		buildSearchIndex(source, { writeToDisk: true });
		const targetIndexDir = join(target, ".pi", "semantic-search");
		mkdirSync(targetIndexDir, { recursive: true });
		copyFileSync(join(source, ".pi", "semantic-search", "index.json"), join(targetIndexDir, "index.json"));
		const future = new Date(Date.now() + 60_000);
		utimesSync(join(target, "src", "index.ts"), future, future);

		const relocated = loadSearchIndex(target);

		assert.ok(relocated, "expected the copied index to load in the target worktree");
		assert.equal(relocated.cwd, target);
		assert.deepEqual(relocated.files.map((file) => file.path), ["src/index.ts"]);
		assert.equal(getIndexStatus(target, relocated).stale, false);
	} finally {
		rmSync(source, { recursive: true, force: true });
		rmSync(target, { recursive: true, force: true });
	}
});

test("semantic index freshness detects same-size content changes even when mtimes match", () => {
	const dir = makeProject({ "src/index.ts": "export const value = 1;\n" });
	try {
		const index = buildSearchIndex(dir, { writeToDisk: false });
		const indexedMtime = index.files[0]!.mtimeMs;
		writeFileSync(join(dir, "src", "index.ts"), "export const value = 2;\n", "utf8");
		const indexedTime = new Date(indexedMtime);
		utimesSync(join(dir, "src", "index.ts"), indexedTime, indexedTime);

		const status = getIndexStatus(dir, index);
		assert.equal(status.stale, true);
		assert.equal(status.reason, "changed file: src/index.ts");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

function fakeEmbeddingFor(text: string): number[] {
	if (/money collection|invoice|ledger|reconcile/i.test(text)) return [1, 0, 0];
	if (/canvas|palette|paint/i.test(text)) return [0, 1, 0];
	return [0, 0, 1];
}

function fakeSummaryFor(prompt: string): string {
	if (/createBudgetBucket|budget/i.test(prompt)) return "Creates budget buckets from request data and calls createBudgetBucket for personal budget tracking.";
	if (/ledger|invoice|reconcile/i.test(prompt)) return "Reconciles invoice ledger balances for billing workflows.";
	if (/canvas|palette|paint/i.test(prompt)) return "Paints the UI canvas using the configured color palette.";
	return "Explains the code element's responsibility, important calls, and where it fits in the project.";
}

async function withMockOllamaFetch<T>(fn: () => Promise<T>): Promise<T> {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		const href = String(url);
		const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string | string[]; prompt?: string };
		if (href.endsWith("/api/generate")) {
			return new Response(JSON.stringify({ response: fakeSummaryFor(body.prompt ?? "") }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		const inputs = Array.isArray(body.input) ? body.input : [body.input ?? body.prompt ?? ""];
		return new Response(JSON.stringify({ embeddings: inputs.map(fakeEmbeddingFor) }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	try {
		return await fn();
	} finally {
		globalThis.fetch = originalFetch;
	}
}

async function withMockLegacyOllamaFetch<T>(fn: (urls: string[]) => Promise<T>): Promise<T> {
	const originalFetch = globalThis.fetch;
	const urls: string[] = [];
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		const href = String(url);
		urls.push(href);
		const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: string };
		if (href.endsWith("/api/generate")) {
			return new Response(JSON.stringify({ response: fakeSummaryFor(body.prompt ?? "") }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (href.endsWith("/api/embed")) {
			return new Response("not found", { status: 404, statusText: "Not Found" });
		}
		return new Response(JSON.stringify({ embedding: fakeEmbeddingFor(body.prompt ?? "") }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	try {
		return await fn(urls);
	} finally {
		globalThis.fetch = originalFetch;
	}
}

test("semantic search finds billing code from a natural-language charge query", () => {
	const dir = makeProject({
		"src/payments/checkout.ts": `import Stripe from "stripe";

export async function createCheckoutSession(customerId: string) {
	const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
	return stripe.checkout.sessions.create({
		mode: "payment",
		customer: customerId,
		line_items: [{ price: "price_123", quantity: 1 }],
	});
}
`,
		"src/auth/session.ts": `export function readSessionToken(cookie: string) {
	return cookie.replace("session=", "");
}
`,
	});
	try {
		const index = buildSearchIndex(dir, { writeToDisk: false });
		const results = searchIndex(index, { query: "where do we charge a customer?", topK: 3 });

		assert.equal(results[0]?.path, "src/payments/checkout.ts");
		assert.ok(results[0]?.score && results[0].score > 0, "expected a positive search score");
		assert.ok(results[0]?.reason.some((part) => /billing|stripe|checkout|payment/i.test(part)));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("implementation-location queries prefer source creation code over docs and tests", () => {
	const dir = makeProject({
		"docs/prd.md": `# Personal budget

Users need a personal budget. The budget is created during onboarding and tracked monthly.`,
		"packages/domain/test/finance.test.mjs": `export function budgetBucket() {
	return { type: "Personal budget", createdAt: new Date() };
}
`,
		"apps/web/app/api/circles/[circleId]/budgets/route.ts": `export async function GET() {
	return listBudgets();
}

export async function POST(request: Request) {
	const body = await request.json();
	return createBudgetBucket(body.circleId, body.amount);
}
`,
	});
	try {
		const index = buildSearchIndex(dir, { writeToDisk: false });
		const results = searchIndex(index, { query: "where the budget is created", topK: 3 });

		assert.equal(results[0]?.path, "apps/web/app/api/circles/[circleId]/budgets/route.ts");
		assert.ok(results[0]?.reason.some((part) => /implementation\/creation intent match/i.test(part)));
		assert.ok(!results.slice(0, 2).some((result) => /^docs\//.test(result.path)), "docs should not crowd out implementation answers");

		const formatted = formatSearchResults("where the budget is created", results, index);
		assert.match(formatted, /Why: function POST covers post/i);
		assert.match(formatted, /createBudgetBucket/);
		assert.match(formatted, /Matched because:/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("formatted search results include read-ready file ranges and compact previews", () => {
	const dir = makeProject({
		"src/ui/modal.ts": `export class ModalRenderer {
	render(theme: Theme) {
		return theme.fg("accent", "Open file picker");
	}
}
`,
	});
	try {
		const index = buildSearchIndex(dir, { writeToDisk: false });
		const results = searchIndex(index, { query: "modal theme renderer", topK: 1 });
		const formatted = formatSearchResults("modal theme renderer", results, index);

		assert.match(formatted, /src\/ui\/modal\.ts:1-5/);
		assert.match(formatted, /Score:/);
		assert.match(formatted, /Preview:/);
		assert.match(formatted, /ModalRenderer/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("semantic cards summarize files and symbols for meaning-oriented search", () => {
	const dir = makeProject({
		"app/controllers/sessions_controller.rb": `class SessionsController < ApplicationController
	before_action :authenticate_user!, only: :destroy

	# Signs users in after checking credentials.
	def create
		user = User.find_by(email: params[:email])
		sign_in(user)
		redirect_to dashboard_path
	end
end
`,
		"app/services/report_builder.rb": `class ReportBuilder
	def call
		render_pdf
	end
end
`,
	});
	try {
		const index = buildSearchIndex(dir, { writeToDisk: false });
		const methodCard = index.cards.find((card) => card.name === "SessionsController#create");

		assert.ok(index.cards.length >= index.files.length, "expected at least one semantic card per file");
		assert.equal(methodCard?.kind, "method");
		assert.match(methodCard?.summary ?? "", /auth|sign_in|session|credentials/i);

		const results = searchIndex(index, { query: "where are users authenticated or signed in?", topK: 5 });
		assert.ok(results.some((result) => result.source === "card" && result.path === "app/controllers/sessions_controller.rb"));
		assert.match(formatSearchResults("where are users authenticated or signed in?", results, index), /semantic card/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Ollama embeddings are stored locally and used for semantic ranking", async () => {
	const dir = makeProject({
		"src/billing/ledger.ts": `export function reconcileLedger() {
	return normalizeInvoiceBalance();
}
`,
		"src/ui/canvas.ts": `export function paintCanvas() {
	return colorPalette.primary;
}
`,
	});
	try {
		await withMockOllamaFetch(async () => {
			const index = await buildSearchIndexWithEmbeddings(dir, {
				writeToDisk: false,
				ollama: { model: "nomic-embed-text", baseUrl: "http://ollama.test" },
			});
			assert.equal(index.embedding?.provider, "ollama");
			assert.equal(index.embedding?.model, "nomic-embed-text");
			assert.equal(index.embedding?.inputMaxChars, 6_000);
			assert.equal(index.embedding?.dimensions, 3);
			assert.ok((index.embedding?.embeddedCards ?? 0) > 0);
			assert.ok(index.chunks.every((chunk) => Array.isArray(chunk.embedding)));
			assert.ok(index.cards.every((card) => Array.isArray(card.embedding)));

			const { results, embeddingUsed } = await searchIndexWithEmbeddings(index, {
				query: "where is money collection handled?",
				topK: 2,
				ollama: { model: "nomic-embed-text", baseUrl: "http://ollama.test" },
			});

			assert.equal(embeddingUsed, true);
			assert.equal(results[0]?.path, "src/billing/ledger.ts");
			assert.ok(results[0]?.embeddingScore && results[0].embeddingScore > 0.9);
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("embedding index uses Ollama-generated card summaries by default and caches them", async () => {
	const dir = makeProject({
		"src/finance/budget.ts": `export async function createBudgetBucket(circleId: string, amount: number) {
	return db.budgetBucket.create({ data: { circleId, amount } });
}
`,
	});
	const originalFetch = globalThis.fetch;
	let generateCalls = 0;
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		const href = String(url);
		const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string | string[]; prompt?: string };
		if (href.endsWith("/api/generate")) {
			generateCalls++;
			return new Response(JSON.stringify({ response: fakeSummaryFor(body.prompt ?? "") }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		const inputs = Array.isArray(body.input) ? body.input : [body.input ?? body.prompt ?? ""];
		return new Response(JSON.stringify({ embeddings: inputs.map(fakeEmbeddingFor) }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	try {
		const first = await buildSearchIndexWithEmbeddings(dir, {
			writeToDisk: true,
			ollama: { model: "nomic-embed-text", baseUrl: "http://ollama.test" },
			summary: { model: "qwen2.5-coder:14b", baseUrl: "http://ollama.test", concurrency: 2 },
		});
		const generatedCalls = generateCalls;
		const card = first.cards.find((candidate) => candidate.name === "createBudgetBucket");

		assert.ok(generatedCalls > 0, "expected Ollama summary generation calls");
		assert.equal(first.summary?.model, "qwen2.5-coder:14b");
		assert.equal(first.summary?.failedCards, 0);
		assert.match(card?.summary ?? "", /Creates budget buckets/i);
		assert.match(card?.text ?? "", /Summary: Creates budget buckets/i);

		const second = await buildSearchIndexWithEmbeddings(dir, {
			writeToDisk: true,
			ollama: { model: "nomic-embed-text", baseUrl: "http://ollama.test" },
			summary: { model: "qwen2.5-coder:14b", baseUrl: "http://ollama.test", concurrency: 2 },
		});

		assert.equal(generateCalls, generatedCalls, "unchanged cards should use the summary cache");
		assert.ok((second.summary?.cachedCards ?? 0) > 0);
	} finally {
		globalThis.fetch = originalFetch;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("embedding index JSON stores vectors in compact float32 encoding", () => {
	const dir = makeProject({
		"src/billing/ledger.ts": "export function reconcileLedger() { return normalizeInvoiceBalance(); }\n",
	});
	try {
		const index = buildSearchIndex(dir, { writeToDisk: false });
		const embedding = Array.from({ length: 768 }, (_value, offset) => Math.sin(offset + 0.123456789));
		index.chunks = index.chunks.map((chunk) => ({ ...chunk, embedding }));
		index.cards = index.cards.map((card) => ({ ...card, embedding }));
		index.embedding = {
			provider: "ollama",
			model: "nomic-embed-text",
			baseUrl: "http://ollama.test",
			inputMaxChars: 6_000,
			dimensions: embedding.length,
			embeddedChunks: index.chunks.length,
			embeddedCards: index.cards.length,
			createdAt: new Date().toISOString(),
		};

		const numericJson = JSON.stringify(index);
		const compactJson = serializeSearchIndexForJson(index);
		assert.match(compactJson, /"encoding":"base64-f32"/);
		assert.ok(compactJson.length < numericJson.length / 2, "expected compact embedding storage to avoid huge JSON strings");

		const parsed = parseSearchIndexJson(compactJson);
		assert.equal(parsed.embedding?.dimensions, embedding.length);
		assert.equal(parsed.chunks[0]?.embedding?.length, embedding.length);
		assert.ok(Math.abs((parsed.chunks[0]?.embedding?.[123] ?? 0) - embedding[123]) < 1e-6);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Ollama embedding client caps oversized inputs before sending them to Ollama", async () => {
	const dir = makeProject({
		"src/large.ts": `export const oversized = "${"token ".repeat(1_000)}";\n`,
	});
	const originalFetch = globalThis.fetch;
	const seenInputs: string[] = [];
	globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string | string[] };
		const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
		seenInputs.push(...inputs);
		return new Response(JSON.stringify({ embeddings: inputs.map(fakeEmbeddingFor) }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	try {
		const index = await buildSearchIndexWithEmbeddings(dir, {
			writeToDisk: false,
			ollama: { model: "nomic-embed-text", baseUrl: "http://ollama.test", maxInputChars: 400 },
			summary: false,
		});

		assert.equal(index.embedding?.inputMaxChars, 400);
		assert.ok(seenInputs.length > 0);
		assert.ok(seenInputs.every((input) => input.length <= 400));
		assert.ok(seenInputs.some((input) => input.includes("semantic-search input truncated")));
	} finally {
		globalThis.fetch = originalFetch;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Ollama embedding client splits batches and shrinks inputs after context-length errors", async () => {
	const dir = makeProject({
		"src/large.ts": `export const oversized = "${"token ".repeat(1_000)}";\n`,
		"src/small.ts": "export const small = 'invoice ledger';\n",
	});
	const originalFetch = globalThis.fetch;
	const calls: Array<{ count: number; maxLength: number }> = [];
	globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string | string[] };
		const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
		calls.push({ count: inputs.length, maxLength: Math.max(...inputs.map((input) => input.length)) });
		if (inputs.some((input) => input.length > 160)) {
			return new Response(JSON.stringify({ error: "the input length exceeds the context length" }), {
				status: 400,
				statusText: "Bad Request",
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ embeddings: inputs.map(fakeEmbeddingFor) }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	try {
		const index = await buildSearchIndexWithEmbeddings(dir, {
			writeToDisk: false,
			ollama: { model: "nomic-embed-text", baseUrl: "http://ollama.test", batchSize: 2, maxInputChars: 500 },
			summary: false,
		});

		assert.equal(index.embedding?.embeddedChunks, 2);
		assert.ok(index.chunks.every((chunk) => Array.isArray(chunk.embedding)));
		assert.ok(calls.some((call) => call.count === 2 && call.maxLength > 160));
		assert.ok(calls.some((call) => call.count === 1 && call.maxLength <= 160));
	} finally {
		globalThis.fetch = originalFetch;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Ollama embedding client falls back to the legacy embeddings endpoint", async () => {
	const dir = makeProject({
		"src/billing/legacy.ts": "export function normalizeInvoiceBalance() { return reconcileLedger(); }\n",
	});
	try {
		await withMockLegacyOllamaFetch(async (urls) => {
			const index = await buildSearchIndexWithEmbeddings(dir, {
				writeToDisk: false,
				ollama: { model: "nomic-embed-text", baseUrl: "http://ollama.test" },
			});

			assert.equal(index.embedding?.embeddedChunks, 1);
			assert.ok(urls.some((url) => url.endsWith("/api/embed")));
			assert.ok(urls.some((url) => url.endsWith("/api/embeddings")));
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Ollama config defaults come from semantic-search config file and env can override them", () => {
	assert.deepEqual(resolveOllamaEmbeddingConfig({}, {}), {
		model: "mxbai-embed-large",
		baseUrl: "http://127.0.0.1:11435",
		batchSize: 16,
		timeoutMs: 30_000,
		maxInputChars: 6_000,
	});
	assert.deepEqual(resolveOllamaSummaryConfig({}, {}), {
		model: "qwen2.5-coder:14b",
		baseUrl: "http://127.0.0.1:11435",
		timeoutMs: 180_000,
		maxInputChars: 10_000,
		concurrency: 2,
		enabled: true,
	});
	assert.equal(resolveOllamaEmbeddingConfig({}, { OLLAMA_HOST: "localhost:11434", OLLAMA_EMBED_MODEL: "mxbai-embed-large" }).baseUrl, "http://localhost:11434");
	assert.equal(resolveOllamaEmbeddingConfig({}, { OLLAMA_HOST: "localhost:11434", OLLAMA_EMBED_MODEL: "mxbai-embed-large" }).model, "mxbai-embed-large");
	assert.equal(resolveOllamaEmbeddingConfig({}, { PI_SEMANTIC_SEARCH_EMBED_MAX_CHARS: "256" }).maxInputChars, 256);
	assert.equal(resolveOllamaSummaryConfig({}, { PI_SEMANTIC_SEARCH_SUMMARY_MODEL: "qwen2.5-coder:14b", PI_SEMANTIC_SEARCH_SUMMARIES: "false" }).model, "qwen2.5-coder:14b");
	assert.equal(resolveOllamaSummaryConfig({}, { PI_SEMANTIC_SEARCH_SUMMARIES: "false" }).enabled, false);
	assert.equal(resolveOllamaEmbeddingConfig({}, {}, { ollama: { embeddingModel: "custom-embed" } }).model, "custom-embed");
	assert.equal(resolveOllamaSummaryConfig({}, {}, { ollama: { summaryModel: "custom-summary", summaryConcurrency: 3 } }).concurrency, 3);
});

test("configured exclude paths omit generated feature HTML and hidden directories from the semantic index", () => {
	const dir = makeProject({
		"src/index.ts": "export function runSearch() { return 'ok'; }\n",
		"src/.generated/cache.ts": "export const hiddenCache = true;\n",
		".github/workflows/ci.yml": "name: ci\n",
		"docs/features/agent-memory/design.html": "<html><body>Large generated planning document</body></html>\n",
	});
	try {
		const index = buildSearchIndex(dir, { writeToDisk: false });
		assert.ok(index.files.some((file) => file.path === "src/index.ts"));
		assert.ok(!index.files.some((file) => file.path === "src/.generated/cache.ts"));
		assert.ok(!index.files.some((file) => file.path === ".github/workflows/ci.yml"));
		assert.ok(!index.files.some((file) => file.path === "docs/features/agent-memory/design.html"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("repo map clusters indexed files by reusable code concepts", () => {
	const dir = makeProject({
		"src/payments/checkout.ts": "export const checkout = () => stripe.checkout.sessions.create({ mode: 'payment' });\n",
		"src/auth/login.ts": "export function loginWithOAuth(token: string) { return createSession(token); }\n",
		"docs/design.md": "# Design\n\nThis document explains the UI workflow.\n",
	});
	try {
		const index = buildSearchIndex(dir, { writeToDisk: false });
		const map = createRepoMap(index, { maxClusters: 5 });
		const formatted = formatRepoMap(map, index);

		assert.match(formatted, /billing/i);
		assert.match(formatted, /auth/i);
		assert.match(formatted, /src\/payments\/checkout\.ts/);
		assert.match(formatted, /src\/auth\/login\.ts/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("index rebuild defaults to background and tracks progress estimates", () => {
	assert.equal(parseIndexCommandArgs("rebuild").background, true);
	assert.equal(parseIndexCommandArgs("build --foreground").background, false);
	assert.equal(parseIndexCommandArgs("lexical").background, false);
	assert.equal(parseIndexCommandArgs("rebuild --status").background, false);
	assert.match(parseIndexCommandArgs("rebuiil").error ?? "", /Did you mean '\/index rebuild'/);
	assert.equal(parseIndexCommandArgs("rebuiil").background, false);

	const progress = buildRebuildProgressSnapshot(
		"Summarized 25/100 semantic cards with qwen2.5-coder:7b",
		Date.parse("2026-05-17T13:00:00.000Z"),
		Date.parse("2026-05-17T13:01:00.000Z"),
	);
	assert.equal(progress.phase, "summarizing");
	assert.equal(progress.current, 25);
	assert.equal(progress.total, 100);
	assert.equal(progress.percent, 25);
	assert.equal(progress.estimatedRemainingMs, 180_000);
	assert.equal(formatBackgroundRebuildIndicator({ status: "running", progress }), "idx: summarizing 25% · ~3m 0s");
	assert.equal(formatBackgroundRebuildIndicator({ status: "succeeded", progress }), "idx: done");
	assert.equal(formatBackgroundRebuildIndicator({ status: "failed", progress }), "idx: failed");
	assert.equal(formatBackgroundRebuildIndicator({ status: "succeeded", progress, notified: true }), undefined);
});

test("index command refuses likely action typos instead of treating them as model names", async () => {
	const commands = new Map<string, any>();
	const messages: any[] = [];
	const notifications: any[] = [];
	semanticSearchExtension({
		registerTool() {},
		registerCommand(name: string, definition: any) {
			commands.set(name, definition);
		},
		sendMessage(message: any) {
			messages.push(message);
		},
	} as any);

	const dir = makeProject({
		"src/search/index.ts": "export function semanticSearch(query: string) { return vectorIndex.search(query); }\n",
	});
	try {
		await commands.get("index").handler("rebuiil", {
			cwd: dir,
			ui: {
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
				setStatus() {},
			},
		} as any);

		assert.match(messages[0]?.content ?? "", /Did you mean '\/index rebuild'/);
		assert.deepEqual(notifications[0]?.level, "error");
		assert.equal(existsSync(join(dir, ".pi", "semantic-search", "rebuild-status.json")), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("index command treats build as rebuild instead of an embedding model", async () => {
	const commands = new Map<string, any>();
	semanticSearchExtension({
		registerTool() {},
		registerCommand(name: string, definition: any) {
			commands.set(name, definition);
		},
	} as any);

	const dir = makeProject({
		"src/search/index.ts": "export function semanticSearch(query: string) { return vectorIndex.search(query); }\n",
	});
	const originalFetch = globalThis.fetch;
	const previousPiModel = process.env.PI_SEMANTIC_SEARCH_EMBED_MODEL;
	const previousOllamaModel = process.env.OLLAMA_EMBED_MODEL;
	const seenModels: string[] = [];
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		const href = String(url);
		const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string; input?: string | string[]; prompt?: string };
		seenModels.push(body.model ?? "");
		if (href.endsWith("/api/generate")) {
			return new Response(JSON.stringify({ response: fakeSummaryFor(body.prompt ?? "") }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
		return new Response(JSON.stringify({ embeddings: inputs.map(fakeEmbeddingFor) }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	delete process.env.PI_SEMANTIC_SEARCH_EMBED_MODEL;
	delete process.env.OLLAMA_EMBED_MODEL;

	try {
		await commands.get("index").handler("build --foreground", {
			cwd: dir,
			ui: { notify() {}, setStatus() {} },
		} as any);

		assert.ok(seenModels.length > 0, "expected the command to request Ollama");
		assert.ok(!seenModels.includes("build"), "build should be parsed as a command alias, not a model");
		assert.ok(seenModels.includes("mxbai-embed-large"));
		assert.ok(seenModels.includes("qwen2.5-coder:14b"));

		seenModels.length = 0;
		await commands.get("index").handler("build --foreground --summary-model qwen2.5-coder:32b", {
			cwd: dir,
			ui: { notify() {}, setStatus() {} },
		} as any);
		assert.ok(seenModels.includes("mxbai-embed-large"));
		assert.ok(seenModels.includes("qwen2.5-coder:32b"));
	} finally {
		globalThis.fetch = originalFetch;
		if (previousPiModel === undefined) delete process.env.PI_SEMANTIC_SEARCH_EMBED_MODEL;
		else process.env.PI_SEMANTIC_SEARCH_EMBED_MODEL = previousPiModel;
		if (previousOllamaModel === undefined) delete process.env.OLLAMA_EMBED_MODEL;
		else process.env.OLLAMA_EMBED_MODEL = previousOllamaModel;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("index rebuild writes a local index before Ollama failures", async () => {
	const commands = new Map<string, any>();
	const messages: any[] = [];
	semanticSearchExtension({
		registerTool() {},
		registerCommand(name: string, definition: any) {
			commands.set(name, definition);
		},
		sendMessage(message: any) {
			messages.push(message);
		},
	} as any);

	const dir = makeProject({
		"src/search/index.ts": "export function semanticSearch(query: string) { return vectorIndex.search(query); }\n",
	});
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response(JSON.stringify({ error: "model not found" }), {
		status: 404,
		statusText: "Not Found",
		headers: { "content-type": "application/json" },
	})) as typeof fetch;
	try {
		await commands.get("index").handler("rebuild --foreground", {
			cwd: dir,
			ui: { notify() {}, setStatus() {} },
		} as any);

		const indexPath = join(dir, ".pi", "semantic-search", "index.json");
		assert.equal(existsSync(indexPath), true, "expected rebuild to persist the base index before failing Ollama work");
		const index = parseSearchIndexJson(readFileSync(indexPath, "utf8"));
		assert.equal(index.files.length, 1);
		assert.equal(index.embedding, undefined);
		const status = JSON.parse(readFileSync(join(dir, ".pi", "semantic-search", "rebuild-status.json"), "utf8"));
		assert.equal(status.status, "failed");
		assert.match(status.error, /model not found/i);
		assert.match(messages[messages.length - 1]?.content ?? "", /Base lexical\/symbol index was written, but Ollama semantic rebuild failed/i);
		assert.match(messages[messages.length - 1]?.content ?? "", /requires local Ollama summaries and embeddings/i);
	} finally {
		globalThis.fetch = originalFetch;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("background index rebuild stays silent when it succeeds", async () => {
	const events = new Map<string, any>();
	const messages: any[] = [];
	semanticSearchExtension({
		on(name: string, handler: any) {
			events.set(name, handler);
		},
		registerTool() {},
		registerCommand() {},
		sendMessage(message: any) {
			messages.push(message);
		},
	} as any);

	const dir = makeProject({
		"src/search/index.ts": "export function semanticSearch(query: string) { return vectorIndex.search(query); }\n",
	});
	try {
		buildSearchIndex(dir, { writeToDisk: true });
		const statusDir = join(dir, ".pi", "semantic-search");
		const logPath = join(statusDir, "rebuild.log");
		writeFileSync(logPath, "[2026-05-17T13:09:45.499Z] semantic-search background rebuild finished: 1 files / 1 chunks / 1 semantic cards\n", "utf8");
		writeFileSync(join(statusDir, "rebuild-status.json"), JSON.stringify({
			status: "succeeded",
			cwd: dir,
			logPath,
			pid: process.pid,
			startedAt: "2026-05-17T13:09:44.855Z",
			finishedAt: "2026-05-17T13:09:45.499Z",
			message: "semantic-search background rebuild finished: 1 files / 1 chunks / 1 semantic cards",
		}), "utf8");

		events.get("session_start")?.({}, { cwd: dir });
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(messages.length, 0);
		const status = JSON.parse(readFileSync(join(statusDir, "rebuild-status.json"), "utf8"));
		assert.equal(status.notified, true);
	} finally {
		events.get("session_shutdown")?.();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("background index rebuild displays a follow-up when it fails", async () => {
	const events = new Map<string, any>();
	const messages: any[] = [];
	semanticSearchExtension({
		on(name: string, handler: any) {
			events.set(name, handler);
		},
		registerTool() {},
		registerCommand() {},
		sendMessage(message: any) {
			messages.push(message);
		},
	} as any);

	const dir = makeProject({
		"src/search/index.ts": "export function semanticSearch(query: string) { return vectorIndex.search(query); }\n",
	});
	try {
		buildSearchIndex(dir, { writeToDisk: true });
		const statusDir = join(dir, ".pi", "semantic-search");
		const logPath = join(statusDir, "rebuild.log");
		writeFileSync(logPath, "[2026-05-17T13:09:45.499Z] semantic-search background rebuild failed: Ollama unavailable\n", "utf8");
		writeFileSync(join(statusDir, "rebuild-status.json"), JSON.stringify({
			status: "failed",
			cwd: dir,
			logPath,
			pid: process.pid,
			startedAt: "2026-05-17T13:09:44.855Z",
			finishedAt: "2026-05-17T13:09:45.499Z",
			error: "Ollama unavailable",
		}), "utf8");

		events.get("session_start")?.({}, { cwd: dir });
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(messages.length, 1);
		assert.match(messages[0]?.content ?? "", /Semantic index background rebuild failed/);
		assert.match(messages[0]?.content ?? "", /Ollama unavailable/);
		const status = JSON.parse(readFileSync(join(statusDir, "rebuild-status.json"), "utf8"));
		assert.equal(status.notified, true);
	} finally {
		events.get("session_shutdown")?.();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("session start publishes composer status while background rebuild is running", async () => {
	const events = new Map<string, any>();
	semanticSearchExtension({
		on(name: string, handler: any) {
			events.set(name, handler);
		},
		registerTool() {},
		registerCommand() {},
	} as any);

	const dir = makeProject({
		"src/search/index.ts": "export function semanticSearch(query: string) { return vectorIndex.search(query); }\n",
	});
	const statuses: Array<{ key: string; value: string | undefined }> = [];
	try {
		const statusDir = join(dir, ".pi", "semantic-search");
		mkdirSync(statusDir, { recursive: true });
		const logPath = join(statusDir, "rebuild.log");
		writeFileSync(logPath, "", "utf8");
		writeFileSync(join(statusDir, "rebuild-status.json"), JSON.stringify({
			status: "running",
			cwd: dir,
			logPath,
			pid: process.pid,
			startedAt: "2026-05-17T13:09:44.855Z",
			progress: {
				phase: "summarizing",
				message: "Summarized 25/100 semantic cards with qwen2.5-coder:14b",
				current: 25,
				total: 100,
				percent: 25,
				phaseStartedAt: "2026-05-17T13:09:44.855Z",
				updatedAt: "2026-05-17T13:10:44.855Z",
				elapsedMs: 60_000,
				estimatedRemainingMs: 180_000,
			},
		}), "utf8");

		events.get("session_start")?.({}, {
			cwd: dir,
			ui: {
				setStatus(key: string, value: string | undefined) {
					statuses.push({ key, value });
				},
			},
		});
		assert.deepEqual(statuses[0], { key: "semantic-search", value: "idx: summarizing 25% · ~3m 0s" });
	} finally {
		events.get("session_shutdown")?.();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("agent_end automatically starts a background index rebuild after successful file edits", async () => {
	const events = new Map<string, any>();
	const starts: Array<{ cwd: string }> = [];
	const statuses: Array<{ key: string; value: string | undefined }> = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	semanticSearchExtension({
		on(name: string, handler: any) {
			events.set(name, handler);
		},
		registerTool() {},
		registerCommand() {},
	} as any, {
		startBackgroundIndexBuild(cwd: string) {
			starts.push({ cwd });
			const statusDir = join(cwd, ".pi", "semantic-search");
			mkdirSync(statusDir, { recursive: true });
			const logPath = join(statusDir, "rebuild.log");
			const statusPath = join(statusDir, "rebuild-status.json");
			writeFileSync(logPath, "", "utf8");
			writeFileSync(statusPath, JSON.stringify({
				status: "running",
				cwd,
				logPath,
				pid: process.pid,
				startedAt: "2026-05-17T13:09:44.855Z",
				progress: {
					phase: "starting",
					message: "background rebuild process started",
					phaseStartedAt: "2026-05-17T13:09:44.855Z",
					updatedAt: "2026-05-17T13:09:44.855Z",
					elapsedMs: 0,
				},
			}), "utf8");
			return { pid: process.pid, logPath, statusPath };
		},
	});

	const dir = makeProject({
		"src/search/index.ts": "export function semanticSearch(query: string) { return vectorIndex.search(query); }\n",
	});
	try {
		buildSearchIndex(dir, { writeToDisk: true });
		writeFileSync(join(dir, "src", "search", "index.ts"), "export function semanticSearch(query: string) { return vectorIndex.search(query) + query.length; }\n", "utf8");

		await events.get("tool_result")?.({ toolName: "write", input: { path: "src/search/index.ts" }, isError: false }, { cwd: dir });
		await events.get("agent_end")?.({}, {
			cwd: dir,
			ui: {
				setStatus(key: string, value: string | undefined) {
					statuses.push({ key, value });
				},
				notify(message: string, level?: string) {
					notifications.push({ message, level });
				},
			},
		});
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(starts.length, 1);
		assert.equal(starts[0]?.cwd, dir);
		assert.ok(statuses.some((status) => status.key === "semantic-search" && status.value === "idx: starting"));
		assert.match(notifications[0]?.message ?? "", /Semantic index stale after 1 changed file; rebuilding in background/);
		assert.equal(notifications[0]?.level, "info");
	} finally {
		events.get("session_shutdown")?.();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("agent_end does not auto-rebuild stale indexes without a successful file-changing tool result", async () => {
	const events = new Map<string, any>();
	let starts = 0;
	semanticSearchExtension({
		on(name: string, handler: any) {
			events.set(name, handler);
		},
		registerTool() {},
		registerCommand() {},
	} as any, {
		startBackgroundIndexBuild(cwd: string) {
			starts++;
			const statusDir = join(cwd, ".pi", "semantic-search");
			mkdirSync(statusDir, { recursive: true });
			const logPath = join(statusDir, "rebuild.log");
			const statusPath = join(statusDir, "rebuild-status.json");
			return { pid: process.pid, logPath, statusPath };
		},
	});

	const dir = makeProject({
		"src/search/index.ts": "export function semanticSearch(query: string) { return vectorIndex.search(query); }\n",
	});
	try {
		buildSearchIndex(dir, { writeToDisk: true });
		writeFileSync(join(dir, "src", "search", "index.ts"), "export function semanticSearch(query: string) { return vectorIndex.search(query) + query.length; }\n", "utf8");

		await events.get("agent_end")?.({}, { cwd: dir, ui: { setStatus() {}, notify() {} } });
		await events.get("tool_result")?.({ toolName: "write", input: { path: "src/search/index.ts" }, isError: true }, { cwd: dir });
		await events.get("agent_end")?.({}, { cwd: dir, ui: { setStatus() {}, notify() {} } });

		assert.equal(starts, 0);
	} finally {
		events.get("session_shutdown")?.();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("embedding search honors an already-aborted signal", async () => {
	const dir = makeProject({ "src/index.ts": "export const value = 1;\n" });
	try {
		const index = buildSearchIndex(dir, { writeToDisk: false });
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			searchIndexWithEmbeddings(index, { query: "value", signal: controller.signal }),
			(error: any) => error?.name === "AbortError",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("manual background rebuild reuses an already-running build", async () => {
	const dir = makeProject({ "src/index.ts": "export const value = 1;\n" });
	const commands = new Map<string, any>();
	const events = new Map<string, any>();
	const messages: any[] = [];
	let starts = 0;
	semanticSearchExtension({
		on(name: string, handler: any) {
			events.set(name, handler);
		},
		registerTool() {},
		registerCommand(name: string, definition: any) {
			commands.set(name, definition);
		},
		sendMessage(message: any) {
			messages.push(message);
		},
		events: { emit() {} },
	} as any, {
		startBackgroundIndexBuild(cwd: string) {
			starts += 1;
			return {
				pid: 999,
				logPath: join(cwd, ".pi", "semantic-search", "rebuild.log"),
				statusPath: join(cwd, ".pi", "semantic-search", "rebuild-status.json"),
			};
		},
	});
	try {
		const statusDir = join(dir, ".pi", "semantic-search");
		mkdirSync(statusDir, { recursive: true });
		const logPath = join(statusDir, "rebuild.log");
		writeFileSync(logPath, "running\n", "utf8");
		writeFileSync(join(statusDir, "rebuild-status.json"), JSON.stringify({
			status: "running",
			cwd: dir,
			logPath,
			pid: process.pid,
			startedAt: new Date().toISOString(),
		}), "utf8");

		await commands.get("index").handler("rebuild", {
			cwd: dir,
			ui: { notify() {}, setStatus() {} },
		} as any);

		assert.equal(starts, 0);
		assert.match(messages.at(-1)?.content ?? "", /already running/i);
	} finally {
		events.get("session_shutdown")?.();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("index rebuild status reports the last background rebuild state", async () => {
	const commands = new Map<string, any>();
	const messages: any[] = [];
	semanticSearchExtension({
		registerTool() {},
		registerCommand(name: string, definition: any) {
			commands.set(name, definition);
		},
		sendMessage(message: any) {
			messages.push(message);
		},
	} as any);

	const dir = makeProject({
		"src/search/index.ts": "export function semanticSearch(query: string) { return vectorIndex.search(query); }\n",
	});
	try {
		const statusDir = join(dir, ".pi", "semantic-search");
		mkdirSync(statusDir, { recursive: true });
		const logPath = join(statusDir, "rebuild.log");
		writeFileSync(logPath, "[2026-05-17T13:09:44.855Z] semantic-search background rebuild started for test (pid 123)\n[2026-05-17T13:09:45.499Z] Summarizing semantic cards\n", "utf8");
		writeFileSync(join(statusDir, "rebuild-status.json"), JSON.stringify({
			status: "running",
			cwd: dir,
			logPath,
			pid: process.pid,
			startedAt: "2026-05-17T13:09:44.855Z",
			embeddingModel: "nomic-embed-text",
			summaryModel: "qwen2.5-coder:14b",
			progress: {
				phase: "summarizing",
				message: "Summarized 25/100 semantic cards with qwen2.5-coder:14b",
				current: 25,
				total: 100,
				percent: 25,
				phaseStartedAt: "2026-05-17T13:09:44.855Z",
				updatedAt: "2026-05-17T13:10:44.855Z",
				elapsedMs: 60_000,
				estimatedRemainingMs: 180_000,
			},
		}), "utf8");

		await commands.get("index").handler("rebuild --status", {
			cwd: dir,
			ui: { notify() {}, setStatus() {} },
		} as any);

		const text = messages[messages.length - 1]?.content ?? "";
		assert.match(text, /Semantic index background rebuild status/);
		assert.match(text, /State: running \(process active\)/);
		assert.match(text, /Summary model: qwen2\.5-coder:14b/);
		assert.match(text, /Progress: summarizing 25\/100 \(25%\)/);
		assert.match(text, /ETA: ~3m 0s remaining \(best effort\)/);
		assert.match(text, /Current index: stale/);
		assert.match(text, /Recent log:/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("ollama tunnel args build a localhost SSH tunnel command", () => {
	const parsed = parseOllamaTunnelCommandArgs("user@ryzen-box --local-port 11435 --remote-port 11434", {});

	assert.equal(parsed.error, undefined);
	assert.equal(parsed.action, "start");
	assert.equal(parsed.sshTarget, "user@ryzen-box");
	assert.equal(parsed.localHost, "127.0.0.1");
	assert.equal(parsed.localPort, 11435);
	assert.equal(parsed.localPortExplicit, true);
	assert.equal(parsed.remoteHost, "127.0.0.1");
	assert.equal(parsed.remotePort, 11434);
	assert.equal(
		formatOllamaTunnelSshCommand(parsed),
		"ssh -f -N -L 127.0.0.1:11435:127.0.0.1:11434 -o ExitOnForwardFailure=yes -o BatchMode=yes user@ryzen-box",
	);

	const fromEnv = parseOllamaTunnelCommandArgs("--print", { PI_OLLAMA_SSH_HOST: "workstation" });
	assert.equal(fromEnv.sshTarget, "workstation");
	assert.equal(fromEnv.printOnly, true);
	assert.equal(parseOllamaTunnelCommandArgs("", {}).sshTarget, "charleshippo@otto");
	assert.equal(parseOllamaTunnelCommandArgs("", {}).localPortExplicit, false);
	assert.equal(parseOllamaTunnelCommandArgs("", {}, { tunnel: { sshTarget: "agent@box", localPort: 11436 } }).sshTarget, "agent@box");
	assert.equal(parseOllamaTunnelCommandArgs("", {}, { tunnel: { sshTarget: "agent@box", localPort: 11436 } }).localPort, 11436);
	assert.equal(parseOllamaTunnelCommandArgs("local", {}).action, "local");
	assert.equal(parseOllamaTunnelCommandArgs("stop", {}).action, "stop");
	assert.equal(parseOllamaTunnelCommandArgs("user@host", { PI_OLLAMA_SSH_HOST: "workstation" }).sshTarget, "user@host");
	assert.match(parseOllamaTunnelCommandArgs("user@host --local-port nope", {}).error ?? "", /Local port/);
});

test("ollama-tunnel command starts SSH tunnel and points this Pi session at it", async () => {
	const commands = new Map<string, any>();
	const messages: any[] = [];
	const notifications: any[] = [];
	const previousBaseUrl = process.env.OLLAMA_BASE_URL;
	const starts: any[] = [];
	semanticSearchExtension({
		registerTool() {},
		registerCommand(name: string, definition: any) {
			commands.set(name, definition);
		},
		sendMessage(message: any) {
			messages.push(message);
		},
	} as any, {
		startOllamaTunnel(config) {
			starts.push(config);
			return { ok: true, command: formatOllamaTunnelSshCommand(config), ollamaUrl: `http://${config.localHost}:${config.localPort}` };
		},
	});

	const dir = makeProject({});
	try {
		await commands.get("ollama-tunnel").handler("--local-port 11435", {
			cwd: dir,
			ui: {
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
			},
		} as any);

		assert.equal(starts.length, 1);
		assert.equal(starts[0].sshTarget, "charleshippo@otto");
		assert.equal(process.env.OLLAMA_BASE_URL, "http://127.0.0.1:11435");
		assert.match(notifications[0]?.message ?? "", /Ollama SSH tunnel ready/);
		assert.equal(notifications[0]?.level, "info");
		assert.match(messages[0]?.content ?? "", /\/index rebuild/);
	} finally {
		if (previousBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
		else process.env.OLLAMA_BASE_URL = previousBaseUrl;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("ollama-tunnel command auto-falls back when default local port is busy", async () => {
	const commands = new Map<string, any>();
	const messages: any[] = [];
	const previousBaseUrl = process.env.OLLAMA_BASE_URL;
	const starts: any[] = [];
	semanticSearchExtension({
		registerTool() {},
		registerCommand(name: string, definition: any) {
			commands.set(name, definition);
		},
		sendMessage(message: any) {
			messages.push(message);
		},
	} as any, {
		startOllamaTunnel(config) {
			starts.push(config);
			if (config.localPort === 11435) return { ok: false, command: formatOllamaTunnelSshCommand(config), ollamaUrl: `http://${config.localHost}:${config.localPort}`, error: "bind [127.0.0.1]:11435: Address already in use" };
			return { ok: true, command: formatOllamaTunnelSshCommand(config), ollamaUrl: `http://${config.localHost}:${config.localPort}` };
		},
	});

	const dir = makeProject({});
	try {
		await commands.get("ollama-tunnel").handler("", {
			cwd: dir,
			ui: { notify() {} },
		} as any);

		assert.deepEqual(starts.map((start) => start.localPort), [11435, 11436]);
		assert.equal(process.env.OLLAMA_BASE_URL, "http://127.0.0.1:11436");
		assert.match(messages[0]?.content ?? "", /port 11435 was busy; used 11436/);
		assert.deepEqual(messages[0]?.details.attemptedPorts, [11435, 11436]);
	} finally {
		if (previousBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
		else process.env.OLLAMA_BASE_URL = previousBaseUrl;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("ollama-tunnel local and stop reset Pi back to local Ollama", async () => {
	const commands = new Map<string, any>();
	const messages: any[] = [];
	const notifications: any[] = [];
	const previousBaseUrl = process.env.OLLAMA_BASE_URL;
	const stops: any[] = [];
	process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11435";
	semanticSearchExtension({
		registerTool() {},
		registerCommand(name: string, definition: any) {
			commands.set(name, definition);
		},
		sendMessage(message: any) {
			messages.push(message);
		},
	} as any, {
		stopOllamaTunnel(config) {
			stops.push(config);
			return { killedPids: [12345], attemptedPorts: [11434, 11435] };
		},
	});

	const dir = makeProject({});
	try {
		await commands.get("ollama-tunnel").handler("local", {
			cwd: dir,
			ui: { notify(message: string, level: string) { notifications.push({ message, level }); } },
		} as any);
		assert.equal(process.env.OLLAMA_BASE_URL, "http://127.0.0.1:11434");
		assert.match(messages[messages.length - 1]?.content ?? "", /uses local Ollama/);

		process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11435";
		await commands.get("ollama-tunnel").handler("stop", {
			cwd: dir,
			ui: { notify(message: string, level: string) { notifications.push({ message, level }); } },
		} as any);
		assert.equal(stops.length, 1);
		assert.equal(process.env.OLLAMA_BASE_URL, "http://127.0.0.1:11434");
		assert.match(messages[messages.length - 1]?.content ?? "", /Stopped Ollama SSH tunnel process: 12345/);
		assert.deepEqual(messages[messages.length - 1]?.details.killedPids, [12345]);
	} finally {
		if (previousBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
		else process.env.OLLAMA_BASE_URL = previousBaseUrl;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("extension registers semantic search tools and command entrypoints", async () => {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	semanticSearchExtension({
		registerTool(definition: any) {
			tools.set(definition.name, definition);
		},
		registerCommand(name: string, definition: any) {
			commands.set(name, definition);
		},
	} as any);

	assert.ok(tools.has("semantic_search"));
	assert.ok(tools.has("repo_map"));
	assert.ok(tools.has("index_status"));
	assert.ok(tools.has("index_rebuild_status"));
	assert.ok(commands.has("index"));
	assert.ok(commands.has("code-search"));
	assert.ok(commands.has("ollama-tunnel"));

	const dir = makeProject({
		"src/search/index.ts": "export function semanticSearch(query: string) { return vectorIndex.search(query); }\n",
	});
	try {
		await withMockOllamaFetch(async () => {
			const result = await tools.get("semantic_search").execute(
				"tool-call-1",
				{ query: "vector search", topK: 1, refresh: true },
				undefined,
				undefined,
				{ cwd: dir } as any,
			);

			assert.match(result.content[0].text, /src\/search\/index\.ts/);
			assert.equal(result.details.query, "vector search");
			assert.equal(result.details.embeddingUsed, true);
			assert.equal(result.details.index.embedding.model, "mxbai-embed-large");
			assert.equal(result.details.index.summary.model, "qwen2.5-coder:14b");
			assert.equal(result.details.results.length, 1);
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("semantic_search reports required Ollama setup instead of falling back to lexical search", async () => {
	const tools = new Map<string, any>();
	semanticSearchExtension({
		registerTool(definition: any) {
			tools.set(definition.name, definition);
		},
		registerCommand() {},
	} as any);

	const dir = makeProject({
		"src/search/index.ts": "export function semanticSearch(query: string) { return vectorIndex.search(query); }\n",
	});
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response(JSON.stringify({ error: "model not found" }), {
		status: 404,
		statusText: "Not Found",
		headers: { "content-type": "application/json" },
	})) as typeof fetch;
	try {
		await assert.rejects(
			tools.get("semantic_search").execute(
				"tool-call-1",
				{ query: "vector search", topK: 1, refresh: true },
				undefined,
				undefined,
				{ cwd: dir } as any,
			),
			(error: Error) => {
				assert.match(error.message, /requires local Ollama summaries and embeddings/i);
				assert.match(error.message, /ollama pull mxbai-embed-large/);
				assert.match(error.message, /ollama pull qwen2\.5-coder:14b/);
				assert.doesNotMatch(error.message, /src\/search\/index\.ts/);
				return true;
			},
		);
	} finally {
		globalThis.fetch = originalFetch;
		rmSync(dir, { recursive: true, force: true });
	}
});
