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
	resolveOllamaEmbeddingConfig,
	searchIndex,
	searchIndexWithEmbeddings,
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
			assert.equal(index.embedding?.dimensions, 3);
			assert.ok(index.chunks.every((chunk) => Array.isArray(chunk.embedding)));

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
	});
	assert.equal(resolveOllamaEmbeddingConfig({}, { OLLAMA_HOST: "localhost:11434", OLLAMA_EMBED_MODEL: "mxbai-embed-large" }).baseUrl, "http://localhost:11434");
	assert.equal(resolveOllamaEmbeddingConfig({}, { OLLAMA_HOST: "localhost:11434", OLLAMA_EMBED_MODEL: "mxbai-embed-large" }).model, "mxbai-embed-large");
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
