import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import {
	basename,
	dirname,
	extname,
	join,
	resolve,
	sep,
} from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const INDEX_VERSION = 3;
const INDEX_DIR = ".pi/semantic-search";
const INDEX_FILE = "index.json";
const DEFAULT_CHUNK_LINES = 80;
const DEFAULT_CHUNK_OVERLAP = 12;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_TOP_K = 8;
const MAX_TOP_K = 25;
const MAX_PREVIEW_LINES = 6;
const MAX_PREVIEW_LINE_CHARS = 180;
const MAX_SEMANTIC_CARDS_PER_FILE = 80;
const MAX_CARD_BODY_LINES = 80;
const MAX_CARD_TEXT_CHARS = 6_000;
const MAX_CARD_CALLS = 18;
const MAX_CARD_COMMENTS = 6;
const MAX_CARD_TERMS = 28;
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_EMBED_MODEL = "nomic-embed-text";
const DEFAULT_OLLAMA_BATCH_SIZE = 16;
const DEFAULT_OLLAMA_TIMEOUT_MS = 30_000;
const DEFAULT_OLLAMA_EMBED_INPUT_MAX_CHARS = 6_000;
const MIN_OLLAMA_EMBED_INPUT_CHARS = 128;
const MAX_OLLAMA_EMBED_INPUT_MAX_CHARS = 100_000;
const EMBEDDING_TRUNCATION_MARKER = "\n\n[...semantic-search input truncated...]\n\n";
const EMBEDDING_VECTOR_JSON_ENCODING = "base64-f32";

const SKIP_DIRS = new Set([
	".git",
	".hg",
	".svn",
	".pi",
	".features",
	"node_modules",
	"bower_components",
	"dist",
	"build",
	"coverage",
	".next",
	".nuxt",
	".svelte-kit",
	".turbo",
	".cache",
	"target",
	"vendor",
	"out",
]);

const SKIP_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".ico",
	".pdf",
	".zip",
	".gz",
	".tgz",
	".xz",
	".7z",
	".rar",
	".woff",
	".woff2",
	".ttf",
	".eot",
	".mp3",
	".mp4",
	".mov",
	".avi",
	".sqlite",
	".db",
	".lock",
]);

const STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"but",
	"by",
	"can",
	"could",
	"do",
	"does",
	"for",
	"from",
	"how",
	"i",
	"if",
	"in",
	"into",
	"is",
	"it",
	"its",
	"me",
	"my",
	"of",
	"on",
	"or",
	"our",
	"that",
	"the",
	"their",
	"there",
	"this",
	"to",
	"use",
	"used",
	"using",
	"we",
	"what",
	"when",
	"where",
	"which",
	"who",
	"why",
	"with",
	"you",
	"your",
]);

const CONCEPT_GROUPS: Record<string, string[]> = {
	billing: [
		"bill",
		"billing",
		"charge",
		"checkout",
		"customer",
		"invoice",
		"pay",
		"payment",
		"price",
		"pricing",
		"purchase",
		"refund",
		"stripe",
		"subscription",
	],
	auth: [
		"account",
		"auth",
		"authenticate",
		"authorization",
		"cookie",
		"jwt",
		"login",
		"oauth",
		"password",
		"permission",
		"role",
		"session",
		"signin",
		"token",
		"user",
	],
	files: [
		"directory",
		"edit",
		"file",
		"filesystem",
		"folder",
		"fs",
		"open",
		"opener",
		"path",
		"read",
		"write",
	],
	search: [
		"bm25",
		"cluster",
		"embedding",
		"find",
		"grep",
		"index",
		"lexical",
		"query",
		"rank",
		"retrieval",
		"search",
		"semantic",
		"similarity",
		"vector",
	],
	tests: [
		"assert",
		"expect",
		"fixture",
		"harness",
		"mock",
		"spec",
		"test",
		"tests",
		"verify",
	],
	ui: [
		"component",
		"footer",
		"modal",
		"overlay",
		"render",
		"renderer",
		"status",
		"theme",
		"tui",
		"widget",
	],
	git: [
		"blame",
		"branch",
		"checkout",
		"commit",
		"diff",
		"git",
		"lazygit",
		"merge",
		"rebase",
		"stash",
		"worktree",
	],
	agent: [
		"agent",
		"compact",
		"context",
		"handoff",
		"llm",
		"message",
		"model",
		"prompt",
		"session",
		"tool",
	],
	web: [
		"api",
		"fetch",
		"headers",
		"http",
		"request",
		"response",
		"rest",
		"url",
		"web",
	],
	config: [
		"config",
		"dependency",
		"env",
		"package",
		"setting",
		"settings",
	],
	errors: [
		"error",
		"exception",
		"invalid",
		"schema",
		"throw",
		"validate",
		"validation",
	],
	commands: [
		"command",
		"input",
		"keybinding",
		"shortcut",
		"slash",
	],
	docs: [
		"design",
		"doc",
		"docs",
		"guide",
		"markdown",
		"playbook",
		"prd",
		"readme",
	],
};

const TOKEN_TO_CONCEPTS = new Map<string, string[]>();
for (const [concept, words] of Object.entries(CONCEPT_GROUPS)) {
	for (const word of words) {
		const normalized = normalizeTokenBase(word);
		if (!normalized) continue;
		const concepts = TOKEN_TO_CONCEPTS.get(normalized) ?? [];
		concepts.push(concept);
		TOKEN_TO_CONCEPTS.set(normalized, concepts);
	}
}

export type VectorEntry = [term: string, weight: number];

export type OllamaEmbeddingConfig = {
	model: string;
	baseUrl: string;
	batchSize: number;
	timeoutMs: number;
	maxInputChars: number;
};

export type EmbeddingMetadata = {
	provider: "ollama";
	model: string;
	baseUrl: string;
	inputMaxChars: number;
	dimensions: number;
	embeddedChunks: number;
	embeddedCards: number;
	createdAt: string;
};

export type IndexedFile = {
	path: string;
	hash: string;
	size: number;
	mtimeMs: number;
	language: string;
	chunks: number;
	symbols: string[];
};

export type IndexedChunk = {
	id: string;
	path: string;
	startLine: number;
	endLine: number;
	text: string;
	symbols: string[];
	vector: VectorEntry[];
	embedding?: number[];
};

export type SemanticCardKind = "file" | "class" | "module" | "function" | "method" | "heading" | "definition";

export type IndexedCard = {
	id: string;
	path: string;
	startLine: number;
	endLine: number;
	kind: SemanticCardKind;
	name: string;
	summary: string;
	text: string;
	symbols: string[];
	vector: VectorEntry[];
	embedding?: number[];
};

export type SearchIndex = {
	version: number;
	cwd: string;
	createdAt: string;
	updatedAt: string;
	options: {
		chunkLines: number;
		chunkOverlap: number;
		maxFileBytes: number;
	};
	files: IndexedFile[];
	chunks: IndexedChunk[];
	cards: IndexedCard[];
	embedding?: EmbeddingMetadata;
};

type SerializedEmbeddingVector = {
	encoding: typeof EMBEDDING_VECTOR_JSON_ENCODING;
	data: string;
};

export type SearchResult = {
	path: string;
	startLine: number;
	endLine: number;
	source: "chunk" | "card";
	cardKind?: SemanticCardKind;
	cardName?: string;
	cardSummary?: string;
	score: number;
	vectorScore: number;
	lexicalScore: number;
	pathScore: number;
	symbolScore: number;
	embeddingScore?: number;
	symbols: string[];
	reason: string[];
	preview: string;
};

export type RepoCluster = {
	name: string;
	score: number;
	files: Array<{ path: string; score: number; symbols: string[] }>;
	terms: string[];
};

export type RepoMap = {
	clusters: RepoCluster[];
	topDirectories: Array<{ path: string; files: number }>;
};

type BuildOptions = {
	chunkLines?: number;
	chunkOverlap?: number;
	maxFileBytes?: number;
	writeToDisk?: boolean;
};

type EmbeddingBuildOptions = BuildOptions & {
	ollama?: Partial<OllamaEmbeddingConfig>;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
};

type SearchOptions = {
	query: string;
	topK?: number;
	paths?: string[];
	includeTests?: boolean;
	minScore?: number;
	queryEmbedding?: number[];
};

type IndexStatus = {
	indexPath: string;
	exists: boolean;
	stale: boolean;
	reason: string;
	files: number;
	chunks: number;
	cards: number;
	updatedAt?: string;
	embedding?: EmbeddingMetadata;
};

const memoryIndexes = new Map<string, SearchIndex>();

function normalizeRelativePath(path: string): string {
	return path.split(sep).join("/").replace(/^\.\//, "");
}

function getIndexPath(cwd: string): string {
	return join(cwd, INDEX_DIR, INDEX_FILE);
}

function languageForPath(path: string): string {
	const ext = extname(path).toLowerCase();
	if ([".ts", ".tsx"].includes(ext)) return "typescript";
	if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "javascript";
	if ([".md", ".mdx"].includes(ext)) return "markdown";
	if ([".json", ".jsonc"].includes(ext)) return "json";
	if ([".yml", ".yaml"].includes(ext)) return "yaml";
	if ([".sh", ".bash", ".zsh"].includes(ext)) return "shell";
	if ([".rb", ".rake"].includes(ext)) return "ruby";
	if ([".erb"].includes(ext)) return "erb";
	if ([".py"].includes(ext)) return "python";
	if ([".rs"].includes(ext)) return "rust";
	if ([".go"].includes(ext)) return "go";
	if ([".java", ".kt", ".kts"].includes(ext)) return "jvm";
	if ([".css", ".scss", ".sass", ".less"].includes(ext)) return "css";
	if ([".html", ".xml", ".svg"].includes(ext)) return "markup";
	return ext.replace(/^\./, "") || "text";
}

function hashBuffer(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

function isLikelyBinary(buffer: Buffer): boolean {
	if (buffer.includes(0)) return true;
	const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
	let suspicious = 0;
	for (const byte of sample) {
		if (byte < 7 || (byte > 14 && byte < 32)) suspicious++;
	}
	return sample.length > 0 && suspicious / sample.length > 0.08;
}

function shouldSkipPath(relativePath: string): boolean {
	const normalized = normalizeRelativePath(relativePath);
	const parts = normalized.split("/");
	if (parts.some((part) => SKIP_DIRS.has(part))) return true;
	if (basename(normalized).startsWith(".DS_Store")) return true;
	if (SKIP_EXTENSIONS.has(extname(normalized).toLowerCase())) return true;
	return false;
}

function discoverProjectFiles(cwd: string): string[] {
	const files = new Set<string>();
	try {
		const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		for (const raw of output.split("\0")) {
			const file = normalizeRelativePath(raw.trim());
			if (file && !shouldSkipPath(file)) files.add(file);
		}
	} catch {
		// Not a git checkout or git unavailable. Fall back to a conservative recursive walk.
	}

	if (files.size === 0) {
		for (const file of walkFiles(cwd)) files.add(file);
	}

	return [...files].sort((a, b) => a.localeCompare(b));
}

function walkFiles(cwd: string, current = ""): string[] {
	const directory = current ? join(cwd, current) : cwd;
	const out: string[] = [];
	let entries: ReturnType<typeof readdirSync>;
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch {
		return out;
	}

	for (const entry of entries) {
		const relativePath = normalizeRelativePath(current ? join(current, entry.name) : entry.name);
		if (shouldSkipPath(relativePath)) continue;
		if (entry.isDirectory()) {
			out.push(...walkFiles(cwd, relativePath));
		} else if (entry.isFile()) {
			out.push(relativePath);
		}
	}
	return out;
}

function normalizeTokenBase(token: string): string | undefined {
	let normalized = token.toLowerCase().replace(/^#+/, "").replace(/['’]s$/, "");
	if (normalized.length > 5 && normalized.endsWith("ing")) normalized = normalized.slice(0, -3);
	else if (normalized.length > 4 && normalized.endsWith("ed")) normalized = normalized.slice(0, -2);
	else if (normalized.length > 4 && normalized.endsWith("ies")) normalized = `${normalized.slice(0, -3)}y`;
	else if (normalized.length > 3 && normalized.endsWith("s")) normalized = normalized.slice(0, -1);
	if (normalized.length < 2) return undefined;
	if (STOPWORDS.has(normalized)) return undefined;
	return normalized;
}

function splitSearchText(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.replace(/[_.:/\\-]+/g, " ")
		.replace(/[^\p{L}\p{N}#]+/gu, " ")
		.split(/\s+/)
		.filter(Boolean);
}

export function tokenizeSearchText(text: string): string[] {
	const tokens: string[] = [];
	for (const rawToken of splitSearchText(text)) {
		const token = normalizeTokenBase(rawToken);
		if (!token) continue;
		tokens.push(token);
		for (const concept of TOKEN_TO_CONCEPTS.get(token) ?? []) {
			tokens.push(`concept:${concept}`);
		}
	}
	return tokens;
}

function unique<T>(items: T[]): T[] {
	return [...new Set(items)];
}

function topTerms(entries: VectorEntry[], limit: number, predicate: (term: string) => boolean): string[] {
	return entries
		.filter(([term]) => predicate(term))
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([term]) => term);
}

function makeVector(parts: Array<{ text: string; weight: number }>): VectorEntry[] {
	const counts = new Map<string, number>();
	for (const part of parts) {
		for (const token of tokenizeSearchText(part.text)) {
			counts.set(token, (counts.get(token) ?? 0) + part.weight);
		}
	}

	let norm = 0;
	const weighted: VectorEntry[] = [];
	for (const [term, count] of counts) {
		const value = 1 + Math.log(count);
		weighted.push([term, value]);
		norm += value * value;
	}

	if (norm === 0) return [];
	const divisor = Math.sqrt(norm);
	return weighted
		.map(([term, value]) => [term, value / divisor] as VectorEntry)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function makeQueryVector(query: string): Map<string, number> {
	const vector = makeVector([{ text: query, weight: 1 }]);
	return new Map(vector);
}

function cosine(queryVector: Map<string, number>, chunkVector: VectorEntry[]): number {
	let score = 0;
	for (const [term, weight] of chunkVector) {
		const queryWeight = queryVector.get(term);
		if (queryWeight) score += queryWeight * weight;
	}
	return score;
}

function normalizeEmbedding(values: unknown): number[] {
	if (!Array.isArray(values) || values.length === 0) throw new Error("Ollama returned an empty embedding.");
	const vector = values.map((value) => {
		const number = typeof value === "number" ? value : Number(value);
		if (!Number.isFinite(number)) throw new Error("Ollama returned a non-numeric embedding value.");
		return number;
	});
	const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
	if (norm === 0) throw new Error("Ollama returned a zero-length embedding vector.");
	return vector.map((value) => value / norm);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function encodeEmbeddingVectorForJson(embedding: number[]): SerializedEmbeddingVector {
	const buffer = Buffer.allocUnsafe(embedding.length * Float32Array.BYTES_PER_ELEMENT);
	for (let index = 0; index < embedding.length; index++) {
		const value = embedding[index] ?? 0;
		buffer.writeFloatLE(Number.isFinite(value) ? value : 0, index * Float32Array.BYTES_PER_ELEMENT);
	}
	return { encoding: EMBEDDING_VECTOR_JSON_ENCODING, data: buffer.toString("base64") };
}

function decodeEmbeddingVectorFromJson(value: unknown): number[] | undefined {
	if (Array.isArray(value)) {
		const embedding = value.map((entry) => (typeof entry === "number" ? entry : Number(entry)));
		return embedding.every(Number.isFinite) ? embedding : undefined;
	}
	if (!isObjectRecord(value) || value.encoding !== EMBEDDING_VECTOR_JSON_ENCODING || typeof value.data !== "string") return undefined;

	const buffer = Buffer.from(value.data, "base64");
	if (buffer.length % Float32Array.BYTES_PER_ELEMENT !== 0) throw new Error("Serialized embedding vector has an invalid byte length.");
	const embedding = new Array<number>(buffer.length / Float32Array.BYTES_PER_ELEMENT);
	for (let index = 0; index < embedding.length; index++) {
		embedding[index] = buffer.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT);
	}
	return embedding;
}

function searchIndexJsonReplacer(key: string, value: unknown): unknown {
	if (key === "embedding" && Array.isArray(value)) return encodeEmbeddingVectorForJson(value);
	return value;
}

function searchIndexJsonReviver(key: string, value: unknown): unknown {
	if (key === "embedding") return decodeEmbeddingVectorFromJson(value) ?? value;
	return value;
}

export function serializeSearchIndexForJson(index: SearchIndex): string {
	return JSON.stringify(index, searchIndexJsonReplacer);
}

export function parseSearchIndexJson(json: string): SearchIndex {
	return JSON.parse(json, searchIndexJsonReviver) as SearchIndex;
}

function embeddingCosine(a: number[] | undefined, b: number[] | undefined): number {
	if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
	let score = 0;
	for (let i = 0; i < a.length; i++) score += a[i] * b[i];
	return score;
}

function normalizeOllamaBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	if (!trimmed) return DEFAULT_OLLAMA_BASE_URL;
	return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
	const parsed = typeof value === "number" ? value : (typeof value === "string" && value.trim() ? Number(value) : Number.NaN);
	const integer = Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
	return Math.min(Math.max(integer, min), max);
}

export function resolveOllamaEmbeddingConfig(
	input: Partial<OllamaEmbeddingConfig> = {},
	env: Record<string, string | undefined> = process.env,
): OllamaEmbeddingConfig {
	return {
		model: input.model ?? env.PI_SEMANTIC_SEARCH_EMBED_MODEL ?? env.OLLAMA_EMBED_MODEL ?? DEFAULT_OLLAMA_EMBED_MODEL,
		baseUrl: normalizeOllamaBaseUrl(input.baseUrl ?? env.OLLAMA_BASE_URL ?? env.OLLAMA_HOST ?? DEFAULT_OLLAMA_BASE_URL),
		batchSize: clampInteger(input.batchSize, DEFAULT_OLLAMA_BATCH_SIZE, 1, 64),
		timeoutMs: clampInteger(input.timeoutMs, DEFAULT_OLLAMA_TIMEOUT_MS, 1_000, 300_000),
		maxInputChars: clampInteger(input.maxInputChars ?? env.PI_SEMANTIC_SEARCH_EMBED_MAX_CHARS, DEFAULT_OLLAMA_EMBED_INPUT_MAX_CHARS, MIN_OLLAMA_EMBED_INPUT_CHARS, MAX_OLLAMA_EMBED_INPUT_MAX_CHARS),
	};
}

async function fetchJsonWithTimeout(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	const abort = () => controller.abort();
	signal?.addEventListener("abort", abort, { once: true });
	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(`Ollama ${url} failed with ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 300)}` : ""}`);
		}
		return await response.json();
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(`Timed out calling Ollama after ${timeoutMs}ms.`);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
	}
}

function isOllamaEmbedEndpointMissing(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /\/api\/embed failed with 404/i.test(message);
}

function isOllamaContextLengthError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /input length exceeds|exceeds (?:the )?(?:maximum )?context length|context length and cannot be truncated|after truncation exceeds maximum context length/i.test(message);
}

function truncateEmbeddingInput(text: string, maxChars: number): string {
	const clean = text.replace(/\u0000/g, "\uFFFD");
	if (clean.length <= maxChars) return clean;
	if (maxChars <= EMBEDDING_TRUNCATION_MARKER.length + 8) return clean.slice(0, maxChars);

	const available = maxChars - EMBEDDING_TRUNCATION_MARKER.length;
	const headChars = Math.max(1, Math.ceil(available * 0.75));
	const tailChars = Math.max(0, available - headChars);
	return `${clean.slice(0, headChars)}${EMBEDDING_TRUNCATION_MARKER}${clean.slice(clean.length - tailChars)}`;
}

async function fetchOllamaEmbeddings(texts: string[], config: OllamaEmbeddingConfig, signal?: AbortSignal): Promise<number[][]> {
	const payload = await fetchJsonWithTimeout(
		`${config.baseUrl}/api/embed`,
		{
			method: "POST",
			headers: { "content-type": "application/json", "user-agent": "pi-config-semantic-search/0.1" },
			body: JSON.stringify({ model: config.model, input: texts, truncate: true }),
		},
		config.timeoutMs,
		signal,
	);
	const embeddings = (payload as { embeddings?: unknown[] }).embeddings;
	if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
		throw new Error(`Ollama returned ${Array.isArray(embeddings) ? embeddings.length : 0} embeddings for ${texts.length} inputs.`);
	}
	return embeddings.map(normalizeEmbedding);
}

async function fetchLegacyOllamaEmbedding(text: string, config: OllamaEmbeddingConfig, signal?: AbortSignal): Promise<number[]> {
	const payload = await fetchJsonWithTimeout(
		`${config.baseUrl}/api/embeddings`,
		{
			method: "POST",
			headers: { "content-type": "application/json", "user-agent": "pi-config-semantic-search/0.1" },
			body: JSON.stringify({ model: config.model, prompt: text }),
		},
		config.timeoutMs,
		signal,
	);
	return normalizeEmbedding((payload as { embedding?: unknown }).embedding);
}

function shrinkEmbeddingLimit(current: number): number {
	return Math.max(MIN_OLLAMA_EMBED_INPUT_CHARS, Math.floor(current / 2));
}

function contextRetryExhaustedError(originalLength: number, finalLength: number, error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(`Ollama embedding input still exceeded context length after shrinking from ${originalLength} to ${finalLength} chars: ${message}`);
}

async function embedOneWithLegacyOllama(text: string, config: OllamaEmbeddingConfig, signal?: AbortSignal): Promise<number[]> {
	let limit = Math.min(text.length, config.maxInputChars);
	let lastError: unknown;
	while (true) {
		const candidate = truncateEmbeddingInput(text, limit);
		try {
			return await fetchLegacyOllamaEmbedding(candidate, config, signal);
		} catch (error) {
			if (!isOllamaContextLengthError(error)) throw error;
			lastError = error;
			if (limit <= MIN_OLLAMA_EMBED_INPUT_CHARS) throw contextRetryExhaustedError(text.length, candidate.length, lastError);
			limit = shrinkEmbeddingLimit(limit);
		}
	}
}

async function embedOneWithOllama(text: string, config: OllamaEmbeddingConfig, signal?: AbortSignal): Promise<number[]> {
	let limit = Math.min(text.length, config.maxInputChars);
	let lastError: unknown;
	while (true) {
		const candidate = truncateEmbeddingInput(text, limit);
		try {
			const [embedding] = await fetchOllamaEmbeddings([candidate], config, signal);
			if (!embedding) throw new Error("Ollama returned no embedding for one input.");
			return embedding;
		} catch (error) {
			if (isOllamaEmbedEndpointMissing(error)) return embedOneWithLegacyOllama(text, config, signal);
			if (!isOllamaContextLengthError(error)) throw error;
			lastError = error;
			if (limit <= MIN_OLLAMA_EMBED_INPUT_CHARS) throw contextRetryExhaustedError(text.length, candidate.length, lastError);
			limit = shrinkEmbeddingLimit(limit);
		}
	}
}

async function recoverContextLengthBatch(texts: string[], config: OllamaEmbeddingConfig, signal?: AbortSignal): Promise<number[][]> {
	if (texts.length <= 1) return [await embedOneWithOllama(texts[0] ?? "", config, signal)];
	const midpoint = Math.ceil(texts.length / 2);
	const left = await embedBatchWithOllama(texts.slice(0, midpoint), config, signal);
	const right = await embedBatchWithOllama(texts.slice(midpoint), config, signal);
	return [...left, ...right];
}

async function embedBatchWithOllama(texts: string[], config: OllamaEmbeddingConfig, signal?: AbortSignal): Promise<number[][]> {
	const preparedTexts = texts.map((text) => truncateEmbeddingInput(text, config.maxInputChars));
	try {
		return await fetchOllamaEmbeddings(preparedTexts, config, signal);
	} catch (error) {
		if (isOllamaEmbedEndpointMissing(error)) {
			const embeddings: number[][] = [];
			for (const text of texts) embeddings.push(await embedOneWithLegacyOllama(text, config, signal));
			return embeddings;
		}
		if (isOllamaContextLengthError(error)) return recoverContextLengthBatch(texts, config, signal);
		throw error;
	}
}

async function embedTextsWithOllama(texts: string[], config: OllamaEmbeddingConfig, signal?: AbortSignal): Promise<number[][]> {
	const embeddings: number[][] = [];
	for (let start = 0; start < texts.length; start += config.batchSize) {
		const batch = texts.slice(start, start + config.batchSize);
		embeddings.push(...await embedBatchWithOllama(batch, config, signal));
	}
	return embeddings;
}

function embeddingInputForChunk(chunk: IndexedChunk): string {
	return [`Path: ${chunk.path}`, chunk.symbols.length > 0 ? `Symbols: ${chunk.symbols.join(", ")}` : undefined, chunk.text]
		.filter(Boolean)
		.join("\n");
}

function embeddingInputForCard(card: IndexedCard): string {
	return card.text;
}

function hasOllamaEmbeddings(index: SearchIndex, config?: OllamaEmbeddingConfig): boolean {
	if (!index.embedding || index.embedding.provider !== "ollama") return false;
	if (config && (index.embedding.model !== config.model || index.embedding.baseUrl !== config.baseUrl || index.embedding.inputMaxChars !== config.maxInputChars)) return false;
	const dimensions = index.embedding.dimensions;
	const chunkEmbeddingsReady = index.chunks.length > 0 && index.chunks.every((chunk) => Array.isArray(chunk.embedding) && chunk.embedding.length === dimensions);
	const cardEmbeddingsReady = (index.cards ?? []).every((card) => Array.isArray(card.embedding) && card.embedding.length === dimensions);
	return chunkEmbeddingsReady && cardEmbeddingsReady;
}

function extractSymbols(relativePath: string, text: string): string[] {
	const symbols: string[] = [];
	const lines = text.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		const markdown = trimmed.match(/^#{1,6}\s+(.+)$/);
		if (markdown?.[1]) symbols.push(markdown[1].trim());

		const functionMatch = trimmed.match(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
		if (functionMatch?.[1]) symbols.push(functionMatch[1]);

		const namedType = trimmed.match(/(?:export\s+)?(?:abstract\s+)?(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/);
		if (namedType?.[1]) symbols.push(namedType[1]);

		const variable = trimmed.match(/(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
		if (variable?.[1]) symbols.push(variable[1]);

		const command = trimmed.match(/registerCommand\(\s*["']([^"']+)["']/);
		if (command?.[1]) symbols.push(`/${command[1]}`);
	}

	for (const match of text.matchAll(/name\s*:\s*["']([A-Za-z0-9_.:-]+)["']/g)) {
		if (match[1]) symbols.push(match[1]);
	}

	if (symbols.length === 0 && relativePath.endsWith(".md")) {
		symbols.push(basename(relativePath));
	}
	return unique(symbols).slice(0, 50);
}

function symbolsForRange(symbols: string[], chunkText: string): string[] {
	if (symbols.length === 0) return [];
	const lower = chunkText.toLowerCase();
	const inChunk = symbols.filter((symbol) => lower.includes(symbol.toLowerCase().replace(/^\//, "")));
	return (inChunk.length > 0 ? inChunk : symbols.slice(0, 5)).slice(0, 12);
}

type SemanticDefinition = {
	kind: SemanticCardKind;
	name: string;
	signature: string;
	startLine: number;
	endLine: number;
	level?: number;
};

const CALL_STOPWORDS = new Set([
	"begin",
	"case",
	"catch",
	"class",
	"def",
	"describe",
	"do",
	"else",
	"elsif",
	"end",
	"expect",
	"for",
	"function",
	"if",
	"import",
	"include",
	"let",
	"new",
	"raise",
	"require",
	"return",
	"switch",
	"throw",
	"unless",
	"while",
]);

function lineIndent(line: string): number {
	return line.match(/^\s*/)?.[0].length ?? 0;
}

function compactWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function humanizeIdentifier(value: string): string {
	return compactWhitespace(value
		.replace(/::/g, " ")
		.replace(/[.#]/g, " ")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.replace(/[!?=]/g, "")
		.replace(/[_.:/\\-]+/g, " ")
		.toLowerCase());
}

function classifyPathRoles(relativePath: string): string[] {
	const path = relativePath.toLowerCase();
	const roles: string[] = [];
	if (/controllers?\//.test(path) || /_controller\./.test(path)) roles.push("controller actions and request handling");
	if (/services?\//.test(path) || /_service\./.test(path)) roles.push("service-layer business workflow");
	if (/jobs?\//.test(path) || /_job\./.test(path)) roles.push("background job processing");
	if (/models?\//.test(path)) roles.push("domain model behavior");
	if (/polic(y|ies)\//.test(path) || /_policy\./.test(path)) roles.push("authorization policy");
	if (/mailers?\//.test(path) || /_mailer\./.test(path)) roles.push("email delivery");
	if (/subscribers?\//.test(path) || /_subscriber\./.test(path)) roles.push("event subscriber");
	if (/queries?\//.test(path) || /_query\./.test(path)) roles.push("query object");
	if (/components?\//.test(path) || /component\./.test(path)) roles.push("UI component");
	if (/clients?\//.test(path) || /_client\./.test(path)) roles.push("external API client");
	if (/integrations?\//.test(path)) roles.push("external integration");
	if (/serializers?\//.test(path) || /_serializer\./.test(path)) roles.push("serialization");
	if (/forms?\//.test(path) || /_form\./.test(path)) roles.push("form object");
	if (/migrations?\//.test(path)) roles.push("database migration");
	if (isTestPath(relativePath)) roles.push("test coverage");
	return roles.slice(0, 4);
}

function inferConceptsFromText(text: string): string[] {
	return unique(tokenizeSearchText(text)
		.filter((term) => term.startsWith("concept:"))
		.map((term) => term.slice("concept:".length)))
		.slice(0, 8);
}

function extractLeadingComments(lines: string[], startLine: number): string[] {
	const comments: string[] = [];
	for (let index = startLine - 2; index >= 0 && comments.length < MAX_CARD_COMMENTS; index--) {
		const trimmed = lines[index]?.trim() ?? "";
		if (!trimmed) {
			if (comments.length > 0) break;
			continue;
		}
		const comment = trimmed
			.replace(/^#\s?/, "")
			.replace(/^\/\/\s?/, "")
			.replace(/^\/\*+\s?/, "")
			.replace(/^\*\s?/, "")
			.replace(/^<!--\s?/, "")
			.replace(/\s?-->$/, "")
			.trim();
		if (comment === trimmed || !comment) break;
		comments.unshift(comment);
	}
	return comments;
}

function extractCalls(text: string): string[] {
	const calls: string[] = [];
	for (const match of text.matchAll(/\b([A-Za-z_$][\w$!?=]*)\s*\(/g)) {
		if (match[1]) calls.push(match[1]);
	}
	for (const match of text.matchAll(/[.:]\s*([A-Za-z_$][\w$!?=]*)\b/g)) {
		if (match[1]) calls.push(match[1]);
	}
	for (const match of text.matchAll(/:([A-Za-z_][\w!?=]*)\b/g)) {
		if (match[1]) calls.push(match[1]);
	}
	return unique(calls
		.map((call) => call.replace(/[!?=]$/, ""))
		.filter((call) => call.length > 1 && !CALL_STOPWORDS.has(call.toLowerCase()) && !/^\d+$/.test(call)))
		.slice(0, MAX_CARD_CALLS);
}

function nextDefinitionStart(definitions: SemanticDefinition[], definition: SemanticDefinition, fallback: number): number {
	const next = definitions.find((candidate) => candidate.startLine > definition.startLine);
	return next ? next.startLine - 1 : fallback;
}

function rubyBlockEndLine(lines: string[], startIndex: number, fallback: number): number {
	let depth = 0;
	for (let index = startIndex; index < lines.length; index++) {
		const code = (lines[index] ?? "").replace(/#.*$/, "").trim();
		if (!code) continue;
		if (/\b(class|module|def|if|unless|case|begin|for|while|until)\b/.test(code) || /\bdo\b/.test(code)) depth++;
		if (/^end\b/.test(code)) depth--;
		if (index > startIndex && depth <= 0) return index + 1;
		if (index + 1 >= fallback) return fallback;
	}
	return fallback;
}

function braceBlockEndLine(lines: string[], startIndex: number, fallback: number): number {
	let depth = 0;
	let seenBrace = false;
	for (let index = startIndex; index < lines.length; index++) {
		const line = lines[index] ?? "";
		for (const char of line) {
			if (char === "{") {
				depth++;
				seenBrace = true;
			} else if (char === "}") {
				depth--;
			}
		}
		if (seenBrace && index > startIndex && depth <= 0) return index + 1;
		if (index + 1 >= fallback) return fallback;
	}
	return fallback;
}

function indentedBlockEndLine(lines: string[], startIndex: number, fallback: number): number {
	const indent = lineIndent(lines[startIndex] ?? "");
	for (let index = startIndex + 1; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (!line.trim() || line.trim().startsWith("#")) continue;
		if (lineIndent(line) <= indent) return index;
		if (index + 1 >= fallback) return fallback;
	}
	return fallback;
}

function computeDefinitionEndLine(definition: SemanticDefinition, definitions: SemanticDefinition[], lines: string[], language: string): number {
	const fallback = nextDefinitionStart(definitions, definition, lines.length);
	const startIndex = definition.startLine - 1;
	if (definition.kind === "heading") {
		const nextHeading = definitions.find((candidate) => candidate.kind === "heading" && candidate.startLine > definition.startLine && (candidate.level ?? 99) <= (definition.level ?? 99));
		return nextHeading ? nextHeading.startLine - 1 : lines.length;
	}
	if (language === "ruby" || language === "erb") return rubyBlockEndLine(lines, startIndex, ["class", "module"].includes(definition.kind) ? lines.length : fallback);
	if (language === "python") return indentedBlockEndLine(lines, startIndex, definition.kind === "class" ? lines.length : fallback);
	if (["typescript", "javascript", "jvm", "go", "rust"].includes(language)) return braceBlockEndLine(lines, startIndex, definition.kind === "class" ? lines.length : fallback);
	return fallback;
}

function rawDefinitionsForLine(line: string, language: string): Array<Omit<SemanticDefinition, "startLine" | "endLine">> {
	const trimmed = line.trim();
	const definitions: Array<Omit<SemanticDefinition, "startLine" | "endLine">> = [];
	if (!trimmed) return definitions;

	const markdown = trimmed.match(/^(#{1,6})\s+(.+)$/);
	if (language === "markdown" && markdown?.[1] && markdown[2]) {
		definitions.push({ kind: "heading", name: markdown[2].trim(), signature: trimmed, level: markdown[1].length });
		return definitions;
	}

	if (language === "ruby" || language === "erb") {
		const container = trimmed.match(/^(class|module)\s+([A-Za-z_][\w:]*)/);
		if (container?.[1] && container[2]) definitions.push({ kind: container[1] === "module" ? "module" : "class", name: container[2], signature: trimmed });
		const method = trimmed.match(/^def\s+(?:self\.)?([A-Za-z_][\w!?=]*)/);
		if (method?.[1]) definitions.push({ kind: "method", name: method[1], signature: trimmed });
		return definitions;
	}

	if (language === "typescript" || language === "javascript") {
		const namedType = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?(class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/);
		if (namedType?.[1] && namedType[2]) definitions.push({ kind: namedType[1] === "class" ? "class" : "definition", name: namedType[2], signature: trimmed });
		const fn = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
		if (fn?.[1]) definitions.push({ kind: "function", name: fn[1], signature: trimmed });
		const variableFn = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/);
		if (variableFn?.[1]) definitions.push({ kind: "function", name: variableFn[1], signature: trimmed });
		const method = trimmed.match(/^(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^={]+)?\s*\{?\s*$/);
		if (method?.[1] && !CALL_STOPWORDS.has(method[1].toLowerCase())) definitions.push({ kind: "method", name: method[1], signature: trimmed });
		return definitions;
	}

	if (language === "python") {
		const klass = trimmed.match(/^class\s+([A-Za-z_][\w]*)/);
		if (klass?.[1]) definitions.push({ kind: "class", name: klass[1], signature: trimmed });
		const fn = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_][\w]*)/);
		if (fn?.[1]) definitions.push({ kind: "function", name: fn[1], signature: trimmed });
		return definitions;
	}

	if (language === "go") {
		const fn = trimmed.match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/);
		if (fn?.[1]) definitions.push({ kind: "function", name: fn[1], signature: trimmed });
		return definitions;
	}

	if (language === "rust") {
		const named = trimmed.match(/^(?:pub\s+)?(?:async\s+)?(fn|struct|enum|trait|impl)\s+([A-Za-z_][\w]*)?/);
		if (named?.[1]) definitions.push({ kind: named[1] === "fn" ? "function" : "definition", name: named[2] ?? named[1], signature: trimmed });
		return definitions;
	}

	if (language === "jvm") {
		const klass = trimmed.match(/^(?:public\s+|private\s+|protected\s+)?(?:abstract\s+)?(?:class|interface|enum)\s+([A-Za-z_][\w]*)/);
		if (klass?.[1]) definitions.push({ kind: "class", name: klass[1], signature: trimmed });
		const method = trimmed.match(/^(?:public|private|protected|static|final|suspend|override|open|fun|\s)+[\w<>, ?\[\]]+\s+([A-Za-z_][\w]*)\s*\(/);
		if (method?.[1] && !CALL_STOPWORDS.has(method[1].toLowerCase())) definitions.push({ kind: "method", name: method[1], signature: trimmed });
	}

	return definitions;
}

function findSemanticDefinitions(relativePath: string, text: string): SemanticDefinition[] {
	const language = languageForPath(relativePath);
	const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
	const definitions: SemanticDefinition[] = [];
	for (const [index, line] of lines.entries()) {
		for (const definition of rawDefinitionsForLine(line, language)) {
			definitions.push({ ...definition, startLine: index + 1, endLine: index + 1 });
		}
	}
	definitions.sort((a, b) => a.startLine - b.startLine || a.kind.localeCompare(b.kind));
	const uniqueDefinitions = unique(definitions.map((definition) => `${definition.kind}:${definition.name}:${definition.startLine}`))
		.map((key) => definitions.find((definition) => `${definition.kind}:${definition.name}:${definition.startLine}` === key)!)
		.filter(Boolean);
	for (const definition of uniqueDefinitions) definition.endLine = computeDefinitionEndLine(definition, uniqueDefinitions, lines, language);
	return uniqueDefinitions.slice(0, MAX_SEMANTIC_CARDS_PER_FILE);
}

function nearestContainer(definition: SemanticDefinition, definitions: SemanticDefinition[]): SemanticDefinition | undefined {
	return definitions
		.filter((candidate) => ["class", "module"].includes(candidate.kind) && candidate.startLine < definition.startLine && candidate.endLine >= definition.endLine)
		.sort((a, b) => b.startLine - a.startLine)[0];
}

function displayNameForDefinition(relativePath: string, definition: SemanticDefinition, definitions: SemanticDefinition[]): string {
	if (!["method", "function"].includes(definition.kind)) return definition.name;
	const container = nearestContainer(definition, definitions);
	if (!container) return definition.name;
	const separator = languageForPath(relativePath) === "ruby" || languageForPath(relativePath) === "erb" ? "#" : ".";
	return `${container.name}${separator}${definition.name}`;
}

function topCardTerms(text: string): string[] {
	return unique(tokenizeSearchText(text).filter((term) => !term.startsWith("concept:"))).slice(0, MAX_CARD_TERMS);
}

function summarizeSemanticCard(kind: SemanticCardKind, name: string, relativePath: string, bodyText: string, comments: string[]): { summary: string; concepts: string[]; calls: string[]; terms: string[] } {
	const calls = extractCalls(bodyText);
	const roles = classifyPathRoles(relativePath);
	const concepts = inferConceptsFromText([relativePath, name, bodyText, comments.join(" "), roles.join(" ")].join("\n"));
	const terms = topCardTerms([relativePath, name, bodyText, comments.join(" ")].join("\n"));
	const pieces = [`${kind === "file" ? "File" : `${kind} ${name}`} covers ${humanizeIdentifier(name) || basename(relativePath)}`];
	if (roles.length > 0) pieces.push(`Role: ${roles.join(", ")}`);
	if (concepts.length > 0) pieces.push(`Concepts: ${concepts.join(", ")}`);
	if (calls.length > 0) pieces.push(`Calls or references: ${calls.slice(0, 8).join(", ")}`);
	if (comments.length > 0) pieces.push(`Docs/comments: ${comments.slice(0, 3).join(" ")}`);
	return { summary: pieces.join(". "), concepts, calls, terms };
}

function semanticCardText(card: Omit<IndexedCard, "vector" | "embedding" | "text">, extras: { concepts: string[]; calls: string[]; terms: string[]; snippet: string }): string {
	const parts = [
		`Path: ${card.path}`,
		`Kind: ${card.kind}`,
		`Name: ${card.name}`,
		`Lines: ${card.startLine}-${card.endLine}`,
		card.symbols.length > 0 ? `Symbols: ${card.symbols.join(", ")}` : undefined,
		`Summary: ${card.summary}`,
		extras.concepts.length > 0 ? `Concepts: ${extras.concepts.join(", ")}` : undefined,
		extras.calls.length > 0 ? `Calls: ${extras.calls.join(", ")}` : undefined,
		extras.terms.length > 0 ? `Terms: ${extras.terms.join(", ")}` : undefined,
		extras.snippet ? `Snippet:\n${extras.snippet}` : undefined,
	].filter(Boolean).join("\n");
	return parts.length > MAX_CARD_TEXT_CHARS ? `${parts.slice(0, MAX_CARD_TEXT_CHARS - 1)}…` : parts;
}

function extractSemanticCards(relativePath: string, text: string, fileSymbols: string[]): Omit<IndexedCard, "vector">[] {
	const normalized = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
	const lines = normalized.length > 0 ? normalized.split("\n") : [""];
	const definitions = findSemanticDefinitions(relativePath, normalized);
	const cards: Omit<IndexedCard, "vector">[] = [];

	const fileSnippet = lines.slice(0, MAX_CARD_BODY_LINES).join("\n");
	const fileComments = extractLeadingComments(lines, 1);
	const fileSummary = summarizeSemanticCard("file", basename(relativePath), relativePath, [fileSymbols.join(" "), fileSnippet].join("\n"), fileComments);
	const fileCardBase: Omit<IndexedCard, "vector" | "embedding" | "text"> = {
		id: `${relativePath}:semantic:file`,
		path: relativePath,
		startLine: 1,
		endLine: Math.min(lines.length, MAX_CARD_BODY_LINES),
		kind: "file",
		name: basename(relativePath),
		summary: fileSummary.summary,
		symbols: fileSymbols.slice(0, 12),
	};
	cards.push({ ...fileCardBase, text: semanticCardText(fileCardBase, { ...fileSummary, snippet: fileSnippet }) });

	for (const definition of definitions) {
		if (cards.length >= MAX_SEMANTIC_CARDS_PER_FILE) break;
		const startIndex = definition.startLine - 1;
		const bodyEnd = Math.min(definition.endLine, definition.startLine + MAX_CARD_BODY_LINES - 1);
		const bodyText = lines.slice(startIndex, bodyEnd).join("\n");
		const name = displayNameForDefinition(relativePath, definition, definitions);
		const comments = extractLeadingComments(lines, definition.startLine);
		const semantic = summarizeSemanticCard(definition.kind, name, relativePath, [definition.signature, bodyText].join("\n"), comments);
		const symbols = unique([name, definition.name, ...symbolsForRange(fileSymbols, bodyText)]).slice(0, 12);
		const base: Omit<IndexedCard, "vector" | "embedding" | "text"> = {
			id: `${relativePath}:semantic:${definition.startLine}-${definition.endLine}:${definition.kind}:${definition.name}`,
			path: relativePath,
			startLine: definition.startLine,
			endLine: definition.endLine,
			kind: definition.kind,
			name,
			summary: semantic.summary,
			symbols,
		};
		cards.push({ ...base, text: semanticCardText(base, { ...semantic, snippet: bodyText }) });
	}

	return cards;
}

function splitIntoChunks(relativePath: string, text: string, options: Required<Pick<BuildOptions, "chunkLines" | "chunkOverlap">>): Omit<IndexedChunk, "vector">[] {
	const normalized = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
	const lines = normalized.length > 0 ? normalized.split("\n") : [""];
	const fileSymbols = extractSymbols(relativePath, text);
	const chunkLines = Math.max(20, options.chunkLines);
	const overlap = Math.min(Math.max(0, options.chunkOverlap), chunkLines - 1);
	const step = Math.max(1, chunkLines - overlap);
	const chunks: Omit<IndexedChunk, "vector">[] = [];

	for (let start = 0; start < lines.length; start += step) {
		const end = Math.min(lines.length, start + chunkLines);
		const chunkText = lines.slice(start, end).join("\n");
		chunks.push({
			id: `${relativePath}:${start + 1}-${end}`,
			path: relativePath,
			startLine: start + 1,
			endLine: end,
			text: chunkText,
			symbols: symbolsForRange(fileSymbols, chunkText),
		});
		if (end >= lines.length) break;
	}

	return chunks;
}

function indexFile(cwd: string, relativePath: string, options: Required<BuildOptions>): { file: IndexedFile; chunks: IndexedChunk[]; cards: IndexedCard[] } | undefined {
	const fullPath = join(cwd, relativePath);
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(fullPath);
	} catch {
		return undefined;
	}
	if (!stat.isFile() || stat.size > options.maxFileBytes) return undefined;

	const buffer = readFileSync(fullPath);
	if (isLikelyBinary(buffer)) return undefined;
	const text = buffer.toString("utf8");
	if (!text.trim()) return undefined;

	const hash = hashBuffer(buffer);
	const symbols = extractSymbols(relativePath, text);
	const chunks = splitIntoChunks(relativePath, text, options).map((chunk) => ({
		...chunk,
		vector: makeVector([
			{ text: chunk.text, weight: 1 },
			{ text: relativePath, weight: 2.6 },
			{ text: chunk.symbols.join(" "), weight: 3.4 },
		]),
	}));
	const cards = extractSemanticCards(relativePath, text, symbols).map((card) => ({
		...card,
		vector: makeVector([
			{ text: card.text, weight: 1.8 },
			{ text: card.summary, weight: 3.2 },
			{ text: relativePath, weight: 2.8 },
			{ text: card.symbols.join(" "), weight: 3.6 },
		]),
	}));

	return {
		file: {
			path: relativePath,
			hash,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			language: languageForPath(relativePath),
			chunks: chunks.length,
			symbols,
		},
		chunks,
		cards,
	};
}

export function buildSearchIndex(cwd: string, options: BuildOptions = {}): SearchIndex {
	const absoluteCwd = resolve(cwd);
	const resolvedOptions: Required<BuildOptions> = {
		chunkLines: options.chunkLines ?? DEFAULT_CHUNK_LINES,
		chunkOverlap: options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP,
		maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
		writeToDisk: options.writeToDisk ?? true,
	};

	const files: IndexedFile[] = [];
	const chunks: IndexedChunk[] = [];
	const cards: IndexedCard[] = [];
	for (const relativePath of discoverProjectFiles(absoluteCwd)) {
		const indexed = indexFile(absoluteCwd, relativePath, resolvedOptions);
		if (!indexed) continue;
		files.push(indexed.file);
		chunks.push(...indexed.chunks);
		cards.push(...indexed.cards);
	}

	const now = new Date().toISOString();
	const index: SearchIndex = {
		version: INDEX_VERSION,
		cwd: absoluteCwd,
		createdAt: now,
		updatedAt: now,
		options: {
			chunkLines: resolvedOptions.chunkLines,
			chunkOverlap: resolvedOptions.chunkOverlap,
			maxFileBytes: resolvedOptions.maxFileBytes,
		},
		files,
		chunks,
		cards,
	};

	memoryIndexes.set(absoluteCwd, index);
	if (resolvedOptions.writeToDisk) saveSearchIndex(index);
	return index;
}

export async function buildSearchIndexWithEmbeddings(cwd: string, options: EmbeddingBuildOptions = {}): Promise<SearchIndex> {
	const config = resolveOllamaEmbeddingConfig(options.ollama);
	const index = buildSearchIndex(cwd, { ...options, writeToDisk: false });
	if (index.chunks.length === 0) {
		index.embedding = {
			provider: "ollama",
			model: config.model,
			baseUrl: config.baseUrl,
			inputMaxChars: config.maxInputChars,
			dimensions: 0,
			embeddedChunks: 0,
			embeddedCards: 0,
			createdAt: new Date().toISOString(),
		};
		memoryIndexes.set(index.cwd, index);
		if (options.writeToDisk ?? true) saveSearchIndex(index);
		return index;
	}

	options.onProgress?.(`Embedding ${index.chunks.length} chunks and ${index.cards.length} semantic cards with Ollama model ${config.model} (max ${config.maxInputChars} chars/input)`);
	const chunkEmbeddings = await embedTextsWithOllama(index.chunks.map(embeddingInputForChunk), config, options.signal);
	const cardEmbeddings = index.cards.length > 0 ? await embedTextsWithOllama(index.cards.map(embeddingInputForCard), config, options.signal) : [];
	const dimensions = chunkEmbeddings[0]?.length ?? cardEmbeddings[0]?.length ?? 0;
	index.chunks = index.chunks.map((chunk, chunkIndex) => ({ ...chunk, embedding: chunkEmbeddings[chunkIndex] }));
	index.cards = index.cards.map((card, cardIndex) => ({ ...card, embedding: cardEmbeddings[cardIndex] }));
	index.embedding = {
		provider: "ollama",
		model: config.model,
		baseUrl: config.baseUrl,
		inputMaxChars: config.maxInputChars,
		dimensions,
		embeddedChunks: chunkEmbeddings.length,
		embeddedCards: cardEmbeddings.length,
		createdAt: new Date().toISOString(),
	};
	index.updatedAt = new Date().toISOString();

	memoryIndexes.set(index.cwd, index);
	if (options.writeToDisk ?? true) saveSearchIndex(index);
	return index;
}

function saveSearchIndex(index: SearchIndex): void {
	const indexPath = getIndexPath(index.cwd);
	mkdirSync(dirname(indexPath), { recursive: true });
	writeFileSync(indexPath, serializeSearchIndexForJson(index), "utf8");
}

export function loadSearchIndex(cwd: string): SearchIndex | undefined {
	const absoluteCwd = resolve(cwd);
	const cached = memoryIndexes.get(absoluteCwd);
	if (cached) return cached;

	const indexPath = getIndexPath(absoluteCwd);
	if (!existsSync(indexPath)) return undefined;
	try {
		const parsed = parseSearchIndexJson(readFileSync(indexPath, "utf8"));
		if (parsed.version !== INDEX_VERSION || parsed.cwd !== absoluteCwd) return undefined;
		memoryIndexes.set(absoluteCwd, parsed);
		return parsed;
	} catch {
		return undefined;
	}
}

function currentIndexableFileStats(cwd: string, maxFileBytes: number): Array<{ path: string; size: number; mtimeMs: number }> {
	const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
	for (const path of discoverProjectFiles(cwd)) {
		try {
			const stat = statSync(join(cwd, path));
			if (!stat.isFile() || stat.size > maxFileBytes) continue;
			const buffer = readFileSync(join(cwd, path));
			if (isLikelyBinary(buffer)) continue;
			if (!buffer.toString("utf8").trim()) continue;
			files.push({ path, size: stat.size, mtimeMs: stat.mtimeMs });
		} catch {
			// Ignore files that disappear while checking status.
		}
	}
	return files;
}

export function getIndexStatus(cwd: string, index = loadSearchIndex(cwd)): IndexStatus {
	const absoluteCwd = resolve(cwd);
	const indexPath = getIndexPath(absoluteCwd);
	if (!index) {
		return {
			indexPath,
			exists: existsSync(indexPath),
			stale: true,
			reason: existsSync(indexPath) ? "index file could not be loaded" : "index has not been built",
			files: 0,
			chunks: 0,
			cards: 0,
		};
	}

	const baseStatus = {
		indexPath,
		exists: true,
		files: index.files.length,
		chunks: index.chunks.length,
		cards: index.cards.length,
		updatedAt: index.updatedAt,
		embedding: index.embedding,
	};

	if (index.version !== INDEX_VERSION) {
		return { ...baseStatus, stale: true, reason: "index version changed" };
	}

	const byPath = new Map(index.files.map((file) => [file.path, file]));
	const current = currentIndexableFileStats(absoluteCwd, index.options.maxFileBytes);

	for (const file of current) {
		const indexed = byPath.get(file.path);
		if (!indexed) return { ...baseStatus, stale: true, reason: `new file: ${file.path}` };
		if (indexed.size !== file.size || Math.abs(indexed.mtimeMs - file.mtimeMs) > 1) {
			return { ...baseStatus, stale: true, reason: `changed file: ${file.path}` };
		}
	}

	const currentPaths = new Set(current.map((file) => file.path));
	for (const file of index.files) {
		if (!currentPaths.has(file.path)) return { ...baseStatus, stale: true, reason: `removed file: ${file.path}` };
	}

	return { ...baseStatus, stale: false, reason: "fresh" };
}

function ensureIndex(cwd: string, refresh: boolean): { index: SearchIndex; status: IndexStatus; rebuilt: boolean } {
	const absoluteCwd = resolve(cwd);
	let index = loadSearchIndex(absoluteCwd);
	let status = getIndexStatus(absoluteCwd, index);
	let rebuilt = false;
	if (!index || (refresh && status.stale)) {
		index = buildSearchIndex(absoluteCwd, { writeToDisk: true });
		status = getIndexStatus(absoluteCwd, index);
		rebuilt = true;
	}
	return { index, status, rebuilt };
}

async function ensureIndexWithEmbeddings(
	cwd: string,
	refresh: boolean,
	ollama: Partial<OllamaEmbeddingConfig> | undefined,
	signal?: AbortSignal,
	onProgress?: (message: string) => void,
): Promise<{ index: SearchIndex; status: IndexStatus; rebuilt: boolean; config: OllamaEmbeddingConfig }> {
	const absoluteCwd = resolve(cwd);
	const config = resolveOllamaEmbeddingConfig(ollama);
	let index = loadSearchIndex(absoluteCwd);
	let status = getIndexStatus(absoluteCwd, index);
	let rebuilt = false;
	if (!index || (refresh && status.stale) || !hasOllamaEmbeddings(index, config)) {
		index = await buildSearchIndexWithEmbeddings(absoluteCwd, { writeToDisk: true, ollama: config, signal, onProgress });
		status = getIndexStatus(absoluteCwd, index);
		rebuilt = true;
	}
	return { index, status, rebuilt, config };
}

function clampTopK(topK: number | undefined): number {
	return Math.min(Math.max(Math.floor(topK ?? DEFAULT_TOP_K), 1), MAX_TOP_K);
}

function isTestPath(path: string): boolean {
	return /(^|\/)(__tests__|tests?|specs?)(\/|$)/i.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(path);
}

function pathMatches(path: string, filters: string[] | undefined): boolean {
	if (!filters || filters.length === 0) return true;
	return filters.some((filter) => {
		const normalized = normalizeRelativePath(filter.replace(/^@/, "").trim());
		return normalized.length > 0 && (path === normalized || path.startsWith(`${normalized}/`) || path.includes(normalized));
	});
}

function scoreTokenOverlap(queryTerms: string[], vectorTerms: Set<string>): number {
	if (queryTerms.length === 0) return 0;
	const matches = queryTerms.filter((term) => vectorTerms.has(term));
	return matches.length / queryTerms.length;
}

function scoreTextOverlap(queryTerms: string[], text: string): number {
	if (queryTerms.length === 0) return 0;
	const haystack = tokenizeSearchText(text);
	const terms = new Set(haystack);
	return scoreTokenOverlap(queryTerms, terms);
}

type SearchableVectorItem = Pick<IndexedChunk, "path" | "symbols" | "vector"> & Partial<Pick<IndexedCard, "kind" | "name" | "summary">>;

function buildReason(queryTerms: string[], queryConcepts: string[], item: SearchableVectorItem, vectorTerms: Set<string>): string[] {
	const exactMatches = queryTerms.filter((term) => vectorTerms.has(term)).slice(0, 6);
	const conceptMatches = queryConcepts.filter((term) => vectorTerms.has(term)).map((term) => term.slice("concept:".length));
	const pathMatches = queryTerms.filter((term) => tokenizeSearchText(item.path).includes(term)).slice(0, 3);
	const symbolMatches = queryTerms.filter((term) => tokenizeSearchText(item.symbols.join(" ")).includes(term)).slice(0, 3);

	const reason: string[] = [];
	if (item.kind && item.name) reason.push(`semantic card: ${item.kind} ${item.name}`);
	if (conceptMatches.length > 0) reason.push(`matched ${unique(conceptMatches).join(", ")} concept`);
	if (exactMatches.length > 0) reason.push(`matched terms: ${exactMatches.join(", ")}`);
	if (symbolMatches.length > 0) reason.push(`symbol match: ${symbolMatches.join(", ")}`);
	if (pathMatches.length > 0) reason.push(`path match: ${pathMatches.join(", ")}`);
	return reason.length > 0 ? reason : ["vector similarity"];
}

function previewText(text: string): string {
	const lines = text
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0)
		.slice(0, MAX_PREVIEW_LINES)
		.map((line) => (line.length > MAX_PREVIEW_LINE_CHARS ? `${line.slice(0, MAX_PREVIEW_LINE_CHARS - 1)}…` : line));
	return lines.join("\n");
}

export function searchIndex(index: SearchIndex, options: SearchOptions): SearchResult[] {
	const topK = clampTopK(options.topK);
	const queryVector = makeQueryVector(options.query);
	if (queryVector.size === 0 && !options.queryEmbedding) return [];

	const queryTokens = unique(tokenizeSearchText(options.query));
	const queryTerms = queryTokens.filter((term) => !term.startsWith("concept:"));
	const queryConcepts = queryTokens.filter((term) => term.startsWith("concept:"));
	const minScore = options.minScore ?? 0.001;
	const queryEmbedding = options.queryEmbedding ? normalizeEmbedding(options.queryEmbedding) : undefined;
	const results: SearchResult[] = [];

	const addResult = (item: IndexedChunk | IndexedCard, source: "chunk" | "card") => {
		if (options.includeTests === false && isTestPath(item.path)) return;
		if (!pathMatches(item.path, options.paths)) return;

		const vectorTerms = new Set(item.vector.map(([term]) => term));
		const vectorScore = cosine(queryVector, item.vector);
		const lexicalScore = scoreTokenOverlap(queryTerms, vectorTerms);
		const pathScore = scoreTextOverlap(queryTerms, item.path);
		const symbolScore = scoreTextOverlap(queryTerms, item.symbols.join(" "));
		const embeddingScore = queryEmbedding ? embeddingCosine(queryEmbedding, item.embedding) : undefined;
		const rawScore =
			typeof embeddingScore === "number"
				? embeddingScore * (source === "card" ? 0.7 : 0.62) + vectorScore * (source === "card" ? 0.16 : 0.2) + lexicalScore * 0.08 + pathScore * 0.04 + symbolScore * 0.02
				: vectorScore * (source === "card" ? 0.78 : 0.72) + lexicalScore * 0.14 + pathScore * 0.05 + symbolScore * 0.03;
		const score = source === "card" ? rawScore * 1.05 : rawScore;
		if (score < minScore) return;

		const reason = buildReason(queryTerms, queryConcepts, item, vectorTerms);
		if (source === "card" && "summary" in item && item.summary) reason.push(`summary: ${item.summary.slice(0, 120)}${item.summary.length > 120 ? "…" : ""}`);
		if (typeof embeddingScore === "number" && embeddingScore > 0.05) reason.unshift(source === "card" ? "Ollama semantic-card similarity" : "Ollama embedding similarity");
		results.push({
			path: item.path,
			startLine: item.startLine,
			endLine: item.endLine,
			source,
			cardKind: source === "card" && "kind" in item ? item.kind : undefined,
			cardName: source === "card" && "name" in item ? item.name : undefined,
			cardSummary: source === "card" && "summary" in item ? item.summary : undefined,
			score,
			vectorScore,
			lexicalScore,
			pathScore,
			symbolScore,
			embeddingScore,
			symbols: item.symbols,
			reason,
			preview: source === "card" && "summary" in item ? previewText(item.summary) : previewText(item.text),
		});
	};

	for (const chunk of index.chunks) addResult(chunk, "chunk");
	for (const card of index.cards) addResult(card, "card");

	return results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, topK);
}

export async function searchIndexWithEmbeddings(
	index: SearchIndex,
	options: SearchOptions & { ollama?: Partial<OllamaEmbeddingConfig>; signal?: AbortSignal },
): Promise<{ results: SearchResult[]; embeddingUsed: boolean; config: OllamaEmbeddingConfig }> {
	const config = resolveOllamaEmbeddingConfig({
		model: options.ollama?.model ?? index.embedding?.model,
		baseUrl: options.ollama?.baseUrl ?? index.embedding?.baseUrl,
		batchSize: options.ollama?.batchSize,
		timeoutMs: options.ollama?.timeoutMs,
		maxInputChars: options.ollama?.maxInputChars ?? index.embedding?.inputMaxChars,
	});
	if (!hasOllamaEmbeddings(index, config)) {
		return { results: searchIndex(index, options), embeddingUsed: false, config };
	}
	const [queryEmbedding] = await embedTextsWithOllama([options.query], config, options.signal);
	return { results: searchIndex(index, { ...options, queryEmbedding }), embeddingUsed: true, config };
}

export function formatSearchResults(query: string, results: SearchResult[], index: SearchIndex): string {
	if (results.length === 0) {
		return `No semantic search results for "${query}". Index contains ${index.files.length} files / ${index.chunks.length} chunks / ${index.cards.length} semantic cards.`;
	}

	const embeddingLabel = index.embedding ? `, embeddings: ollama/${index.embedding.model}` : "";
	return [
		`Semantic search results for "${query}" (${results.length} shown, index: ${index.files.length} files / ${index.chunks.length} chunks / ${index.cards.length} semantic cards${embeddingLabel}):`,
		"",
		...results.map((result, index) => {
			const scoreParts = [`vector ${result.vectorScore.toFixed(3)}`, `lexical ${result.lexicalScore.toFixed(3)}`];
			if (typeof result.embeddingScore === "number") scoreParts.unshift(`embedding ${result.embeddingScore.toFixed(3)}`);
			const sourceLabel = result.source === "card" ? ` [semantic card${result.cardKind ? `: ${result.cardKind}` : ""}${result.cardName ? ` ${result.cardName}` : ""}]` : "";
			const lines = [
				`${index + 1}. ${result.path}:${result.startLine}-${result.endLine}${sourceLabel}`,
				`   Score: ${result.score.toFixed(3)} (${scoreParts.join(", ")})`,
				`   Why: ${result.reason.join("; ")}`,
			];
			if (result.symbols.length > 0) lines.push(`   Symbols: ${result.symbols.slice(0, 8).join(", ")}`);
			if (result.preview) {
				lines.push("   Preview:");
				for (const line of result.preview.split("\n")) lines.push(`     ${line}`);
			}
			return lines.join("\n");
		}),
	].join("\n");
}

function directorySummary(files: IndexedFile[]): Array<{ path: string; files: number }> {
	const counts = new Map<string, number>();
	for (const file of files) {
		const dir = dirname(file.path);
		const key = dir === "." ? "./" : dir.split("/").slice(0, 2).join("/");
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([path, count]) => ({ path, files: count }))
		.sort((a, b) => b.files - a.files || a.path.localeCompare(b.path))
		.slice(0, 12);
}

export function createRepoMap(index: SearchIndex, options: { maxClusters?: number } = {}): RepoMap {
	const maxClusters = Math.min(Math.max(options.maxClusters ?? 8, 1), 20);
	const fileScores = new Map<string, Map<string, { score: number; symbols: Set<string>; terms: Map<string, number> }>>();

	const collectConcepts = (item: IndexedChunk | IndexedCard, multiplier: number) => {
		const concepts = item.vector.filter(([term]) => term.startsWith("concept:"));
		const rawTerms = topTerms(item.vector, 12, (term) => !term.startsWith("concept:"));
		for (const [conceptTerm, weight] of concepts) {
			const concept = conceptTerm.slice("concept:".length);
			let files = fileScores.get(concept);
			if (!files) {
				files = new Map();
				fileScores.set(concept, files);
			}
			const current = files.get(item.path) ?? { score: 0, symbols: new Set<string>(), terms: new Map<string, number>() };
			current.score += weight * multiplier;
			for (const symbol of item.symbols) current.symbols.add(symbol);
			for (const term of rawTerms) current.terms.set(term, (current.terms.get(term) ?? 0) + 1);
			files.set(item.path, current);
		}
	};

	for (const chunk of index.chunks) collectConcepts(chunk, 1);
	for (const card of index.cards) collectConcepts(card, 1.25);

	const clusters: RepoCluster[] = [...fileScores.entries()].map(([name, files]) => {
		const rankedFiles = [...files.entries()]
			.map(([path, data]) => ({ path, score: data.score, symbols: [...data.symbols].slice(0, 8), terms: data.terms }))
			.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
		const terms = new Map<string, number>();
		for (const file of rankedFiles) {
			for (const [term, count] of file.terms) terms.set(term, (terms.get(term) ?? 0) + count);
		}
		return {
			name,
			score: rankedFiles.reduce((sum, file) => sum + file.score, 0),
			files: rankedFiles.slice(0, 8).map(({ path, score, symbols }) => ({ path, score, symbols })),
			terms: [...terms.entries()]
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
				.slice(0, 8)
				.map(([term]) => term),
		};
	});

	clusters.sort((a, b) => b.files.length - a.files.length || b.score - a.score || a.name.localeCompare(b.name));
	return { clusters: clusters.slice(0, maxClusters), topDirectories: directorySummary(index.files) };
}

export function formatRepoMap(map: RepoMap, index: SearchIndex): string {
	const lines = [`Repo map (${index.files.length} files / ${index.chunks.length} chunks / ${index.cards.length} semantic cards):`];
	if (map.clusters.length === 0) {
		lines.push("No strong concept clusters found yet. Add more source/docs files or rebuild the index.");
		return lines.join("\n");
	}

	lines.push("", "Concept clusters:");
	for (const [clusterIndex, cluster] of map.clusters.entries()) {
		lines.push(`${clusterIndex + 1}. ${cluster.name} (${cluster.files.length} file${cluster.files.length === 1 ? "" : "s"})`);
		if (cluster.terms.length > 0) lines.push(`   Signals: ${cluster.terms.join(", ")}`);
		for (const file of cluster.files.slice(0, 5)) {
			const symbols = file.symbols.length > 0 ? ` — ${file.symbols.slice(0, 4).join(", ")}` : "";
			lines.push(`   - ${file.path}${symbols}`);
		}
	}

	if (map.topDirectories.length > 0) {
		lines.push("", "Top directories:");
		for (const dir of map.topDirectories.slice(0, 8)) lines.push(`- ${dir.path}: ${dir.files} file${dir.files === 1 ? "" : "s"}`);
	}
	return lines.join("\n");
}

function formatStatus(status: IndexStatus, rebuilt = false): string {
	return [
		`Semantic search index: ${status.stale ? "stale" : "fresh"}${rebuilt ? " (rebuilt)" : ""}`,
		`Path: ${status.indexPath}`,
		`Files: ${status.files}`,
		`Chunks: ${status.chunks}`,
		`Semantic cards: ${status.cards}`,
		`Embeddings: ${status.embedding ? `ollama/${status.embedding.model} (${status.embedding.dimensions} dims, ${status.embedding.embeddedChunks} chunks, ${status.embedding.embeddedCards} cards, max ${status.embedding.inputMaxChars ?? "unknown"} chars/input)` : "none"}`,
		`Updated: ${status.updatedAt ?? "never"}`,
		`Reason: ${status.reason}`,
	].join("\n");
}

function compactResultDetails(results: SearchResult[]) {
	return results.map((result) => ({
		path: result.path,
		startLine: result.startLine,
		endLine: result.endLine,
		source: result.source,
		cardKind: result.cardKind,
		cardName: result.cardName,
		cardSummary: result.cardSummary,
		score: Number(result.score.toFixed(4)),
		embeddingScore: typeof result.embeddingScore === "number" ? Number(result.embeddingScore.toFixed(4)) : undefined,
		reason: result.reason,
		symbols: result.symbols,
		preview: result.preview,
	}));
}

export default function semanticSearchExtension(pi: ExtensionAPI) {
	pi.registerCommand("index", {
		description: "Build, rebuild, or show status for the semantic code-search index. Usage: /index [status|rebuild|build|lexical] [ollama-model]",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const action = tokens[0] ?? "rebuild";
			if (action === "status") {
				const status = getIndexStatus(ctx.cwd);
				ctx.ui.notify(status.stale ? `Index stale: ${status.reason}` : `Index fresh: ${status.files} files / ${status.chunks} chunks / ${status.cards} semantic cards`, status.stale ? "warning" : "info");
				pi.sendMessage?.({ customType: "semantic-search", content: formatStatus(status), display: true, details: status });
				return;
			}

			const lexicalOnly = tokens.includes("lexical") || tokens.includes("--lexical");
			const model = tokens.find((token) => !["rebuild", "build", "embeddings", "--embeddings", "--ollama", "lexical", "--lexical"].includes(token));
			ctx.ui.setStatus?.("semantic-search", lexicalOnly ? "indexing…" : "embedding…");
			try {
				const index = lexicalOnly
					? buildSearchIndex(ctx.cwd, { writeToDisk: true })
					: await buildSearchIndexWithEmbeddings(ctx.cwd, {
							writeToDisk: true,
							ollama: { model },
							onProgress: (message) => ctx.ui.setStatus?.("semantic-search", message),
						});
				const status = getIndexStatus(ctx.cwd, index);
				ctx.ui.notify(`Indexed ${index.files.length} files / ${index.chunks.length} chunks / ${index.cards.length} semantic cards${index.embedding ? ` with ${index.embedding.model}` : ""}`, "info");
				pi.sendMessage?.({ customType: "semantic-search", content: formatStatus(status, true), display: true, details: status });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Indexing failed: ${message}`, "error");
				pi.sendMessage?.({ customType: "semantic-search", content: `Indexing failed: ${message}`, display: true, details: { error: true, message } });
			} finally {
				ctx.ui.setStatus?.("semantic-search", undefined);
			}
		},
	});

	pi.registerCommand("code-search", {
		description: "Search the project index with natural language. Usage: /code-search <query>",
		handler: async (args, ctx) => {
			const query = args.trim();
			if (!query) {
				ctx.ui.notify("Usage: /code-search <query>", "error");
				return;
			}
			let index: SearchIndex;
			let results: SearchResult[];
			let warning: string | undefined;
			try {
				const ensured = await ensureIndexWithEmbeddings(ctx.cwd, true, undefined, undefined, (message) => ctx.ui.setStatus?.("semantic-search", message));
				index = ensured.index;
				({ results } = await searchIndexWithEmbeddings(index, { query, topK: DEFAULT_TOP_K }));
			} catch (error) {
				warning = `Ollama embeddings unavailable; fell back to lexical index (${error instanceof Error ? error.message : String(error)}).`;
				({ index } = ensureIndex(ctx.cwd, true));
				results = searchIndex(index, { query, topK: DEFAULT_TOP_K });
			} finally {
				ctx.ui.setStatus?.("semantic-search", undefined);
			}
			pi.sendMessage?.({
				customType: "semantic-search",
				content: `${warning ? `${warning}\n\n` : ""}${formatSearchResults(query, results, index)}`,
				display: true,
				details: { query, warning, results: compactResultDetails(results) },
			});
		},
	});

	pi.registerTool({
		name: "semantic_search",
		label: "Semantic Search",
		description:
			"Search the current project with a hybrid local index: Ollama embeddings, lexical terms, code concepts, symbols, and paths. " +
			"Returns ranked files/snippets with line ranges. Builds or refreshes the index automatically by default.",
		promptSnippet: "Search project code semantically and return ranked file snippets with line ranges",
		promptGuidelines: [
			"Use semantic_search when you do not know which files contain a feature, concept, workflow, or behavior before falling back to read/grep.",
			"After semantic_search returns candidates, use read on the reported path and line range before editing.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Natural-language query, feature name, behavior, symbol, or error concept to find." }),
			topK: Type.Optional(Type.Number({ description: `Maximum results to return (default ${DEFAULT_TOP_K}, max ${MAX_TOP_K}).`, minimum: 1, maximum: MAX_TOP_K })),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Optional path prefixes/substrings to constrain search, e.g. ['extensions/handoff', 'docs/']." })),
			includeTests: Type.Optional(Type.Boolean({ description: "Whether test files may appear in results. Defaults to true." })),
			refresh: Type.Optional(Type.Boolean({ description: "Refresh a missing/stale index before searching. Defaults to true." })),
			useEmbeddings: Type.Optional(Type.Boolean({ description: "Use local Ollama embeddings when available. Defaults to true; set false for lexical-only search." })),
			embeddingModel: Type.Optional(Type.String({ description: `Ollama embedding model to use. Defaults to ${DEFAULT_OLLAMA_EMBED_MODEL} or OLLAMA_EMBED_MODEL.` })),
			embeddingMaxChars: Type.Optional(Type.Number({ description: `Maximum characters sent to Ollama per embedding input before adaptive retries (default ${DEFAULT_OLLAMA_EMBED_INPUT_MAX_CHARS}).`, minimum: MIN_OLLAMA_EMBED_INPUT_CHARS, maximum: MAX_OLLAMA_EMBED_INPUT_MAX_CHARS })),
			ollamaUrl: Type.Optional(Type.String({ description: `Ollama base URL. Defaults to OLLAMA_BASE_URL/OLLAMA_HOST or ${DEFAULT_OLLAMA_BASE_URL}.` })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: `Searching index for: ${params.query}` }], details: {} });
			let index: SearchIndex;
			let status: IndexStatus;
			let rebuilt = false;
			let results: SearchResult[];
			let embeddingUsed = false;
			let warning: string | undefined;
			const ollama = { model: params.embeddingModel, baseUrl: params.ollamaUrl, maxInputChars: params.embeddingMaxChars };

			if (params.useEmbeddings === false) {
				({ index, status, rebuilt } = ensureIndex(ctx.cwd, params.refresh ?? true));
				results = searchIndex(index, {
					query: params.query,
					topK: params.topK,
					paths: params.paths,
					includeTests: params.includeTests,
				});
			} else {
				try {
					const ensured = await ensureIndexWithEmbeddings(ctx.cwd, params.refresh ?? true, ollama, signal, (message) => onUpdate?.({ content: [{ type: "text", text: message }], details: {} }));
					index = ensured.index;
					status = ensured.status;
					rebuilt = ensured.rebuilt;
					const searched = await searchIndexWithEmbeddings(index, {
						query: params.query,
						topK: params.topK,
						paths: params.paths,
						includeTests: params.includeTests,
						ollama,
						signal,
					});
					results = searched.results;
					embeddingUsed = searched.embeddingUsed;
				} catch (error) {
					warning = `Ollama embeddings unavailable; fell back to lexical index (${error instanceof Error ? error.message : String(error)}).`;
					({ index, status, rebuilt } = ensureIndex(ctx.cwd, params.refresh ?? true));
					results = searchIndex(index, {
						query: params.query,
						topK: params.topK,
						paths: params.paths,
						includeTests: params.includeTests,
					});
				}
			}

			let text = `${warning ? `${warning}\n\n` : ""}${formatSearchResults(params.query, results, index)}`;
			if (status.stale) text += `\n\nNote: index may be stale (${status.reason}). Run /index rebuild or call semantic_search with refresh=true.`;
			return {
				content: [{ type: "text" as const, text }],
				details: {
					query: params.query,
					rebuilt,
					embeddingUsed,
					warning,
					index: { files: index.files.length, chunks: index.chunks.length, cards: index.cards.length, updatedAt: index.updatedAt, stale: status.stale, reason: status.reason, embedding: index.embedding },
					results: compactResultDetails(results),
				},
			};
		},
	});

	pi.registerTool({
		name: "repo_map",
		label: "Repo Map",
		description: "Summarize the current project's indexed concept clusters and representative files. Builds or refreshes the semantic-search index by default.",
		promptSnippet: "Show indexed project clusters and representative files",
		promptGuidelines: [
			"Use repo_map when you need a quick overview of project areas before choosing where to inspect code.",
		],
		parameters: Type.Object({
			maxClusters: Type.Optional(Type.Number({ description: "Maximum concept clusters to show (default 8, max 20).", minimum: 1, maximum: 20 })),
			refresh: Type.Optional(Type.Boolean({ description: "Refresh a missing/stale index before building the repo map. Defaults to true." })),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Building repo map from semantic-search index" }], details: {} });
			const { index, status, rebuilt } = ensureIndex(ctx.cwd, params.refresh ?? true);
			const map = createRepoMap(index, { maxClusters: params.maxClusters });
			let text = formatRepoMap(map, index);
			if (status.stale) text += `\n\nNote: index may be stale (${status.reason}).`;
			return {
				content: [{ type: "text" as const, text }],
				details: { rebuilt, index: { files: index.files.length, chunks: index.chunks.length, cards: index.cards.length, stale: status.stale, reason: status.reason }, clusters: map.clusters },
			};
		},
	});

	pi.registerTool({
		name: "index_status",
		label: "Index Status",
		description: "Show whether the local semantic-search index exists, is fresh/stale, and where it is stored.",
		promptSnippet: "Check local semantic-search index freshness",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const status = getIndexStatus(ctx.cwd);
			return {
				content: [{ type: "text" as const, text: formatStatus(status) }],
				details: status,
			};
		},
	});
}
