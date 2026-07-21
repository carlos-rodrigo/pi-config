import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
	type Dirent,
} from "node:fs";
import {
	basename,
	dirname,
	extname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const INDEX_VERSION = 5;
const INDEX_DIR = ".pi/semantic-search";
const INDEX_FILE = "index.json";
const SUMMARY_CACHE_FILE = "summaries.json";
const INDEX_REBUILD_LOG_FILE = "rebuild.log";
const INDEX_REBUILD_STATUS_FILE = "rebuild-status.json";
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
const DEFAULT_OLLAMA_SSH_TARGET = "";
const DEFAULT_OLLAMA_TUNNEL_HOST = "127.0.0.1";
const DEFAULT_OLLAMA_TUNNEL_PORT = 11434;
const DEFAULT_OLLAMA_EMBED_MODEL = "nomic-embed-text";
const DEFAULT_OLLAMA_SUMMARY_MODEL = "qwen2.5-coder:7b";
const DEFAULT_OLLAMA_BATCH_SIZE = 16;
const DEFAULT_OLLAMA_TIMEOUT_MS = 30_000;
const DEFAULT_OLLAMA_SUMMARY_TIMEOUT_MS = 180_000;
const DEFAULT_OLLAMA_EMBED_INPUT_MAX_CHARS = 6_000;
const DEFAULT_OLLAMA_SUMMARY_INPUT_MAX_CHARS = 10_000;
const DEFAULT_OLLAMA_SUMMARY_CONCURRENCY = 2;
const MIN_OLLAMA_EMBED_INPUT_CHARS = 128;
const MAX_OLLAMA_EMBED_INPUT_MAX_CHARS = 100_000;
const MIN_OLLAMA_SUMMARY_INPUT_CHARS = 512;
const MAX_OLLAMA_SUMMARY_INPUT_CHARS = 100_000;
const EMBEDDING_TRUNCATION_MARKER = "\n\n[...semantic-search input truncated...]\n\n";
const EMBEDDING_VECTOR_JSON_ENCODING = "base64-f32";

export type SemanticSearchConfig = {
	excludePaths?: string[];
	ollama?: {
		baseUrl?: string;
		embeddingModel?: string;
		summaryModel?: string;
		embeddingMaxChars?: number;
		summaryMaxChars?: number;
		summaryConcurrency?: number;
		summaries?: boolean;
	};
	tunnel?: {
		sshTarget?: string;
		localHost?: string;
		localPort?: number;
		remoteHost?: string;
		remotePort?: number;
	};
};

const EXTENSION_CONFIG_URL = new URL("./config.json", import.meta.url);
let cachedSemanticSearchConfig: { key: string; value: SemanticSearchConfig } | undefined;

function stringConfigValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readSemanticSearchConfig(env: Record<string, string | undefined> = process.env): SemanticSearchConfig {
	const configuredPath = env.PI_SEMANTIC_SEARCH_CONFIG?.trim();
	const key = configuredPath || EXTENSION_CONFIG_URL.href;
	if (cachedSemanticSearchConfig?.key === key) return cachedSemanticSearchConfig.value;
	try {
		const raw = configuredPath ? readFileSync(resolve(configuredPath), "utf8") : readFileSync(EXTENSION_CONFIG_URL, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		const value = parsed && typeof parsed === "object" ? parsed as SemanticSearchConfig : {};
		cachedSemanticSearchConfig = { key, value };
		return value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn?.(`semantic-search: failed to read config ${key}: ${error instanceof Error ? error.message : String(error)}`);
		}
		cachedSemanticSearchConfig = { key, value: {} };
		return {};
	}
}

function configuredDefaultEmbeddingModel(config: SemanticSearchConfig = readSemanticSearchConfig()): string {
	return stringConfigValue(config.ollama?.embeddingModel) ?? DEFAULT_OLLAMA_EMBED_MODEL;
}

function configuredDefaultSummaryModel(config: SemanticSearchConfig = readSemanticSearchConfig()): string {
	return stringConfigValue(config.ollama?.summaryModel) ?? DEFAULT_OLLAMA_SUMMARY_MODEL;
}

function configuredDefaultSshTarget(config: SemanticSearchConfig = readSemanticSearchConfig()): string {
	return stringConfigValue(config.tunnel?.sshTarget) ?? DEFAULT_OLLAMA_SSH_TARGET;
}

function tunnelCommandHint(config: SemanticSearchConfig = readSemanticSearchConfig()): string {
	const target = configuredDefaultSshTarget(config);
	return target ? `/ollama-tunnel  # defaults to ${target}` : "/ollama-tunnel user@remote-host";
}

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

export type OllamaSummaryConfig = {
	model: string;
	baseUrl: string;
	timeoutMs: number;
	maxInputChars: number;
	concurrency: number;
	enabled: boolean;
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

export type SummaryMetadata = {
	provider: "ollama";
	model: string;
	baseUrl: string;
	inputMaxChars: number;
	summarizedCards: number;
	cachedCards: number;
	failedCards: number;
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
	summary?: SummaryMetadata;
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
	summary?: false | Partial<OllamaSummaryConfig>;
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
	summary?: SummaryMetadata;
};

type RebuildProgressPhase = "starting" | "indexing" | "summarizing" | "embedding" | "finished" | "unknown";

export type RebuildProgress = {
	phase: RebuildProgressPhase;
	message: string;
	current?: number;
	total?: number;
	percent?: number;
	phaseStartedAt?: string;
	updatedAt: string;
	elapsedMs?: number;
	estimatedRemainingMs?: number;
};

type BackgroundRebuildStatus = {
	status: "running" | "succeeded" | "failed" | "unknown";
	cwd: string;
	logPath: string;
	pid?: number;
	startedAt?: string;
	finishedAt?: string;
	embeddingModel?: string;
	summaryModel?: string;
	summariesDisabled?: boolean;
	progress?: RebuildProgress;
	message?: string;
	error?: string;
	notified?: boolean;
};

const memoryIndexes = new Map<string, SearchIndex>();
const watchedBackgroundRebuilds = new Map<string, NodeJS.Timeout>();
const terminalIndicatorTimers = new Map<string, NodeJS.Timeout>();
const TERMINAL_REBUILD_INDICATOR_MS = 15_000;

function normalizeRelativePath(path: string): string {
	return path.split(sep).join("/").replace(/^\.\//, "");
}

function getIndexPath(cwd: string): string {
	return join(cwd, INDEX_DIR, INDEX_FILE);
}

function getSummaryCachePath(cwd: string): string {
	return join(cwd, INDEX_DIR, SUMMARY_CACHE_FILE);
}

function getIndexRebuildLogPath(cwd: string): string {
	return join(cwd, INDEX_DIR, INDEX_REBUILD_LOG_FILE);
}

function getIndexRebuildStatusPath(cwd: string): string {
	return join(cwd, INDEX_DIR, INDEX_REBUILD_STATUS_FILE);
}

type LinkedWorktree = {
	currentRoot: string;
	primaryRoot: string;
};

export function getLinkedWorktree(cwd: string): LinkedWorktree | undefined {
	try {
		const currentRoot = resolve(execFileSync("git", ["-C", resolve(cwd), "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
		const output = execFileSync("git", ["-C", currentRoot, "worktree", "list", "--porcelain", "-z"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		const primaryEntry = output.split("\0").find((entry) => entry.startsWith("worktree "));
		if (!primaryEntry) return undefined;
		const primaryRoot = resolve(primaryEntry.slice("worktree ".length));
		return primaryRoot === currentRoot ? undefined : { currentRoot, primaryRoot };
	} catch {
		return undefined;
	}
}

export function reusePrimaryWorktreeIndex(cwd: string): { primaryRoot: string; copied: string[] } | undefined {
	const linked = getLinkedWorktree(cwd);
	if (!linked) return undefined;
	const targetIndexPath = getIndexPath(linked.currentRoot);
	const sourceIndexPath = getIndexPath(linked.primaryRoot);
	if (existsSync(targetIndexPath) || !existsSync(sourceIndexPath)) return { primaryRoot: linked.primaryRoot, copied: [] };

	mkdirSync(dirname(targetIndexPath), { recursive: true });
	copyFileSync(sourceIndexPath, targetIndexPath);
	const copied = [INDEX_FILE];
	const sourceSummaryPath = getSummaryCachePath(linked.primaryRoot);
	const targetSummaryPath = getSummaryCachePath(linked.currentRoot);
	if (existsSync(sourceSummaryPath) && !existsSync(targetSummaryPath)) {
		copyFileSync(sourceSummaryPath, targetSummaryPath);
		copied.push(SUMMARY_CACHE_FILE);
	}
	return { primaryRoot: linked.primaryRoot, copied };
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

function escapeRegExp(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
	const normalized = normalizeRelativePath(pattern.trim());
	let source = "";
	for (let index = 0; index < normalized.length; index++) {
		const char = normalized[index];
		if (char === "*") {
			if (normalized[index + 1] === "*") {
				const slashAfterGlobstar = normalized[index + 2] === "/";
				source += slashAfterGlobstar ? "(?:.*/)?" : ".*";
				index += slashAfterGlobstar ? 2 : 1;
			} else {
				source += "[^/]*";
			}
			continue;
		}
		if (char === "?") {
			source += "[^/]";
			continue;
		}
		source += escapeRegExp(char);
	}
	return new RegExp(`^${source}$`);
}

function configExcludePatterns(config: SemanticSearchConfig): RegExp[] {
	return (Array.isArray(config.excludePaths) ? config.excludePaths : [])
		.filter((pattern): pattern is string => typeof pattern === "string" && pattern.trim().length > 0)
		.map(globToRegExp);
}

function shouldSkipPath(relativePath: string, excludePatterns: readonly RegExp[] = []): boolean {
	const normalized = normalizeRelativePath(relativePath);
	const parts = normalized.split("/");
	const fileName = basename(normalized);
	if (parts.some((part) => SKIP_DIRS.has(part))) return true;
	if (/^\.env(?:\.|$)/i.test(fileName) || fileName === ".envrc") return true;
	if (fileName.startsWith(".DS_Store")) return true;
	if (SKIP_EXTENSIONS.has(extname(normalized).toLowerCase())) return true;
	if (excludePatterns.some((pattern) => pattern.test(normalized))) return true;
	return false;
}

function discoverProjectFiles(cwd: string, config: SemanticSearchConfig = readSemanticSearchConfig()): string[] {
	const files = new Set<string>();
	const excludePatterns = configExcludePatterns(config);
	try {
		const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		for (const raw of output.split("\0")) {
			const file = normalizeRelativePath(raw.trim());
			if (file && !shouldSkipPath(file, excludePatterns)) files.add(file);
		}
	} catch {
		// Not a git checkout or git unavailable. Fall back to a conservative recursive walk.
	}

	if (files.size === 0) {
		for (const file of walkFiles(cwd, "", excludePatterns)) files.add(file);
	}

	return [...files].sort((a, b) => a.localeCompare(b));
}

function walkFiles(cwd: string, current = "", excludePatterns: readonly RegExp[] = []): string[] {
	const directory = current ? join(cwd, current) : cwd;
	const out: string[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch {
		return out;
	}

	for (const entry of entries) {
		const relativePath = normalizeRelativePath(current ? join(current, entry.name) : entry.name);
		if (shouldSkipPath(relativePath, excludePatterns)) continue;
		if (entry.isDirectory()) {
			out.push(...walkFiles(cwd, relativePath, excludePatterns));
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
	const stemAliases: Record<string, string> = { creat: "create", defin: "define", handl: "handle", sav: "save" };
	normalized = stemAliases[normalized] ?? normalized;
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
	config: SemanticSearchConfig = readSemanticSearchConfig(env),
): OllamaEmbeddingConfig {
	return {
		model: input.model ?? env.PI_SEMANTIC_SEARCH_EMBED_MODEL ?? env.OLLAMA_EMBED_MODEL ?? stringConfigValue(config.ollama?.embeddingModel) ?? DEFAULT_OLLAMA_EMBED_MODEL,
		baseUrl: normalizeOllamaBaseUrl(input.baseUrl ?? env.OLLAMA_BASE_URL ?? env.OLLAMA_HOST ?? stringConfigValue(config.ollama?.baseUrl) ?? DEFAULT_OLLAMA_BASE_URL),
		batchSize: clampInteger(input.batchSize, DEFAULT_OLLAMA_BATCH_SIZE, 1, 64),
		timeoutMs: clampInteger(input.timeoutMs, DEFAULT_OLLAMA_TIMEOUT_MS, 1_000, 300_000),
		maxInputChars: clampInteger(input.maxInputChars ?? env.PI_SEMANTIC_SEARCH_EMBED_MAX_CHARS ?? config.ollama?.embeddingMaxChars, DEFAULT_OLLAMA_EMBED_INPUT_MAX_CHARS, MIN_OLLAMA_EMBED_INPUT_CHARS, MAX_OLLAMA_EMBED_INPUT_MAX_CHARS),
	};
}

function envFlagEnabled(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	return !/^(0|false|no|off)$/i.test(value.trim());
}

export function resolveOllamaSummaryConfig(
	input: Partial<OllamaSummaryConfig> = {},
	env: Record<string, string | undefined> = process.env,
	config: SemanticSearchConfig = readSemanticSearchConfig(env),
): OllamaSummaryConfig {
	const configSummaries = typeof config.ollama?.summaries === "boolean" ? config.ollama.summaries : true;
	return {
		model: input.model ?? env.PI_SEMANTIC_SEARCH_SUMMARY_MODEL ?? stringConfigValue(config.ollama?.summaryModel) ?? DEFAULT_OLLAMA_SUMMARY_MODEL,
		baseUrl: normalizeOllamaBaseUrl(input.baseUrl ?? env.OLLAMA_BASE_URL ?? env.OLLAMA_HOST ?? stringConfigValue(config.ollama?.baseUrl) ?? DEFAULT_OLLAMA_BASE_URL),
		timeoutMs: clampInteger(input.timeoutMs ?? env.PI_SEMANTIC_SEARCH_SUMMARY_TIMEOUT_MS, DEFAULT_OLLAMA_SUMMARY_TIMEOUT_MS, 1_000, 600_000),
		maxInputChars: clampInteger(input.maxInputChars ?? env.PI_SEMANTIC_SEARCH_SUMMARY_MAX_CHARS ?? config.ollama?.summaryMaxChars, DEFAULT_OLLAMA_SUMMARY_INPUT_MAX_CHARS, MIN_OLLAMA_SUMMARY_INPUT_CHARS, MAX_OLLAMA_SUMMARY_INPUT_CHARS),
		concurrency: clampInteger(input.concurrency ?? env.PI_SEMANTIC_SEARCH_SUMMARY_CONCURRENCY ?? config.ollama?.summaryConcurrency, DEFAULT_OLLAMA_SUMMARY_CONCURRENCY, 1, 8),
		enabled: input.enabled ?? (env.PI_SEMANTIC_SEARCH_SUMMARIES === undefined ? configSummaries : envFlagEnabled(env.PI_SEMANTIC_SEARCH_SUMMARIES, true)),
	};
}

async function fetchJsonWithTimeout(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
	const controller = new AbortController();
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const abort = () => controller.abort();
	if (signal?.aborted) controller.abort();
	else signal?.addEventListener("abort", abort, { once: true });
	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(`Ollama ${url} failed with ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 300)}` : ""}`);
		}
		return await response.json();
	} catch (error) {
		if (signal?.aborted) {
			const aborted = new Error("Ollama request cancelled.");
			aborted.name = "AbortError";
			throw aborted;
		}
		if (timedOut || (error instanceof Error && error.name === "AbortError")) {
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

async function embedTextsWithOllama(texts: string[], config: OllamaEmbeddingConfig, signal?: AbortSignal, onProgress?: (message: string) => void, label = "inputs"): Promise<number[][]> {
	const embeddings: number[][] = [];
	for (let start = 0; start < texts.length; start += config.batchSize) {
		const batch = texts.slice(start, start + config.batchSize);
		embeddings.push(...await embedBatchWithOllama(batch, config, signal));
		onProgress?.(`Embedded ${Math.min(start + batch.length, texts.length)}/${texts.length} ${label} with ${config.model}`);
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

type SummaryCacheEntry = {
	model: string;
	inputHash: string;
	summary: string;
	updatedAt: string;
};

type SummaryCache = {
	version: number;
	entries: Record<string, SummaryCacheEntry>;
};

const SUMMARY_CACHE_VERSION = 1;
const SUMMARY_PROMPT_VERSION = 1;

function loadSummaryCache(cwd: string): SummaryCache {
	const cachePath = getSummaryCachePath(cwd);
	if (!existsSync(cachePath)) return { version: SUMMARY_CACHE_VERSION, entries: {} };
	try {
		const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as Partial<SummaryCache>;
		if (parsed.version !== SUMMARY_CACHE_VERSION || !parsed.entries || typeof parsed.entries !== "object") return { version: SUMMARY_CACHE_VERSION, entries: {} };
		return { version: SUMMARY_CACHE_VERSION, entries: parsed.entries };
	} catch {
		return { version: SUMMARY_CACHE_VERSION, entries: {} };
	}
}

function saveSummaryCache(cwd: string, cache: SummaryCache): void {
	const cachePath = getSummaryCachePath(cwd);
	mkdirSync(dirname(cachePath), { recursive: true });
	writeFileSync(cachePath, JSON.stringify(cache), "utf8");
}

function summaryInputForCard(card: IndexedCard, config: OllamaSummaryConfig): string {
	return truncateEmbeddingInput(card.text, config.maxInputChars);
}

function summaryCacheKey(config: OllamaSummaryConfig, input: string): { key: string; inputHash: string } {
	const inputHash = hashBuffer(Buffer.from(input, "utf8"));
	return { key: `${SUMMARY_CACHE_VERSION}:${SUMMARY_PROMPT_VERSION}:${config.model}:${inputHash}`, inputHash };
}

function cleanGeneratedSummary(value: string): string {
	const cleaned = value
		.replace(/<think>[\s\S]*?<\/think>/gi, "")
		.replace(/^\s*(?:summary|answer)\s*:\s*/i, "")
		.replace(/^[-*]\s+/, "")
		.replace(/["'`]+$/g, "")
		.replace(/^["'`]+/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > 500 ? `${cleaned.slice(0, 499)}…` : cleaned;
}

function summaryPromptForCard(card: IndexedCard, input: string): string {
	return [
		"You summarize code for semantic code-search results.",
		"Return exactly one concise factual sentence, max 45 words, plain text only.",
		"Explain what this file/class/function/method does and why it would answer a developer's where/how question.",
		"Prefer concrete behavior, domain entities, route/action names, important calls, and create/update/delete/read responsibilities.",
		"Do not mention that you are summarizing. Do not use markdown.",
		"",
		`Card: ${card.kind} ${card.name}`,
		`Path: ${card.path}:${card.startLine}-${card.endLine}`,
		input,
	].join("\n");
}

async function fetchOllamaSummary(card: IndexedCard, input: string, config: OllamaSummaryConfig, signal?: AbortSignal): Promise<string> {
	const payload = await fetchJsonWithTimeout(
		`${config.baseUrl}/api/generate`,
		{
			method: "POST",
			headers: { "content-type": "application/json", "user-agent": "pi-config-semantic-search/0.1" },
			body: JSON.stringify({
				model: config.model,
				prompt: summaryPromptForCard(card, input),
				stream: false,
				options: { temperature: 0, num_predict: 120 },
			}),
		},
		config.timeoutMs,
		signal,
	);
	const response = (payload as { response?: unknown }).response;
	if (typeof response !== "string" || !response.trim()) throw new Error("Ollama returned an empty summary response.");
	return cleanGeneratedSummary(response);
}

function cardWithGeneratedSummary(card: IndexedCard, summary: string): IndexedCard {
	const text = card.text.includes("Summary:")
		? card.text.replace(/^Summary:.*$/m, `Summary: ${summary}`)
		: `${card.text}\nSummary: ${summary}`;
	return {
		...card,
		summary,
		text,
		vector: makeVector([
			{ text, weight: 1.8 },
			{ text: summary, weight: 3.2 },
			{ text: card.path, weight: 2.8 },
			{ text: card.symbols.join(" "), weight: 3.6 },
		]),
	};
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const workerCount = Math.min(Math.max(1, concurrency), items.length);
	await Promise.all(Array.from({ length: workerCount }, async () => {
		while (nextIndex < items.length) {
			const currentIndex = nextIndex++;
			results[currentIndex] = await mapper(items[currentIndex]!, currentIndex);
		}
	}));
	return results;
}

async function applyOllamaCardSummaries(
	index: SearchIndex,
	config: OllamaSummaryConfig,
	options: { writeCache: boolean; signal?: AbortSignal; onProgress?: (message: string) => void },
): Promise<SummaryMetadata> {
	const cache = options.writeCache ? loadSummaryCache(index.cwd) : { version: SUMMARY_CACHE_VERSION, entries: {} };
	const pending: Array<{ cardIndex: number; card: IndexedCard; input: string; key: string; inputHash: string }> = [];
	let cachedCards = 0;

	index.cards = index.cards.map((card, cardIndex) => {
		const input = summaryInputForCard(card, config);
		const { key, inputHash } = summaryCacheKey(config, input);
		const cached = cache.entries[key];
		if (cached?.summary && cached.inputHash === inputHash && cached.model === config.model) {
			cachedCards++;
			return cardWithGeneratedSummary(card, cached.summary);
		}
		pending.push({ cardIndex, card, input, key, inputHash });
		return card;
	});

	if (pending.length > 0) {
		options.onProgress?.(`Summarizing ${pending.length} semantic cards with Ollama model ${config.model} (${config.concurrency} parallel)`);
		const generated = await mapWithConcurrency(pending, config.concurrency, async (item, offset) => {
			if (offset > 0 && offset % 25 === 0) options.onProgress?.(`Summarized ${offset}/${pending.length} semantic cards with ${config.model}`);
			const summary = await fetchOllamaSummary(item.card, item.input, config, options.signal);
			return { ...item, summary };
		});
		for (const item of generated) {
			index.cards[item.cardIndex] = cardWithGeneratedSummary(index.cards[item.cardIndex]!, item.summary);
			cache.entries[item.key] = { model: config.model, inputHash: item.inputHash, summary: item.summary, updatedAt: new Date().toISOString() };
		}
		if (options.writeCache) saveSummaryCache(index.cwd, cache);
	}

	return {
		provider: "ollama",
		model: config.model,
		baseUrl: config.baseUrl,
		inputMaxChars: config.maxInputChars,
		summarizedCards: pending.length,
		cachedCards,
		failedCards: 0,
		createdAt: new Date().toISOString(),
	};
}

function assertRequiredSummariesEnabled(config: OllamaSummaryConfig): void {
	if (config.enabled) return;
	throw new Error("Ollama semantic-card summaries are required for default semantic search; remove PI_SEMANTIC_SEARCH_SUMMARIES=false or use an explicit lexical/debug mode.");
}

function hasOllamaSummaries(index: SearchIndex, config?: OllamaSummaryConfig): boolean {
	if (index.cards.length === 0) return true;
	if (!index.summary || index.summary.provider !== "ollama") return false;
	if (config && (index.summary.model !== config.model || index.summary.baseUrl !== config.baseUrl || index.summary.inputMaxChars !== config.maxInputChars)) return false;
	return index.summary.failedCards === 0 && index.summary.summarizedCards + index.summary.cachedCards >= index.cards.length;
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
	const summaryConfig = options.summary === false ? undefined : resolveOllamaSummaryConfig(options.summary);
	if (summaryConfig) assertRequiredSummariesEnabled(summaryConfig);
	const index = buildSearchIndex(cwd, { ...options, writeToDisk: false });
	// Persist the lexical/symbol index before slower Ollama work so `/index rebuild`
	// still leaves a usable local index if summary or embedding generation fails.
	if (options.writeToDisk ?? true) saveSearchIndex(index);
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

	if (summaryConfig && index.cards.length > 0) {
		index.summary = await applyOllamaCardSummaries(index, summaryConfig, {
			writeCache: options.writeToDisk ?? true,
			signal: options.signal,
			onProgress: options.onProgress,
		});
		options.onProgress?.(`Semantic-card summaries ready: ${index.summary.summarizedCards} generated, ${index.summary.cachedCards} cached with ${summaryConfig.model}`);
	}

	options.onProgress?.(`Embedding ${index.chunks.length} chunks and ${index.cards.length} semantic cards with Ollama model ${config.model} (max ${config.maxInputChars} chars/input)`);
	const chunkEmbeddings = await embedTextsWithOllama(index.chunks.map(embeddingInputForChunk), config, options.signal, options.onProgress, "chunks");
	const cardEmbeddings = index.cards.length > 0 ? await embedTextsWithOllama(index.cards.map(embeddingInputForCard), config, options.signal, options.onProgress, "semantic cards") : [];
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
		if (parsed.version !== INDEX_VERSION) return undefined;

		// Index contents use project-relative paths, so a copy can be reused by a
		// sibling Git worktree. Freshness validation below still rejects drift.
		parsed.cwd = absoluteCwd;
		memoryIndexes.set(absoluteCwd, parsed);
		return parsed;
	} catch {
		return undefined;
	}
}

function currentIndexableFileStats(cwd: string, maxFileBytes: number): Array<{ path: string; hash: string; size: number }> {
	const files: Array<{ path: string; hash: string; size: number }> = [];
	for (const path of discoverProjectFiles(cwd)) {
		try {
			const stat = statSync(join(cwd, path));
			if (!stat.isFile() || stat.size > maxFileBytes) continue;
			const buffer = readFileSync(join(cwd, path));
			if (isLikelyBinary(buffer)) continue;
			if (!buffer.toString("utf8").trim()) continue;
			files.push({ path, hash: hashBuffer(buffer), size: stat.size });
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
		summary: index.summary,
	};

	if (index.version !== INDEX_VERSION) {
		return { ...baseStatus, stale: true, reason: "index version changed" };
	}

	const byPath = new Map(index.files.map((file) => [file.path, file]));
	const current = currentIndexableFileStats(absoluteCwd, index.options.maxFileBytes);

	for (const file of current) {
		const indexed = byPath.get(file.path);
		if (!indexed) return { ...baseStatus, stale: true, reason: `new file: ${file.path}` };
		if (indexed.size !== file.size || indexed.hash !== file.hash) {
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
	summary?: false | Partial<OllamaSummaryConfig>,
): Promise<{ index: SearchIndex; status: IndexStatus; rebuilt: boolean; config: OllamaEmbeddingConfig }> {
	const absoluteCwd = resolve(cwd);
	const config = resolveOllamaEmbeddingConfig(ollama);
	const summaryConfig = summary === false ? undefined : resolveOllamaSummaryConfig(summary);
	if (summaryConfig) assertRequiredSummariesEnabled(summaryConfig);
	let index = loadSearchIndex(absoluteCwd);
	let status = getIndexStatus(absoluteCwd, index);
	let rebuilt = false;
	if (!index || (refresh && status.stale) || !hasOllamaEmbeddings(index, config) || (summaryConfig && !hasOllamaSummaries(index, summaryConfig))) {
		index = await buildSearchIndexWithEmbeddings(absoluteCwd, { writeToDisk: true, ollama: config, summary, signal, onProgress });
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

type QueryIntent = {
	implementation: boolean;
	creation: boolean;
	explicitDocs: boolean;
	explicitTests: boolean;
};

const IMPLEMENTATION_QUERY_TERMS = new Set(["where", "how", "implemented", "implementation", "defined", "declared", "handled", "created", "create", "creates", "built", "called", "used"]);
const CREATION_QUERY_TERMS = new Set(["created", "create", "creates", "creation", "new", "insert", "save", "saved", "post", "route", "mutation"]);
const DOC_QUERY_TERMS = new Set(["doc", "docs", "document", "documentation", "readme", "prd", "design"]);
const TEST_QUERY_TERMS = new Set(["test", "tests", "spec", "coverage", "fixture"]);
const CREATION_SYMBOL_TERMS = ["create", "created", "creating", "insert", "save", "new", "post", "put", "mutation", "add"];

function inferQueryIntent(query: string): QueryIntent {
	const rawTerms = new Set(splitSearchText(query).map((term) => term.toLowerCase()));
	const explicitDocs = [...rawTerms].some((term) => DOC_QUERY_TERMS.has(term));
	const explicitTests = [...rawTerms].some((term) => TEST_QUERY_TERMS.has(term));
	return {
		implementation: [...rawTerms].some((term) => IMPLEMENTATION_QUERY_TERMS.has(term)) && !explicitDocs && !explicitTests,
		creation: [...rawTerms].some((term) => CREATION_QUERY_TERMS.has(term)),
		explicitDocs,
		explicitTests,
	};
}

function isDocPath(path: string): boolean {
	return /(^|\/)(docs?|adr|rfcs?)(\/|$)/i.test(path) || /(^|\/)(readme|design|prd|architecture)\.mdx?$/i.test(path) || /\.mdx?$/i.test(path);
}

function scoreIntentFit(intent: QueryIntent, item: SearchableVectorItem, source: "chunk" | "card"): number {
	if (!intent.implementation) return 1;
	let multiplier = 1;
	if (isDocPath(item.path) && !intent.explicitDocs) multiplier *= 0.72;
	if (isTestPath(item.path) && !intent.explicitTests) multiplier *= 0.76;
	if (source === "card" && (item.kind === "function" || item.kind === "method" || item.kind === "class" || item.kind === "module")) multiplier *= 1.08;
	if (intent.creation) {
		const targetText = `${item.path} ${item.symbols.join(" ")} ${item.name ?? ""} ${item.summary ?? ""}`.toLowerCase();
		if (CREATION_SYMBOL_TERMS.some((term) => targetText.includes(term))) multiplier *= 1.14;
	}
	return multiplier;
}

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
	const queryIntent = inferQueryIntent(options.query);
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
		const intentFit = scoreIntentFit(queryIntent, item, source);
		const score = (source === "card" ? rawScore * 1.05 : rawScore) * intentFit;
		if (score < minScore) return;

		const reason = buildReason(queryTerms, queryConcepts, item, vectorTerms);
		if (intentFit > 1.001) reason.push("implementation/creation intent match");
		else if (intentFit < 0.999) reason.push("lower-ranked because query asks for implementation location");
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
	if (options.signal?.aborted) {
		const error = new Error("Semantic search cancelled.");
		error.name = "AbortError";
		throw error;
	}
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
			const sourceLabel = result.source === "card" ? ` [${result.cardKind ?? "card"}${result.cardName ? ` ${result.cardName}` : ""}]` : "";
			const why = result.cardSummary || result.reason.join("; ");
			const lines = [
				`${index + 1}. ${result.path}:${result.startLine}-${result.endLine}${sourceLabel}`,
				`   Score: ${result.score.toFixed(3)}`,
				`   Why: ${why}`,
			];
			if (result.cardSummary && result.reason.length > 0) lines.push(`   Matched because: ${result.reason.join("; ")}`);
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
		`Summaries: ${status.summary ? `ollama/${status.summary.model} (${status.summary.summarizedCards} generated, ${status.summary.cachedCards} cached, ${status.summary.failedCards} failed)` : "missing (required for default semantic search)"}`,
		`Embeddings: ${status.embedding ? `ollama/${status.embedding.model} (${status.embedding.dimensions} dims, ${status.embedding.embeddedChunks} chunks, ${status.embedding.embeddedCards} cards, max ${status.embedding.inputMaxChars ?? "unknown"} chars/input)` : "missing (required for default semantic search)"}`,
		`Updated: ${status.updatedAt ?? "never"}`,
		`Reason: ${status.reason}`,
	].join("\n");
}

function uniqueOllamaPullCommands(...models: Array<string | undefined>): string[] {
	return unique(models.filter((model): model is string => Boolean(model?.trim())).map((model) => `ollama pull ${model}`));
}

function formatOllamaRequirementFailure(
	error: unknown,
	options: { embeddingModel?: string; summaryModel?: string; ollamaUrl?: string; embeddingMaxChars?: number } = {},
): string {
	const embeddingConfig = resolveOllamaEmbeddingConfig({
		model: options.embeddingModel,
		baseUrl: options.ollamaUrl,
		maxInputChars: options.embeddingMaxChars,
	});
	const summaryConfig = resolveOllamaSummaryConfig({ model: options.summaryModel, baseUrl: options.ollamaUrl });
	const cause = error instanceof Error ? error.message : String(error);
	const setupCommands = uniqueOllamaPullCommands(embeddingConfig.model, summaryConfig.model);
	return [
		"Semantic search requires local Ollama summaries and embeddings; it no longer falls back to lexical search by default.",
		`Ollama URL: ${embeddingConfig.baseUrl}`,
		`Required embedding model: ${embeddingConfig.model}`,
		`Required summary model: ${summaryConfig.model}`,
		"",
		"Setup:",
		"  Start Ollama locally if it is not already running (for example: ollama serve)",
		...setupCommands.map((command) => `  ${command}`),
		"  /index rebuild",
		"",
		"Remote machine option over SSH tunnel:",
		`  ${tunnelCommandHint()}`,
		"  /index rebuild",
		"",
		"Explicit lower-quality escape hatches remain available for diagnostics: /index lexical, /index rebuild --no-summaries, or semantic_search with useEmbeddings=false/useSummaries=false.",
		`Error: ${cause}`,
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

function isProcessRunning(pid: number | undefined): boolean {
	if (!pid || !Number.isFinite(pid)) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function parseProgressCount(message: string): { current?: number; total?: number } {
	const fraction = message.match(/\b(\d+)\/(\d+)\b/);
	if (fraction) return { current: Number(fraction[1]), total: Number(fraction[2]) };
	const summarizing = message.match(/Summarizing\s+(\d+)\s+semantic cards/i);
	if (summarizing) return { current: 0, total: Number(summarizing[1]) };
	const embedding = message.match(/Embedding\s+(\d+)\s+chunks\s+and\s+(\d+)\s+semantic cards/i);
	if (embedding) return { current: 0, total: Number(embedding[1]) + Number(embedding[2]) };
	return {};
}

export function parseRebuildProgressMessage(message: string): Pick<RebuildProgress, "phase" | "message" | "current" | "total"> {
	const lower = message.toLowerCase();
	const phase: RebuildProgressPhase = lower.includes("finished")
		? "finished"
		: lower.includes("start") || lower.includes("spawn")
			? "starting"
			: lower.includes("summariz")
				? "summarizing"
				: lower.includes("embed")
					? "embedding"
					: lower.includes("index") || lower.includes("lexical") || lower.includes("build")
						? "indexing"
						: "unknown";
	return { phase, message, ...parseProgressCount(message) };
}

export function buildRebuildProgressSnapshot(message: string, phaseStartedAtMs: number, nowMs = Date.now()): RebuildProgress {
	const parsed = parseRebuildProgressMessage(message);
	const current = parsed.current;
	const total = parsed.total;
	const hasProgress = typeof current === "number" && typeof total === "number" && total > 0;
	const elapsedMs = Math.max(0, nowMs - phaseStartedAtMs);
	const percent = hasProgress ? Math.min(100, Math.max(0, Math.round((current / total) * 100))) : parsed.phase === "finished" ? 100 : undefined;
	const estimatedRemainingMs = hasProgress && current > 0 && current < total
		? Math.round((elapsedMs / current) * (total - current))
		: undefined;
	return {
		phase: parsed.phase,
		message,
		current,
		total,
		percent,
		phaseStartedAt: new Date(phaseStartedAtMs).toISOString(),
		updatedAt: new Date(nowMs).toISOString(),
		elapsedMs,
		estimatedRemainingMs,
	};
}

function formatDurationMs(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "unknown";
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

function writeBackgroundRebuildStatus(status: BackgroundRebuildStatus): void {
	const statusPath = getIndexRebuildStatusPath(status.cwd);
	mkdirSync(dirname(statusPath), { recursive: true });
	writeFileSync(statusPath, JSON.stringify(status, null, 2), "utf8");
}

function readBackgroundRebuildStatus(cwd: string): BackgroundRebuildStatus | undefined {
	const absoluteCwd = resolve(cwd);
	const statusPath = getIndexRebuildStatusPath(absoluteCwd);
	if (!existsSync(statusPath)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(statusPath, "utf8")) as Partial<BackgroundRebuildStatus>;
		if (!parsed.status || !parsed.cwd || !parsed.logPath) return undefined;
		return parsed as BackgroundRebuildStatus;
	} catch {
		return undefined;
	}
}

function lastLogLines(logPath: string, count = 8): string[] {
	if (!existsSync(logPath)) return [];
	try {
		return readFileSync(logPath, "utf8").trimEnd().split("\n").slice(-count);
	} catch {
		return [];
	}
}

function inferBackgroundStatusFromLog(cwd: string): BackgroundRebuildStatus | undefined {
	const absoluteCwd = resolve(cwd);
	const logPath = getIndexRebuildLogPath(absoluteCwd);
	const lines = lastLogLines(logPath, 200);
	if (lines.length === 0) return undefined;
	const lastFinished = [...lines].reverse().find((line) => /semantic-search background rebuild finished/.test(line));
	const lastFailed = [...lines].reverse().find((line) => /semantic-search background rebuild failed/.test(line));
	const lastStarted = [...lines].reverse().find((line) => /semantic-search background rebuild started/.test(line));
	const timestamp = (line: string | undefined) => line?.match(/^\[([^\]]+)\]/)?.[1];
	if (lastFailed && (!lastFinished || lines.lastIndexOf(lastFailed) > lines.lastIndexOf(lastFinished))) {
		return { status: "failed", cwd: absoluteCwd, logPath, startedAt: timestamp(lastStarted), finishedAt: timestamp(lastFailed), error: lastFailed };
	}
	if (lastFinished) return { status: "succeeded", cwd: absoluteCwd, logPath, startedAt: timestamp(lastStarted), finishedAt: timestamp(lastFinished), message: lastFinished };
	if (lastStarted) return { status: "unknown", cwd: absoluteCwd, logPath, startedAt: timestamp(lastStarted), message: "rebuild started; no finish/failure line found yet" };
	return undefined;
}

function currentBackgroundRebuildStatus(cwd: string): BackgroundRebuildStatus | undefined {
	const status = readBackgroundRebuildStatus(cwd) ?? inferBackgroundStatusFromLog(cwd);
	if (!status) return undefined;
	if (status.status === "running" && !isProcessRunning(status.pid)) {
		return { ...status, status: "unknown", message: "recorded as running, but the process is no longer active; check the log for finish/failure details" };
	}
	return status;
}

function markBackgroundRebuildNotified(status: BackgroundRebuildStatus): void {
	writeBackgroundRebuildStatus({ ...status, notified: true });
}

function clearTerminalIndicatorTimer(cwd: string): void {
	const absoluteCwd = resolve(cwd);
	const timer = terminalIndicatorTimers.get(absoluteCwd);
	if (!timer) return;
	clearTimeout(timer);
	terminalIndicatorTimers.delete(absoluteCwd);
}

function scheduleTerminalIndicatorClear(pi: ExtensionAPI, ui: RebuildStatusUI | undefined, cwd: string): void {
	const absoluteCwd = resolve(cwd);
	clearTerminalIndicatorTimer(absoluteCwd);
	const timer = setTimeout(() => {
		terminalIndicatorTimers.delete(absoluteCwd);
		publishBackgroundRebuildComposerStatus(pi, ui, undefined);
	}, TERMINAL_REBUILD_INDICATOR_MS);
	timer.unref?.();
	terminalIndicatorTimers.set(absoluteCwd, timer);
}

function formatRebuildProgressLines(progress: RebuildProgress): string[] {
	const count = typeof progress.current === "number" && typeof progress.total === "number" ? ` ${progress.current}/${progress.total}` : "";
	const percent = typeof progress.percent === "number" ? ` (${progress.percent}%)` : "";
	const lines = [`Progress: ${progress.phase}${count}${percent} — ${progress.message}`];
	if (typeof progress.elapsedMs === "number") lines.push(`Phase elapsed: ${formatDurationMs(progress.elapsedMs)}`);
	if (typeof progress.estimatedRemainingMs === "number") lines.push(`ETA: ~${formatDurationMs(progress.estimatedRemainingMs)} remaining (best effort)`);
	lines.push(`Progress updated: ${progress.updatedAt}`);
	return lines;
}

export function formatBackgroundRebuildIndicator(status: Pick<BackgroundRebuildStatus, "status" | "progress" | "notified"> | undefined): string | undefined {
	if (!status || status.notified) return undefined;
	if (status.status === "succeeded") return "idx: done";
	if (status.status === "failed") return "idx: failed";
	if (status.status === "unknown") return "idx: unknown";
	const progress = status.progress;
	if (!progress) return "idx: rebuilding…";
	const percent = typeof progress.percent === "number" ? ` ${progress.percent}%` : "";
	const eta = typeof progress.estimatedRemainingMs === "number" ? ` · ~${formatDurationMs(progress.estimatedRemainingMs)}` : "";
	return `idx: ${progress.phase}${percent}${eta}`;
}

type RebuildStatusUI = {
	setStatus?: (key: string, value: string | undefined) => void;
};

function publishBackgroundRebuildComposerStatus(pi: ExtensionAPI, ui: RebuildStatusUI | undefined, status: BackgroundRebuildStatus | undefined): void {
	const indicator = formatBackgroundRebuildIndicator(status);
	ui?.setStatus?.("semantic-search", indicator);
	pi.events?.emit?.("semantic-search:rebuild-status", { indicator, status: status?.status, progress: status?.progress });
}

function formatBackgroundRebuildStatus(cwd: string, indexStatus: IndexStatus): string {
	const status = currentBackgroundRebuildStatus(cwd);
	const logPath = status?.logPath ?? getIndexRebuildLogPath(resolve(cwd));
	const lines = ["Semantic index background rebuild status:"];
	if (!status) {
		lines.push("State: none recorded");
		lines.push(`Log: ${logPath}`);
	} else {
		lines.push(`State: ${status.status}${status.status === "running" && isProcessRunning(status.pid) ? " (process active)" : ""}`);
		if (status.pid) lines.push(`PID: ${status.pid}`);
		if (status.startedAt) {
			lines.push(`Started: ${status.startedAt}`);
			const startedMs = Date.parse(status.startedAt);
			if (Number.isFinite(startedMs) && status.status === "running") lines.push(`Elapsed: ${formatDurationMs(Date.now() - startedMs)}`);
		}
		if (status.finishedAt) lines.push(`Finished: ${status.finishedAt}`);
		if (status.embeddingModel) lines.push(`Embedding model: ${status.embeddingModel}`);
		if (status.summariesDisabled) lines.push("Summaries: disabled");
		else if (status.summaryModel) lines.push(`Summary model: ${status.summaryModel}`);
		if (status.progress) lines.push(...formatRebuildProgressLines(status.progress));
		if (status.message) lines.push(`Message: ${status.message}`);
		if (status.error) lines.push(`Error: ${status.error}`);
		lines.push(`Log: ${status.logPath}`);
	}
	lines.push("", `Current index: ${indexStatus.stale ? "stale" : "fresh"} (${indexStatus.reason})`);
	if (indexStatus.summary) lines.push(`Summaries: ollama/${indexStatus.summary.model} (${indexStatus.summary.summarizedCards} generated, ${indexStatus.summary.cachedCards} cached, ${indexStatus.summary.failedCards} failed)`);
	if (indexStatus.embedding) lines.push(`Embeddings: ollama/${indexStatus.embedding.model} (${indexStatus.embedding.embeddedChunks} chunks, ${indexStatus.embedding.embeddedCards} cards)`);
	const recent = lastLogLines(logPath, 6);
	if (recent.length > 0) lines.push("", "Recent log:", ...recent.map((line) => `  ${line}`));
	return lines.join("\n");
}

function formatBackgroundRebuildFailure(status: BackgroundRebuildStatus, indexStatus: IndexStatus): string {
	const lines = ["Semantic index background rebuild failed."];
	if (status.message) lines.push(status.message);
	if (status.error) lines.push(`Error: ${status.error}`);
	lines.push(`Current index: ${indexStatus.stale ? "stale" : "fresh"} (${indexStatus.reason})`);
	lines.push(`Status: ${getIndexRebuildStatusPath(resolve(status.cwd))}`);
	lines.push(`Log: ${status.logPath}`);
	return lines.join("\n");
}

function watchBackgroundIndexBuild(pi: ExtensionAPI, cwd: string, ui?: RebuildStatusUI): void {
	const absoluteCwd = resolve(cwd);
	if (watchedBackgroundRebuilds.has(absoluteCwd)) {
		publishBackgroundRebuildComposerStatus(pi, ui, currentBackgroundRebuildStatus(absoluteCwd));
		return;
	}
	const initialStatus = currentBackgroundRebuildStatus(absoluteCwd);
	if (initialStatus?.status === "running") clearTerminalIndicatorTimer(absoluteCwd);
	publishBackgroundRebuildComposerStatus(pi, ui, initialStatus);
	if (!initialStatus || (initialStatus.status !== "running" && initialStatus.notified)) return;
	const check = () => {
		const status = currentBackgroundRebuildStatus(absoluteCwd);
		publishBackgroundRebuildComposerStatus(pi, ui, status);
		if (!status) return;
		if (status.status === "running") return;
		const interval = watchedBackgroundRebuilds.get(absoluteCwd);
		if (interval) {
			clearInterval(interval);
			watchedBackgroundRebuilds.delete(absoluteCwd);
		}
		if (status.notified) return;
		if (status.status === "failed") {
			const indexStatus = getIndexStatus(absoluteCwd);
			pi.sendMessage?.({
				customType: "semantic-search",
				content: formatBackgroundRebuildFailure(status, indexStatus),
				display: true,
				details: { index: indexStatus, rebuild: status },
			});
		}
		markBackgroundRebuildNotified(status);
		scheduleTerminalIndicatorClear(pi, ui, absoluteCwd);
	};
	const interval = setInterval(check, 5000);
	watchedBackgroundRebuilds.set(absoluteCwd, interval);
	void Promise.resolve().then(check);
}

function startBackgroundIndexBuild(cwd: string, options: { embeddingModel?: string; summaryModel?: string; summariesDisabled?: boolean } = {}): { pid?: number; logPath: string; statusPath: string } {
	const absoluteCwd = resolve(cwd);
	const logPath = getIndexRebuildLogPath(absoluteCwd);
	const statusPath = getIndexRebuildStatusPath(absoluteCwd);
	mkdirSync(dirname(logPath), { recursive: true });
	const logFd = openSync(logPath, "a");
	const parentStartedAtMs = Date.now();
	const parentStartedAt = new Date(parentStartedAtMs).toISOString();
	const startingProgress = buildRebuildProgressSnapshot("background rebuild process started", parentStartedAtMs, parentStartedAtMs);
	const code = [
		`import { writeFileSync } from "node:fs";`,
		`import { buildRebuildProgressSnapshot, buildSearchIndexWithEmbeddings } from ${JSON.stringify(import.meta.url)};`,
		`const cwd = ${JSON.stringify(absoluteCwd)};`,
		`const logPath = ${JSON.stringify(logPath)};`,
		`const statusPath = ${JSON.stringify(statusPath)};`,
		`const startedAtMs = Date.now();`,
		`const startedAt = new Date(startedAtMs).toISOString();`,
		`let phaseStartedAtMs = startedAtMs;`,
		`let currentPhase = "starting";`,
		`const baseStatus = { status: "running", cwd, logPath, pid: process.pid, startedAt, embeddingModel: ${JSON.stringify(options.embeddingModel)}, summaryModel: ${JSON.stringify(options.summaryModel)}, summariesDisabled: ${JSON.stringify(options.summariesDisabled ?? false)} };`,
		`const writeStatus = (updates = {}) => writeFileSync(statusPath, JSON.stringify({ ...baseStatus, ...updates }, null, 2), "utf8");`,
		`const recordProgress = (message) => {`,
		`  const nowMs = Date.now();`,
		`  let progress = buildRebuildProgressSnapshot(message, phaseStartedAtMs, nowMs);`,
		`  if (progress.phase !== currentPhase) {`,
		`    currentPhase = progress.phase;`,
		`    phaseStartedAtMs = nowMs;`,
		`    progress = buildRebuildProgressSnapshot(message, phaseStartedAtMs, nowMs);`,
		`  }`,
		`  writeStatus({ message, progress });`,
		`  console.error(\`[\${new Date(nowMs).toISOString()}] \${message}\`);`,
		`};`,
		`recordProgress("background rebuild process started");`,
		`console.error(\`[\${startedAt}] semantic-search background rebuild started for \${cwd} (pid \${process.pid})\`);`,
		`try {`,
		`  const index = await buildSearchIndexWithEmbeddings(cwd, {`,
		`    writeToDisk: true,`,
		`    ollama: { model: ${JSON.stringify(options.embeddingModel ?? null)} ?? undefined },`,
		`    summary: ${JSON.stringify(options.summariesDisabled ?? false)} ? false : { model: ${JSON.stringify(options.summaryModel ?? null)} ?? undefined },`,
		`    onProgress: recordProgress,`,
		`  });`,
		`  const finishedAtMs = Date.now();`,
		`  const finishedAt = new Date(finishedAtMs).toISOString();`,
		`  const message = \`semantic-search background rebuild finished: \${index.files.length} files / \${index.chunks.length} chunks / \${index.cards.length} semantic cards\`;`,
		`  console.error(\`[\${finishedAt}] \${message}\`);`,
		`  writeStatus({ status: "succeeded", finishedAt, message, progress: { phase: "finished", message, current: 1, total: 1, percent: 100, phaseStartedAt: startedAt, updatedAt: finishedAt, elapsedMs: finishedAtMs - startedAtMs } });`,
		`} catch (error) {`,
		`  const finishedAt = new Date().toISOString();`,
		`  const errorMessage = error instanceof Error ? error.stack ?? error.message : String(error);`,
		`  console.error(\`[\${finishedAt}] semantic-search background rebuild failed: \${errorMessage}\`);`,
		`  writeStatus({ status: "failed", finishedAt, error: errorMessage });`,
		`  process.exitCode = 1;`,
		`}`,
	].join("\n");
	try {
		const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
			cwd: absoluteCwd,
			detached: true,
			stdio: ["ignore", logFd, logFd],
			env: process.env,
		});
		child.unref();
		writeBackgroundRebuildStatus({
			status: "running",
			cwd: absoluteCwd,
			logPath,
			pid: child.pid,
			startedAt: parentStartedAt,
			embeddingModel: options.embeddingModel,
			summaryModel: options.summaryModel,
			summariesDisabled: options.summariesDisabled,
			progress: startingProgress,
			message: "background rebuild process started",
		});
		writeFileSync(logPath, `[${parentStartedAt}] semantic-search background rebuild spawned${child.pid ? ` pid ${child.pid}` : ""}\n`, { flag: "a" });
		return { pid: child.pid, logPath, statusPath };
	} finally {
		closeSync(logFd);
	}
}

type BackgroundIndexBuildStarter = typeof startBackgroundIndexBuild;

function normalizeToolPath(toolPath: string): string {
	return toolPath.trim().replace(/^@/, "");
}

function pathIsInsideCwd(cwd: string, absolutePath: string): boolean {
	const normalizedCwd = resolve(cwd);
	const normalizedPath = resolve(absolutePath);
	const pathFromCwd = relative(normalizedCwd, normalizedPath);
	return pathFromCwd === "" || (!pathFromCwd.startsWith("..") && !isAbsolute(pathFromCwd));
}

function fileChangingToolPath(event: { toolName?: string; input?: unknown; isError?: boolean }): string | undefined {
	if (event.isError || (event.toolName !== "write" && event.toolName !== "edit")) return undefined;
	const input = event.input && typeof event.input === "object" ? event.input as { path?: unknown } : undefined;
	return typeof input?.path === "string" && input.path.trim() ? input.path : undefined;
}

function formatAutoRebuildStartedNotification(changedPaths: string[], started: { pid?: number; logPath: string }): string {
	const changed = changedPaths.length === 1 ? "1 changed file" : `${changedPaths.length} changed files`;
	return `Semantic index stale after ${changed}; rebuilding in background${started.pid ? ` (pid ${started.pid})` : ""}. Log: ${started.logPath}`;
}

function flagValue(tokens: string[], flag: string): string | undefined {
	const equals = `${flag}=`;
	const inline = tokens.find((token) => token.startsWith(equals));
	if (inline) return inline.slice(equals.length) || undefined;
	const index = tokens.indexOf(flag);
	return index >= 0 ? tokens[index + 1] : undefined;
}

type ParsedIndexCommandArgs = {
	tokens: string[];
	action: string;
	lexicalOnly: boolean;
	background: boolean;
	summariesDisabled: boolean;
	summaryModel?: string;
	model?: string;
	error?: string;
};

const INDEX_ACTIONS = ["status", "rebuild", "build", "lexical", "rebuild-status"] as const;

function editDistance(a: string, b: string): number {
	const previous = Array.from({ length: b.length + 1 }, (_value, index) => index);
	for (let i = 1; i <= a.length; i++) {
		let diagonal = previous[0];
		previous[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const beforeUpdate = previous[j];
			previous[j] = a[i - 1] === b[j - 1]
				? diagonal
				: Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + 1);
			diagonal = beforeUpdate;
		}
	}
	return previous[b.length] ?? Math.max(a.length, b.length);
}

function closestIndexAction(token: string): string | undefined {
	const normalized = token.toLowerCase();
	let best: { action: string; distance: number } | undefined;
	for (const action of INDEX_ACTIONS) {
		const distance = editDistance(normalized, action);
		if (!best || distance < best.distance) best = { action, distance };
	}
	return best && best.distance <= 2 ? best.action : undefined;
}

export function parseIndexCommandArgs(args: string): ParsedIndexCommandArgs {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const action = tokens[0] ?? "rebuild";
	const suggestedAction = tokens.length > 0 && !INDEX_ACTIONS.includes(action as (typeof INDEX_ACTIONS)[number]) && !action.startsWith("--")
		? closestIndexAction(action)
		: undefined;
	if (suggestedAction) {
		return {
			tokens,
			action,
			lexicalOnly: false,
			background: false,
			summariesDisabled: false,
			error: `Unknown /index action '${action}'. Did you mean '/index ${suggestedAction}'? Use '/index rebuild <model>' to pass an embedding model.`,
		};
	}
	const lexicalOnly = tokens.includes("lexical") || tokens.includes("--lexical");
	const foreground = tokens.includes("--foreground") || tokens.includes("foreground") || tokens.includes("fg");
	const statusOnly = action === "status" || action === "rebuild-status" || tokens.includes("--status");
	const background = !statusOnly && !lexicalOnly && !foreground;
	const summariesDisabled = tokens.includes("--no-summaries") || tokens.includes("no-summaries");
	const summaryModel = flagValue(tokens, "--summary-model");
	const valueIndexesToSkip = new Set<number>();
	const summaryFlagIndex = tokens.indexOf("--summary-model");
	if (summaryFlagIndex >= 0) valueIndexesToSkip.add(summaryFlagIndex + 1);
	const reserved = new Set(["rebuild", "build", "embeddings", "--embeddings", "--ollama", "lexical", "--lexical", "--background", "background", "bg", "--foreground", "foreground", "fg", "--no-summaries", "no-summaries", "--summary-model", "--status"]);
	const model = tokens.find((token, index) => !valueIndexesToSkip.has(index) && !reserved.has(token) && !token.startsWith("--summary-model="));
	return { tokens, action, lexicalOnly, background, summariesDisabled, summaryModel, model };
}

type OllamaTunnelAction = "start" | "status" | "stop" | "local" | "help";

export type OllamaTunnelConfig = {
	sshTarget: string;
	localHost: string;
	localPort: number;
	remoteHost: string;
	remotePort: number;
};

type ParsedOllamaTunnelCommandArgs = OllamaTunnelConfig & {
	tokens: string[];
	action: OllamaTunnelAction;
	printOnly: boolean;
	localPortExplicit: boolean;
	error?: string;
};

type OllamaTunnelStartResult = {
	ok: boolean;
	command: string;
	ollamaUrl: string;
	output?: string;
	error?: string;
};

type OllamaTunnelStopResult = {
	killedPids: number[];
	attemptedPorts: number[];
	error?: string;
};

type OllamaTunnelStarter = (config: OllamaTunnelConfig) => OllamaTunnelStartResult | Promise<OllamaTunnelStartResult>;
type OllamaTunnelStopper = (config: ParsedOllamaTunnelCommandArgs) => OllamaTunnelStopResult | Promise<OllamaTunnelStopResult>;

const OLLAMA_TUNNEL_ACTIONS = new Set<string>(["start", "status", "stop", "local", "help"]);

function parsePort(value: unknown, fallback: number, label: string): { value: number; error?: string } {
	if (value === undefined || value === null) return { value: fallback };
	if (typeof value === "string" && value.trim() === "") return { value: fallback };
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) return { value: fallback, error: `${label} must be an integer between 1 and 65535.` };
	return { value: parsed };
}

function firstPositionalToken(tokens: string[], valueIndexesToSkip: Set<number>): string | undefined {
	const reserved = new Set(["start", "status", "stop", "local", "help", "--help", "-h", "--print", "--dry-run", "--host", "--local-port", "--remote-port", "--remote-host", "--local-host"]);
	return tokens.find((token, index) => !valueIndexesToSkip.has(index) && !reserved.has(token) && !token.startsWith("--"));
}

function isLoopbackHost(value: string): boolean {
	return ["127.0.0.1", "localhost"].includes(value.trim().toLowerCase());
}

export function parseOllamaTunnelCommandArgs(args: string, env: Record<string, string | undefined> = process.env, config: SemanticSearchConfig = readSemanticSearchConfig(env)): ParsedOllamaTunnelCommandArgs {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const first = tokens[0]?.toLowerCase();
	const action: OllamaTunnelAction = first === "status" ? "status" : first === "stop" ? "stop" : first === "local" ? "local" : first === "help" || first === "--help" || first === "-h" ? "help" : "start";
	const valueIndexesToSkip = new Set<number>();
	for (const flag of ["--host", "--local-port", "--remote-port", "--remote-host", "--local-host"]) {
		const index = tokens.indexOf(flag);
		if (index >= 0) valueIndexesToSkip.add(index + 1);
	}
	const positionalHost = firstPositionalToken(tokens, valueIndexesToSkip);
	const sshTarget = flagValue(tokens, "--host") ?? positionalHost ?? env.PI_OLLAMA_SSH_HOST ?? stringConfigValue(config.tunnel?.sshTarget) ?? DEFAULT_OLLAMA_SSH_TARGET;
	const localHost = flagValue(tokens, "--local-host") ?? env.PI_OLLAMA_TUNNEL_LOCAL_HOST ?? stringConfigValue(config.tunnel?.localHost) ?? DEFAULT_OLLAMA_TUNNEL_HOST;
	const remoteHost = flagValue(tokens, "--remote-host") ?? env.PI_OLLAMA_TUNNEL_REMOTE_HOST ?? stringConfigValue(config.tunnel?.remoteHost) ?? DEFAULT_OLLAMA_TUNNEL_HOST;
	const localPortExplicit = tokens.includes("--local-port") || tokens.some((token) => token.startsWith("--local-port="));
	const localPort = parsePort(flagValue(tokens, "--local-port") ?? env.PI_OLLAMA_TUNNEL_LOCAL_PORT ?? config.tunnel?.localPort, DEFAULT_OLLAMA_TUNNEL_PORT, "Local port");
	const remotePort = parsePort(flagValue(tokens, "--remote-port") ?? env.PI_OLLAMA_TUNNEL_REMOTE_PORT ?? config.tunnel?.remotePort, DEFAULT_OLLAMA_TUNNEL_PORT, "Remote port");
	const printOnly = tokens.includes("--print") || tokens.includes("--dry-run");
	const base: ParsedOllamaTunnelCommandArgs = {
		tokens,
		action,
		sshTarget,
		localHost,
		localPort: localPort.value,
		remoteHost,
		remotePort: remotePort.value,
		printOnly,
		localPortExplicit,
	};
	const knownOptions = ["--help", "-h", "--print", "--dry-run", "--host", "--local-port", "--remote-port", "--remote-host", "--local-host"];
	if (!OLLAMA_TUNNEL_ACTIONS.has(first ?? "start") && first?.startsWith("-") && !knownOptions.some((option) => first === option || first.startsWith(`${option}=`))) return { ...base, error: `Unknown /ollama-tunnel option '${first}'.` };
	if (localPort.error) return { ...base, error: localPort.error };
	if (remotePort.error) return { ...base, error: remotePort.error };
	if (!isLoopbackHost(localHost)) return { ...base, error: "Local tunnel host must be localhost or 127.0.0.1." };
	if ((action === "start" || action === "stop") && !sshTarget.trim()) return { ...base, error: "Missing SSH target. Usage: /ollama-tunnel user@remote-host" };
	if (sshTarget.trim().startsWith("-")) return { ...base, error: "SSH target must not start with '-'." };
	return base;
}

function shellQuote(value: string): string {
	return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function ollamaUrlForTunnel(config: Pick<OllamaTunnelConfig, "localHost" | "localPort">): string {
	return `http://${config.localHost}:${config.localPort}`;
}

export function buildOllamaTunnelSshArgs(config: OllamaTunnelConfig): string[] {
	return [
		"-f",
		"-N",
		"-L",
		`${config.localHost}:${config.localPort}:${config.remoteHost}:${config.remotePort}`,
		"-o",
		"ExitOnForwardFailure=yes",
		"-o",
		"BatchMode=yes",
		config.sshTarget,
	];
}

export function formatOllamaTunnelSshCommand(config: OllamaTunnelConfig): string {
	return ["ssh", ...buildOllamaTunnelSshArgs(config)].map(shellQuote).join(" ");
}

function startOllamaTunnel(config: OllamaTunnelConfig): OllamaTunnelStartResult {
	const command = formatOllamaTunnelSshCommand(config);
	try {
		const output = execFileSync("ssh", buildOllamaTunnelSshArgs(config), {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 15_000,
		});
		return { ok: true, command, ollamaUrl: ollamaUrlForTunnel(config), output: output.trim() };
	} catch (error) {
		const failure = error as Error & { stderr?: Buffer | string; stdout?: Buffer | string };
		const stderr = failure.stderr ? String(failure.stderr).trim() : "";
		const stdout = failure.stdout ? String(failure.stdout).trim() : "";
		return { ok: false, command, ollamaUrl: ollamaUrlForTunnel(config), error: stderr || stdout || failure.message };
	}
}

function sshTunnelForwardSpec(config: OllamaTunnelConfig, localPort = config.localPort): string {
	return `${config.localHost}:${localPort}:${config.remoteHost}:${config.remotePort}`;
}

function tunnelStopPorts(config: ParsedOllamaTunnelCommandArgs): number[] {
	return config.localPortExplicit ? [config.localPort] : fallbackTunnelPorts(config.localPort);
}

function findOllamaTunnelPids(config: ParsedOllamaTunnelCommandArgs): { pids: number[]; attemptedPorts: number[] } {
	const attemptedPorts = tunnelStopPorts(config);
	const output = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	const pids: number[] = [];
	for (const line of output.split("\n")) {
		const match = line.match(/^\s*(\d+)\s+(.+)$/);
		if (!match) continue;
		const pid = Number(match[1]);
		const command = match[2] ?? "";
		if (!Number.isFinite(pid) || !/\bssh\b/.test(command) || !command.includes(config.sshTarget)) continue;
		if (!attemptedPorts.some((port) => command.includes(sshTunnelForwardSpec(config, port)))) continue;
		pids.push(pid);
	}
	return { pids: unique(pids), attemptedPorts };
}

function stopOllamaTunnel(config: ParsedOllamaTunnelCommandArgs): OllamaTunnelStopResult {
	try {
		const { pids, attemptedPorts } = findOllamaTunnelPids(config);
		for (const pid of pids) process.kill(pid, "TERM");
		return { killedPids: pids, attemptedPorts };
	} catch (error) {
		return { killedPids: [], attemptedPorts: tunnelStopPorts(config), error: error instanceof Error ? error.message : String(error) };
	}
}

function formatOllamaTunnelInstructions(config: OllamaTunnelConfig): string {
	return [
		"Remote Ollama over SSH tunnel:",
		`SSH target: ${config.sshTarget}`,
		`Local Ollama URL for Pi: ${ollamaUrlForTunnel(config)}`,
		"",
		"Start tunnel:",
		`  ${formatOllamaTunnelSshCommand(config)}`,
		"",
		"Remote setup if needed:",
		"  ollama serve",
		`  ollama pull ${configuredDefaultEmbeddingModel()}`,
		`  ollama pull ${configuredDefaultSummaryModel()}`,
		"",
		"Then rebuild:",
		"  /index rebuild",
	].join("\n");
}

function formatOllamaTunnelStarted(result: OllamaTunnelStartResult, attemptedPorts: number[] = []): string {
	const fallbackNote = attemptedPorts.length > 1 ? ["", `Note: local port ${attemptedPorts[0]} was busy; used ${attemptedPorts[attemptedPorts.length - 1]} instead.`] : [];
	return [
		"Ollama SSH tunnel is ready.",
		`Ollama URL for this Pi session: ${result.ollamaUrl}`,
		...fallbackNote,
		"",
		"Next:",
		"  /index rebuild",
		"  /index rebuild --status",
		"",
		"Command used:",
		`  ${result.command}`,
	].join("\n");
}

function useLocalOllama(): string {
	process.env.OLLAMA_BASE_URL = DEFAULT_OLLAMA_BASE_URL;
	return DEFAULT_OLLAMA_BASE_URL;
}

function formatOllamaTunnelStopped(result: OllamaTunnelStopResult, localUrl: string): string {
	return [
		result.killedPids.length > 0 ? `Stopped Ollama SSH tunnel process${result.killedPids.length === 1 ? "" : "es"}: ${result.killedPids.join(", ")}` : "No matching Ollama SSH tunnel process was found.",
		`Pi now uses local Ollama: ${localUrl}`,
		`Checked local ports: ${result.attemptedPorts.join(", ")}`,
		result.error ? `Warning: ${result.error}` : undefined,
		"",
		"Next:",
		"  /index rebuild",
	].filter((line): line is string => typeof line === "string").join("\n");
}

function formatOllamaTunnelLocal(localUrl: string): string {
	return [`Pi now uses local Ollama: ${localUrl}`, "", "This does not kill an existing SSH tunnel. Use /ollama-tunnel stop to stop matching tunnel processes."].join("\n");
}

function localPortUnavailable(error: string | undefined): boolean {
	return /Address already in use|cannot listen to port/i.test(error ?? "");
}

function fallbackTunnelPorts(preferredPort: number): number[] {
	const ports = [preferredPort];
	for (let port = 11435; port <= 11444; port++) {
		if (!ports.includes(port)) ports.push(port);
	}
	return ports;
}

async function startOllamaTunnelWithFallback(starter: OllamaTunnelStarter, config: ParsedOllamaTunnelCommandArgs): Promise<{ result: OllamaTunnelStartResult; config: OllamaTunnelConfig; attemptedPorts: number[] }> {
	let currentConfig: OllamaTunnelConfig = config;
	let result = await starter(currentConfig);
	const attemptedPorts = [currentConfig.localPort];
	if (result.ok || config.localPortExplicit || !localPortUnavailable(result.error)) return { result, config: currentConfig, attemptedPorts };

	for (const port of fallbackTunnelPorts(config.localPort).slice(1)) {
		currentConfig = { ...config, localPort: port };
		result = await starter(currentConfig);
		attemptedPorts.push(port);
		if (result.ok || !localPortUnavailable(result.error)) break;
	}

	return { result, config: currentConfig, attemptedPorts };
}

async function formatOllamaTunnelStatus(config: Pick<OllamaTunnelConfig, "localHost" | "localPort">): Promise<string> {
	const ollamaUrl = ollamaUrlForTunnel(config);
	try {
		const payload = await fetchJsonWithTimeout(`${ollamaUrl}/api/tags`, { method: "GET" }, 5_000);
		const models = Array.isArray((payload as { models?: unknown }).models)
			? ((payload as { models: Array<{ name?: unknown }> }).models).map((model) => model.name).filter((name): name is string => typeof name === "string")
			: [];
		return [`Ollama tunnel/status check succeeded: ${ollamaUrl}`, models.length > 0 ? `Models: ${models.join(", ")}` : "Models: none reported"].join("\n");
	} catch (error) {
		return [`Ollama tunnel/status check failed: ${ollamaUrl}`, `Error: ${error instanceof Error ? error.message : String(error)}`, "", "If you want the SSH tunnel path, run:", `  ${tunnelCommandHint()}`].join("\n");
	}
}

export type SemanticSearchExtensionOptions = {
	autoRebuild?: boolean;
	autoRebuildWorktrees?: boolean;
	startBackgroundIndexBuild?: BackgroundIndexBuildStarter;
	startOllamaTunnel?: OllamaTunnelStarter;
	stopOllamaTunnel?: OllamaTunnelStopper;
};

export default function semanticSearchExtension(pi: ExtensionAPI, options: SemanticSearchExtensionOptions = {}) {
	const config = readSemanticSearchConfig();
	const configuredEmbeddingModel = configuredDefaultEmbeddingModel(config);
	const configuredSummaryModel = configuredDefaultSummaryModel(config);
	const configuredSshTarget = configuredDefaultSshTarget(config);
	const changedPathsByCwd = new Map<string, Set<string>>();
	const linkedWorktreesByCwd = new Map<string, LinkedWorktree | undefined>();
	const autoRebuildEnabled = options.autoRebuild ?? envFlagEnabled(process.env.PI_SEMANTIC_SEARCH_AUTO_REBUILD, true);
	const autoRebuildWorktrees = options.autoRebuildWorktrees ?? envFlagEnabled(process.env.PI_SEMANTIC_SEARCH_AUTO_REBUILD_WORKTREES, false);
	const startIndexBuild = options.startBackgroundIndexBuild ?? startBackgroundIndexBuild;
	const startTunnel = options.startOllamaTunnel ?? startOllamaTunnel;
	const stopTunnel = options.stopOllamaTunnel ?? stopOllamaTunnel;

	function noteChangedPath(cwd: string, toolPath: string | undefined): void {
		if (!toolPath) return;
		const absoluteCwd = resolve(cwd);
		const absolutePath = resolve(absoluteCwd, normalizeToolPath(toolPath));
		if (!pathIsInsideCwd(absoluteCwd, absolutePath)) return;
		const paths = changedPathsByCwd.get(absoluteCwd) ?? new Set<string>();
		paths.add(absolutePath);
		changedPathsByCwd.set(absoluteCwd, paths);
	}

	function tryStartAutoRebuild(cwd: string, ui?: RebuildStatusUI & { notify?: (message: string, level?: string) => void }): void {
		if (!autoRebuildEnabled) return;
		const absoluteCwd = resolve(cwd);
		const linkedWorktree = linkedWorktreesByCwd.has(absoluteCwd) ? linkedWorktreesByCwd.get(absoluteCwd) : getLinkedWorktree(absoluteCwd);
		linkedWorktreesByCwd.set(absoluteCwd, linkedWorktree);
		if (linkedWorktree && !autoRebuildWorktrees) {
			changedPathsByCwd.delete(absoluteCwd);
			return;
		}
		const changedPaths = changedPathsByCwd.get(absoluteCwd);
		if (!changedPaths || changedPaths.size === 0) return;
		const runningStatus = currentBackgroundRebuildStatus(absoluteCwd);
		if (runningStatus?.status === "running") {
			watchBackgroundIndexBuild(pi, absoluteCwd, ui);
			return;
		}
		const status = getIndexStatus(absoluteCwd);
		if (!status.stale) {
			changedPathsByCwd.delete(absoluteCwd);
			return;
		}
		try {
			clearTerminalIndicatorTimer(absoluteCwd);
			const changedSnapshot = Array.from(changedPaths);
			const started = startIndexBuild(absoluteCwd);
			changedPathsByCwd.delete(absoluteCwd);
			watchBackgroundIndexBuild(pi, absoluteCwd, ui);
			publishBackgroundRebuildComposerStatus(pi, ui, currentBackgroundRebuildStatus(absoluteCwd));
			ui?.notify?.(formatAutoRebuildStartedNotification(changedSnapshot, started), "info");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ui?.notify?.(`Semantic index auto-rebuild failed to start: ${message}`, "error");
		}
	}

	pi.on?.("session_start", (_event, ctx) => {
		const absoluteCwd = resolve(ctx.cwd);
		const reused = reusePrimaryWorktreeIndex(absoluteCwd);
		linkedWorktreesByCwd.set(absoluteCwd, reused ? { currentRoot: absoluteCwd, primaryRoot: reused.primaryRoot } : getLinkedWorktree(absoluteCwd));
		if (reused?.copied.length) {
			ctx.ui.notify?.(`Reused semantic index from primary worktree (${reused.copied.join(", ")}).`, "info");
		}
		watchBackgroundIndexBuild(pi, absoluteCwd, ctx.ui);
	});
	pi.on?.("session_shutdown", () => {
		for (const interval of watchedBackgroundRebuilds.values()) clearInterval(interval);
		watchedBackgroundRebuilds.clear();
		for (const timer of terminalIndicatorTimers.values()) clearTimeout(timer);
		terminalIndicatorTimers.clear();
		changedPathsByCwd.clear();
		linkedWorktreesByCwd.clear();
	});

	pi.on?.("tool_result", async (event, ctx) => {
		noteChangedPath(ctx.cwd, fileChangingToolPath(event));
	});

	pi.on?.("agent_end", async (_event, ctx) => {
		tryStartAutoRebuild(ctx.cwd, ctx.ui);
	});

	pi.registerCommand("index", {
		description: "Build, rebuild, or show status for the semantic code-search index. Default semantic rebuild runs in the background. Usage: /index [status|rebuild|build|lexical] [ollama-model] [--summary-model model] [--foreground|--status]",
		handler: async (args, ctx) => {
			const { tokens, action, lexicalOnly, background, summariesDisabled, summaryModel, model, error } = parseIndexCommandArgs(args);
			if (error) {
				ctx.ui.notify(error, "error");
				pi.sendMessage?.({ customType: "semantic-search", content: `${error}\n\nUsage: /index [status|rebuild|build|lexical] [ollama-model] [--summary-model model] [--foreground|--status]`, display: true, details: { error: true } });
				return;
			}
			if (action === "status") {
				const status = getIndexStatus(ctx.cwd);
				ctx.ui.notify(status.stale ? `Index stale: ${status.reason}` : `Index fresh: ${status.files} files / ${status.chunks} chunks / ${status.cards} semantic cards`, status.stale ? "warning" : "info");
				pi.sendMessage?.({ customType: "semantic-search", content: formatStatus(status), display: true, details: status });
				return;
			}
			if (action === "rebuild-status" || tokens.includes("--status")) {
				const status = getIndexStatus(ctx.cwd);
				const rebuildStatus = currentBackgroundRebuildStatus(ctx.cwd);
				ctx.ui.notify(rebuildStatus ? `Background rebuild: ${rebuildStatus.status}` : "No background rebuild recorded", rebuildStatus?.status === "failed" ? "error" : "info");
				pi.sendMessage?.({ customType: "semantic-search", content: formatBackgroundRebuildStatus(ctx.cwd, status), display: true, details: { index: status, rebuild: rebuildStatus } });
				return;
			}

			if (background) {
				const runningStatus = currentBackgroundRebuildStatus(ctx.cwd);
				if (runningStatus?.status === "running") {
					watchBackgroundIndexBuild(pi, ctx.cwd, ctx.ui);
					publishBackgroundRebuildComposerStatus(pi, ctx.ui, runningStatus);
					ctx.ui.notify("A semantic index rebuild is already running.", "info");
					pi.sendMessage?.({
						customType: "semantic-search",
						content: `Semantic index rebuild is already running.\nStatus: ${getIndexRebuildStatusPath(resolve(ctx.cwd))}\nLog: ${runningStatus.logPath}\nMonitor: /index rebuild --status or the index_rebuild_status tool.`,
						display: true,
						details: runningStatus,
					});
					return;
				}
				clearTerminalIndicatorTimer(ctx.cwd);
				const started = startIndexBuild(ctx.cwd, { embeddingModel: model, summaryModel, summariesDisabled });
				watchBackgroundIndexBuild(pi, ctx.cwd, ctx.ui);
				publishBackgroundRebuildComposerStatus(pi, ctx.ui, currentBackgroundRebuildStatus(ctx.cwd));
				ctx.ui.notify(`Started semantic index rebuild in background${started.pid ? ` (pid ${started.pid})` : ""}. Log: ${started.logPath}`, "info");
				pi.sendMessage?.({ customType: "semantic-search", content: `Semantic index rebuild started in background by default${started.pid ? ` (pid ${started.pid})` : ""}.\nLog: ${started.logPath}\nStatus: ${started.statusPath}\nMonitor: /index rebuild --status or the index_rebuild_status tool.\nFailure: a follow-up message appears only if the rebuild fails.\nForeground escape hatch: /index rebuild --foreground.`, display: true, details: started });
				return;
			}
			ctx.ui.setStatus?.("semantic-search", lexicalOnly ? "indexing…" : summariesDisabled ? "embedding…" : "summarizing…");
			const rebuildStartedAt = new Date().toISOString();
			try {
				const index = lexicalOnly
					? buildSearchIndex(ctx.cwd, { writeToDisk: true })
					: await buildSearchIndexWithEmbeddings(ctx.cwd, {
							writeToDisk: true,
							ollama: { model },
							summary: summariesDisabled ? false : { model: summaryModel },
							onProgress: (message) => ctx.ui.setStatus?.("semantic-search", message),
						});
				const status = getIndexStatus(ctx.cwd, index);
				ctx.ui.notify(`Indexed ${index.files.length} files / ${index.chunks.length} chunks / ${index.cards.length} semantic cards${index.embedding ? ` with ${index.embedding.model}` : ""}`, "info");
				pi.sendMessage?.({ customType: "semantic-search", content: formatStatus(status, true), display: true, details: status });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!lexicalOnly) {
					const absoluteCwd = resolve(ctx.cwd);
					const logPath = getIndexRebuildLogPath(absoluteCwd);
					mkdirSync(dirname(logPath), { recursive: true });
					writeBackgroundRebuildStatus({
						status: "failed",
						cwd: absoluteCwd,
						logPath,
						pid: process.pid,
						startedAt: rebuildStartedAt,
						finishedAt: new Date().toISOString(),
						embeddingModel: model,
						summaryModel,
						summariesDisabled,
						message: "foreground rebuild failed after writing the base index",
						error: message,
					});
					writeFileSync(logPath, `[${new Date().toISOString()}] semantic-search foreground rebuild failed: ${message}\n`, { flag: "a" });
				}
				ctx.ui.notify(`Indexing failed: ${message}`, "error");
				pi.sendMessage?.({
					customType: "semantic-search",
					content: lexicalOnly ? `Indexing failed: ${message}` : `Base lexical/symbol index was written, but Ollama semantic rebuild failed.\n\n${formatOllamaRequirementFailure(error, { embeddingModel: model, summaryModel })}`,
					display: true,
					details: { error: true, requirement: lexicalOnly ? undefined : "ollama", message },
				});
			} finally {
				ctx.ui.setStatus?.("semantic-search", undefined);
			}
		},
	});

	pi.registerCommand("code-search", {
		description: "Search the project index with natural language. Requires local Ollama summaries + embeddings. Usage: /code-search <query>",
		handler: async (args, ctx) => {
			const query = args.trim();
			if (!query) {
				ctx.ui.notify("Usage: /code-search <query>", "error");
				return;
			}
			let index: SearchIndex;
			let results: SearchResult[];
			try {
				const ensured = await ensureIndexWithEmbeddings(ctx.cwd, true, undefined, undefined, (message) => ctx.ui.setStatus?.("semantic-search", message));
				index = ensured.index;
				({ results } = await searchIndexWithEmbeddings(index, { query, topK: DEFAULT_TOP_K }));
			} catch (error) {
				ctx.ui.notify("Semantic search requires Ollama setup", "error");
				pi.sendMessage?.({
					customType: "semantic-search",
					content: formatOllamaRequirementFailure(error),
					display: true,
					details: { query, error: true, requirement: "ollama", message: error instanceof Error ? error.message : String(error) },
				});
				return;
			} finally {
				ctx.ui.setStatus?.("semantic-search", undefined);
			}
			pi.sendMessage?.({
				customType: "semantic-search",
				content: formatSearchResults(query, results, index),
				display: true,
				details: { query, results: compactResultDetails(results) },
			});
		},
	});

	pi.registerCommand("ollama-tunnel", {
		description: `Start, stop, reset, or check a localhost SSH tunnel to remote Ollama. Usage: /ollama-tunnel [user@host|stop|local|status] [--local-port 11434] [--remote-port 11434] [--print]${configuredSshTarget ? `. Default host: ${configuredSshTarget}` : ""}`,
		handler: async (args, ctx) => {
			const parsed = parseOllamaTunnelCommandArgs(args, process.env, config);
			if (parsed.error) {
				ctx.ui.notify(parsed.error, "error");
				pi.sendMessage?.({ customType: "semantic-search", content: `${parsed.error}\n\n${formatOllamaTunnelInstructions({ ...parsed, sshTarget: parsed.sshTarget || "user@remote-host" })}`, display: true, details: { error: true } });
				return;
			}
			if (parsed.action === "help") {
				pi.sendMessage?.({ customType: "semantic-search", content: formatOllamaTunnelInstructions({ ...parsed, sshTarget: parsed.sshTarget || "user@remote-host" }), display: true, details: parsed });
				return;
			}
			if (parsed.action === "local") {
				const localUrl = useLocalOllama();
				ctx.ui.notify(`Using local Ollama at ${localUrl}`, "info");
				pi.sendMessage?.({ customType: "semantic-search", content: formatOllamaTunnelLocal(localUrl), display: true, details: { ...parsed, ollamaUrl: localUrl } });
				return;
			}
			if (parsed.action === "stop") {
				const result = await stopTunnel(parsed);
				const localUrl = useLocalOllama();
				ctx.ui.notify(result.killedPids.length > 0 ? "Ollama SSH tunnel stopped" : "Using local Ollama; no tunnel process found", result.error ? "warning" : "info");
				pi.sendMessage?.({ customType: "semantic-search", content: formatOllamaTunnelStopped(result, localUrl), display: true, details: { ...parsed, ...result, ollamaUrl: localUrl } });
				return;
			}
			if (parsed.action === "status") {
				const text = await formatOllamaTunnelStatus(parsed);
				ctx.ui.notify(text.includes("succeeded") ? "Ollama reachable" : "Ollama not reachable", text.includes("succeeded") ? "info" : "warning");
				pi.sendMessage?.({ customType: "semantic-search", content: text, display: true, details: parsed });
				return;
			}
			if (parsed.printOnly) {
				pi.sendMessage?.({ customType: "semantic-search", content: formatOllamaTunnelInstructions(parsed), display: true, details: parsed });
				return;
			}

			const { result, config: tunnelConfig, attemptedPorts } = await startOllamaTunnelWithFallback(startTunnel, parsed);
			if (!result.ok) {
				ctx.ui.notify("Ollama SSH tunnel failed to start", "error");
				pi.sendMessage?.({ customType: "semantic-search", content: [`Failed to start Ollama SSH tunnel.`, `Error: ${result.error ?? "unknown error"}`, "", "Command:", `  ${result.command}`, "", `Attempted local ports: ${attemptedPorts.join(", ")}`, "", "Notes:", "  Requires SSH key/agent auth because the command uses BatchMode=yes.", parsed.localPortExplicit ? "  The requested --local-port is busy or unavailable; choose another port." : "  Default port 11434 can be busy when local Ollama is running; Pi will auto-try 11435-11444."].join("\n"), display: true, details: { ...parsed, localPort: tunnelConfig.localPort, attemptedPorts, error: result.error } });
				return;
			}

			process.env.OLLAMA_BASE_URL = result.ollamaUrl;
			ctx.ui.notify(`Ollama SSH tunnel ready at ${result.ollamaUrl}`, "info");
			pi.sendMessage?.({ customType: "semantic-search", content: formatOllamaTunnelStarted(result, attemptedPorts), display: true, details: { ...parsed, localPort: tunnelConfig.localPort, attemptedPorts, ollamaUrl: result.ollamaUrl } });
		},
	});

	pi.registerTool({
		name: "semantic_search",
		label: "Semantic Search",
		description:
			"Search the current project with a required local Ollama-backed hybrid index: generated semantic-card summaries, embeddings, lexical terms, code concepts, symbols, and paths. " +
			"Returns ranked files/snippets with line ranges. Builds or refreshes the higher-quality index automatically by default.",
		promptSnippet: "Search project code semantically and return ranked file snippets with line ranges",
		promptGuidelines: [
			"Use semantic_search when you do not know which files contain a feature, concept, workflow, or behavior before falling back to read/grep.",
			"After semantic_search returns candidates, use read on the reported path and line range before editing.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Natural-language query, feature name, behavior, symbol, or error concept to find." }),
			topK: Type.Optional(Type.Number({ description: `Maximum results to return (default ${DEFAULT_TOP_K}, max ${MAX_TOP_K}).`, minimum: 1, maximum: MAX_TOP_K })),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Optional path prefixes/substrings to constrain search, e.g. ['extensions/prompt-queue', 'docs/']." })),
			includeTests: Type.Optional(Type.Boolean({ description: "Whether test files may appear in results. Defaults to true." })),
			refresh: Type.Optional(Type.Boolean({ description: "Refresh a missing/stale index before searching. Defaults to true." })),
			useEmbeddings: Type.Optional(Type.Boolean({ description: "Use required local Ollama embeddings. Defaults to true; set false only for explicit lower-quality lexical/debug search." })),
			useSummaries: Type.Optional(Type.Boolean({ description: "Generate required Ollama summaries for semantic cards when rebuilding an embedding index. Defaults to true; set false only for explicit lower-quality/debug rebuilds." })),
			embeddingModel: Type.Optional(Type.String({ description: `Ollama embedding model to use. Defaults to ${configuredEmbeddingModel} from config or OLLAMA_EMBED_MODEL.` })),
			summaryModel: Type.Optional(Type.String({ description: `Ollama generation model for semantic-card summaries. Defaults to ${configuredSummaryModel} from config or PI_SEMANTIC_SEARCH_SUMMARY_MODEL.` })),
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
			const ollama = { model: params.embeddingModel, baseUrl: params.ollamaUrl, maxInputChars: params.embeddingMaxChars };
			const summary = params.useSummaries === false ? false : { model: params.summaryModel, baseUrl: params.ollamaUrl };

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
					const ensured = await ensureIndexWithEmbeddings(ctx.cwd, params.refresh ?? true, ollama, signal, (message) => onUpdate?.({ content: [{ type: "text", text: message }], details: {} }), summary);
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
					if (signal?.aborted) throw error;
					throw new Error(formatOllamaRequirementFailure(error, { embeddingModel: params.embeddingModel, summaryModel: params.summaryModel, ollamaUrl: params.ollamaUrl, embeddingMaxChars: params.embeddingMaxChars }), { cause: error });
				}
			}

			let text = formatSearchResults(params.query, results, index);
			if (status.stale) text += `\n\nNote: index may be stale (${status.reason}). Run /index rebuild or call semantic_search with refresh=true.`;
			return {
				content: [{ type: "text" as const, text }],
				details: {
					query: params.query,
					rebuilt,
					embeddingUsed,
					index: { files: index.files.length, chunks: index.chunks.length, cards: index.cards.length, updatedAt: index.updatedAt, stale: status.stale, reason: status.reason, embedding: index.embedding, summary: index.summary },
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

	pi.registerTool({
		name: "index_rebuild_status",
		label: "Index Rebuild Status",
		description: "Monitor the last /index rebuild --background job, including running/finished/failed state, log path, and current index freshness.",
		promptSnippet: "Check semantic-search background rebuild status",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const status = getIndexStatus(ctx.cwd);
			const rebuild = currentBackgroundRebuildStatus(ctx.cwd);
			return {
				content: [{ type: "text" as const, text: formatBackgroundRebuildStatus(ctx.cwd, status) }],
				details: { index: status, rebuild },
			};
		},
	});
}
