import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import semanticSearchExtension, {
	buildSearchIndex,
	buildSearchIndexWithEmbeddings,
	createRepoMap,
	formatRepoMap,
	formatSearchResults,
	parseSearchIndexJson,
	resolveOllamaEmbeddingConfig,
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

function fakeEmbeddingFor(text: string): number[] {
	if (/money collection|invoice|ledger|reconcile/i.test(text)) return [1, 0, 0];
	if (/canvas|palette|paint/i.test(text)) return [0, 1, 0];
	return [0, 0, 1];
}

async function withMockOllamaFetch<T>(fn: () => Promise<T>): Promise<T> {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string | string[]; prompt?: string };
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

test("Ollama config defaults to the local embedding model and accepts OLLAMA_HOST", () => {
	assert.deepEqual(resolveOllamaEmbeddingConfig({}, {}), {
		model: "nomic-embed-text",
		baseUrl: "http://127.0.0.1:11434",
		batchSize: 16,
		timeoutMs: 30_000,
		maxInputChars: 6_000,
	});
	assert.equal(resolveOllamaEmbeddingConfig({}, { OLLAMA_HOST: "localhost:11434", OLLAMA_EMBED_MODEL: "mxbai-embed-large" }).baseUrl, "http://localhost:11434");
	assert.equal(resolveOllamaEmbeddingConfig({}, { OLLAMA_HOST: "localhost:11434", OLLAMA_EMBED_MODEL: "mxbai-embed-large" }).model, "mxbai-embed-large");
	assert.equal(resolveOllamaEmbeddingConfig({}, { PI_SEMANTIC_SEARCH_EMBED_MAX_CHARS: "256" }).maxInputChars, 256);
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
	globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string; input?: string | string[] };
		seenModels.push(body.model ?? "");
		const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
		return new Response(JSON.stringify({ embeddings: inputs.map(fakeEmbeddingFor) }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	delete process.env.PI_SEMANTIC_SEARCH_EMBED_MODEL;
	delete process.env.OLLAMA_EMBED_MODEL;

	try {
		await commands.get("index").handler("build", {
			cwd: dir,
			ui: { notify() {}, setStatus() {} },
		} as any);

		assert.ok(seenModels.length > 0, "expected the command to request embeddings");
		assert.ok(!seenModels.includes("build"), "build should be parsed as a command alias, not a model");
		assert.ok(seenModels.every((model) => model === "nomic-embed-text"));
	} finally {
		globalThis.fetch = originalFetch;
		if (previousPiModel === undefined) delete process.env.PI_SEMANTIC_SEARCH_EMBED_MODEL;
		else process.env.PI_SEMANTIC_SEARCH_EMBED_MODEL = previousPiModel;
		if (previousOllamaModel === undefined) delete process.env.OLLAMA_EMBED_MODEL;
		else process.env.OLLAMA_EMBED_MODEL = previousOllamaModel;
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
	assert.ok(commands.has("index"));
	assert.ok(commands.has("code-search"));

	const dir = makeProject({
		"src/search/index.ts": "export function semanticSearch(query: string) { return vectorIndex.search(query); }\n",
	});
	try {
		const result = await tools.get("semantic_search").execute(
			"tool-call-1",
			{ query: "vector search", topK: 1, refresh: true, useEmbeddings: false },
			undefined,
			undefined,
			{ cwd: dir } as any,
		);

		assert.match(result.content[0].text, /src\/search\/index\.ts/);
		assert.equal(result.details.query, "vector search");
		assert.equal(result.details.results.length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
