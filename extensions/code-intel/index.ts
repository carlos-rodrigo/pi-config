import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_OUTPUT_CHARS = 30_000;
const MAX_FILE_BYTES = 512 * 1024;

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

const SOURCE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".mts",
	".cts",
	".py",
	".go",
	".rs",
	".java",
	".kt",
	".kts",
	".md",
	".mdx",
]);

const IMPORT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json"];

export type SymbolKind = "function" | "class" | "interface" | "type" | "enum" | "variable" | "method" | "command" | "tool" | "heading";

export type CodeSymbol = {
	name: string;
	kind: SymbolKind;
	path: string;
	line: number;
	signature: string;
	score?: number;
};

export type SymbolSearchOptions = {
	query: string;
	kind?: SymbolKind;
	paths?: string[];
	limit?: number;
};

export type DependencyGraph = {
	cwd: string;
	files: string[];
	nodes: Record<string, { imports: string[]; importedBy: string[]; external: string[] }>;
};

export type GitPickaxeMode = "string" | "regex";

export type GitPickaxeResult = {
	hash: string;
	shortHash: string;
	date: string;
	author: string;
	subject: string;
};

export type AstSearchOptions = {
	pattern: string;
	lang?: string;
	paths?: string[];
	limit?: number;
};

export type CodeFindIntent = "auto" | "exact" | "symbol" | "semantic" | "impact" | "history" | "structure";
export type CodeFindStrategy = "exact" | "symbol" | "semantic" | "impact" | "history" | "structure";

export type CodeFindOptions = {
	query: string;
	intent?: CodeFindIntent;
	path?: string;
	paths?: string[];
	limit?: number;
	useSemantic?: boolean;
	useEmbeddings?: boolean;
};

export type CodeFindResult = {
	strategies: CodeFindStrategy[];
	path?: string;
	line?: number;
	endLine?: number;
	title: string;
	reason: string;
	preview?: string;
	score: number;
};

export type CodeFindReport = {
	query: string;
	intent: CodeFindIntent;
	strategies: CodeFindStrategy[];
	results: CodeFindResult[];
	notes: string[];
};

function normalizeRelativePath(path: string): string {
	return path.split(sep).join("/").replace(/^\.\//, "").replace(/^@/, "");
}

function shouldSkipPath(relativePath: string): boolean {
	const normalized = normalizeRelativePath(relativePath);
	if (!normalized) return true;
	const parts = normalized.split("/");
	if (parts.some((part) => SKIP_DIRS.has(part))) return true;
	if (SKIP_EXTENSIONS.has(extname(normalized).toLowerCase())) return true;
	return false;
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

function clampLimit(limit: number | undefined): number {
	return Math.min(Math.max(Math.floor(limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
}

function pathMatches(path: string, filters: string[] | undefined): boolean {
	if (!filters || filters.length === 0) return true;
	return filters.some((filter) => {
		const normalized = normalizeRelativePath(filter.trim());
		return normalized.length > 0 && (path === normalized || path.startsWith(`${normalized}/`) || path.includes(normalized));
	});
}

function walkFiles(cwd: string, current = ""): string[] {
	const directory = current ? join(cwd, current) : cwd;
	const files: string[] = [];
	let entries: ReturnType<typeof readdirSync>;
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch {
		return files;
	}

	for (const entry of entries) {
		const relativePath = normalizeRelativePath(current ? join(current, entry.name) : entry.name);
		if (shouldSkipPath(relativePath)) continue;
		if (entry.isDirectory()) files.push(...walkFiles(cwd, relativePath));
		else if (entry.isFile()) files.push(relativePath);
	}
	return files;
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
		// Not a git checkout or git unavailable. Fall back to recursive discovery.
	}
	if (files.size === 0) for (const file of walkFiles(cwd)) files.add(file);
	return [...files].sort((a, b) => a.localeCompare(b));
}

function readTextFile(cwd: string, path: string): string | undefined {
	const fullPath = join(cwd, path);
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(fullPath);
	} catch {
		return undefined;
	}
	if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
	const buffer = readFileSync(fullPath);
	if (isLikelyBinary(buffer)) return undefined;
	return buffer.toString("utf8");
}

function sourceFiles(cwd: string, paths?: string[]): string[] {
	return discoverProjectFiles(cwd).filter((path) => SOURCE_EXTENSIONS.has(extname(path).toLowerCase()) && pathMatches(path, paths));
}

function addSymbol(out: CodeSymbol[], path: string, line: number, kind: SymbolKind, name: string | undefined, signature: string): void {
	if (!name) return;
	out.push({ name, kind, path, line, signature: signature.trim() });
}

export function extractSymbolsFromText(path: string, text: string): CodeSymbol[] {
	const symbols: CodeSymbol[] = [];
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const trimmed = line.trim();
		const lineNumber = index + 1;

		addSymbol(symbols, path, lineNumber, "heading", trimmed.match(/^#{1,6}\s+(.+)$/)?.[1]?.trim(), trimmed);
		addSymbol(symbols, path, lineNumber, "function", trimmed.match(/(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/)?.[1], trimmed);
		addSymbol(symbols, path, lineNumber, "class", trimmed.match(/(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/)?.[1], trimmed);
		addSymbol(symbols, path, lineNumber, "interface", trimmed.match(/(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/)?.[1], trimmed);
		addSymbol(symbols, path, lineNumber, "type", trimmed.match(/(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/)?.[1], trimmed);
		addSymbol(symbols, path, lineNumber, "enum", trimmed.match(/(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/)?.[1], trimmed);

		const variable = trimmed.match(/(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
		if (variable?.[1]) {
			const kind: SymbolKind = /=>|function\s*\(/.test(trimmed) ? "function" : "variable";
			addSymbol(symbols, path, lineNumber, kind, variable[1], trimmed);
		}

		addSymbol(symbols, path, lineNumber, "command", trimmed.match(/registerCommand\(\s*["']([^"']+)["']/)?.[1], trimmed);
		addSymbol(symbols, path, lineNumber, "tool", trimmed.match(/name\s*:\s*["']([A-Za-z0-9_.:-]+)["']/)?.[1], trimmed);
	}
	return symbols;
}

function symbolScore(symbol: CodeSymbol, query: string): number {
	const q = query.toLowerCase().trim();
	const name = symbol.name.toLowerCase();
	const path = symbol.path.toLowerCase();
	const signature = symbol.signature.toLowerCase();
	let score = 0;
	if (name === q) score += 100;
	if (name.startsWith(q)) score += 80;
	if (name.includes(q)) score += 60;
	if (path.includes(q)) score += 24;
	if (signature.includes(q)) score += 16;
	for (const part of q.split(/\s+/).filter(Boolean)) {
		if (name.includes(part)) score += 12;
		if (path.includes(part)) score += 6;
		if (signature.includes(part)) score += 4;
	}
	return score;
}

export function searchSymbols(cwd: string, options: SymbolSearchOptions): CodeSymbol[] {
	const absoluteCwd = resolve(cwd);
	const query = options.query.trim();
	if (!query) return [];
	const results: CodeSymbol[] = [];
	for (const file of sourceFiles(absoluteCwd, options.paths)) {
		const text = readTextFile(absoluteCwd, file);
		if (text === undefined) continue;
		for (const symbol of extractSymbolsFromText(file, text)) {
			if (options.kind && symbol.kind !== options.kind) continue;
			const score = symbolScore(symbol, query);
			if (score <= 0) continue;
			results.push({ ...symbol, score });
		}
	}
	return results
		.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.path.localeCompare(b.path) || a.line - b.line)
		.slice(0, clampLimit(options.limit));
}

export function formatSymbolResults(query: string, results: CodeSymbol[]): string {
	if (results.length === 0) return `No symbols found for "${query}".`;
	return [
		`Symbol results for "${query}" (${results.length} shown):`,
		"",
		...results.map((result, index) => {
			const score = typeof result.score === "number" ? ` score ${result.score.toFixed(0)}` : "";
			return `${index + 1}. ${result.path}:${result.line} ${result.kind} ${result.name}${score}\n   ${result.signature}`;
		}),
	].join("\n");
}

function extractImportSpecifiers(text: string): string[] {
	const specs = new Set<string>();
	const patterns = [
		/import\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
		/export\s+(?:type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["']/g,
		/require\(\s*["']([^"']+)["']\s*\)/g,
		/import\(\s*["']([^"']+)["']\s*\)/g,
	];
	for (const pattern of patterns) {
		for (const match of text.matchAll(pattern)) if (match[1]) specs.add(match[1]);
	}
	return [...specs];
}

function isRelativeImport(specifier: string): boolean {
	return specifier.startsWith("./") || specifier.startsWith("../");
}

function resolveLocalImport(fromPath: string, specifier: string, fileSet: Set<string>): string | undefined {
	if (!isRelativeImport(specifier)) return undefined;
	const base = normalizeRelativePath(join(dirname(fromPath), specifier));
	const candidates = [
		base,
		...IMPORT_EXTENSIONS.map((ext) => `${base}${ext}`),
		...IMPORT_EXTENSIONS.map((ext) => `${base}/index${ext}`),
	];
	return candidates.find((candidate) => fileSet.has(candidate));
}

export function buildDependencyGraph(cwd: string): DependencyGraph {
	const absoluteCwd = resolve(cwd);
	const files = sourceFiles(absoluteCwd).filter((path) => [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(extname(path).toLowerCase()));
	const fileSet = new Set(files);
	const nodes: DependencyGraph["nodes"] = {};

	for (const file of files) {
		const text = readTextFile(absoluteCwd, file) ?? "";
		const imports: string[] = [];
		const external: string[] = [];
		for (const specifier of extractImportSpecifiers(text)) {
			const resolved = resolveLocalImport(file, specifier, fileSet);
			if (resolved) imports.push(resolved);
			else if (!isRelativeImport(specifier)) external.push(specifier);
		}
		nodes[file] = { imports: [...new Set(imports)].sort(), external: [...new Set(external)].sort(), importedBy: [] };
	}

	for (const [file, node] of Object.entries(nodes)) {
		for (const dependency of node.imports) nodes[dependency]?.importedBy.push(file);
	}
	for (const node of Object.values(nodes)) node.importedBy.sort();
	return { cwd: absoluteCwd, files, nodes };
}

function resolveGraphTarget(graph: DependencyGraph, target: string | undefined): string | undefined {
	if (!target) return undefined;
	const normalized = normalizeRelativePath(target.trim());
	if (graph.nodes[normalized]) return normalized;
	return Object.keys(graph.nodes).find((path) => path === normalized || path.endsWith(`/${normalized}`) || path.includes(normalized));
}

export function formatDependencyMap(graph: DependencyGraph, target?: string): string {
	const resolved = resolveGraphTarget(graph, target);
	if (!resolved) {
		const ranked = Object.entries(graph.nodes)
			.map(([path, node]) => ({ path, degree: node.imports.length + node.importedBy.length, imports: node.imports.length, importedBy: node.importedBy.length }))
			.sort((a, b) => b.degree - a.degree || a.path.localeCompare(b.path))
			.slice(0, DEFAULT_LIMIT);
		return [
			`Dependency map (${graph.files.length} source files):`,
			"",
			...ranked.map((file, index) => `${index + 1}. ${file.path} — imports ${file.imports}, imported by ${file.importedBy}`),
		].join("\n");
	}

	const node = graph.nodes[resolved];
	const lines = [`Dependency map for ${resolved}:`, ""];
	lines.push("Imports:");
	if (node.imports.length === 0 && node.external.length === 0) lines.push("- none");
	for (const file of node.imports) lines.push(`- ${file}`);
	if (node.external.length > 0) lines.push(`- External: ${node.external.join(", ")}`);
	lines.push("", "Imported by:");
	if (node.importedBy.length === 0) lines.push("- none");
	for (const file of node.importedBy) lines.push(`- ${file}`);
	return lines.join("\n");
}

export function parseGitPickaxeLog(output: string): GitPickaxeResult[] {
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [hash = "", shortHash = "", date = "", author = "", subject = ""] = line.split("\x1f");
			return { hash, shortHash, date, author, subject };
		})
		.filter((entry) => entry.hash && entry.shortHash);
}

export function runGitPickaxe(cwd: string, query: string, mode: GitPickaxeMode, limit?: number, path?: string, allRefs = false): GitPickaxeResult[] {
	const args = [
		"log",
		`--max-count=${clampLimit(limit)}`,
		"--date=short",
		"--pretty=format:%H%x1f%h%x1f%ad%x1f%an%x1f%s",
		mode === "regex" ? `-G${query}` : `-S${query}`,
	];
	if (allRefs) args.push("--all");
	args.push("--");
	if (path) args.push(normalizeRelativePath(path));
	const output = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	return parseGitPickaxeLog(output);
}

export function formatGitPickaxeResults(query: string, mode: GitPickaxeMode, results: GitPickaxeResult[]): string {
	if (results.length === 0) return `No git ${mode} pickaxe commits found for "${query}".`;
	return [
		`Git ${mode} pickaxe results for "${query}" (${results.length} shown):`,
		"",
		...results.map((result, index) => `${index + 1}. ${result.shortHash} ${result.date} ${result.author}\n   ${result.subject}`),
	].join("\n");
}

function commandExists(command: string): boolean {
	try {
		execFileSync("command", ["-v", command], { stdio: "ignore" });
		return true;
	} catch {
		try {
			execFileSync("which", [command], { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	}
}

function resolveAstGrepBinary(): string | undefined {
	if (commandExists("sg")) return "sg";
	if (commandExists("ast-grep")) return "ast-grep";
	return undefined;
}

export function buildAstGrepArgs(options: AstSearchOptions): string[] {
	const args = ["--pattern", options.pattern];
	if (options.lang) args.push("--lang", options.lang);
	args.push("--json");
	for (const path of options.paths ?? []) args.push(normalizeRelativePath(path));
	return args;
}

function truncateText(text: string, maxChars = MAX_OUTPUT_CHARS): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	return { text: `${text.slice(0, maxChars).trimEnd()}\n…[truncated]`, truncated: true };
}

function runAstSearch(cwd: string, options: AstSearchOptions): string {
	const binary = resolveAstGrepBinary();
	if (!binary) {
		return "ast_search requires ast-grep CLI. Install it with `brew install ast-grep` or see https://ast-grep.github.io/.";
	}
	const args = buildAstGrepArgs(options);
	const output = execFileSync(binary, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	const truncated = truncateText(output || "No ast-grep matches.");
	return truncated.truncated ? `${truncated.text}\nOutput truncated.` : truncated.text;
}

function queryLooksLikeIdentifier(query: string): boolean {
	return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|::[A-Za-z_$][\w$]*)*$/.test(query.trim());
}

function queryLooksStructural(query: string): boolean {
	return /\$[A-Za-z_]|\$\$\$|=>|\bimport\b|\brequire\(|\{.*\}/.test(query);
}

export function inferCodeFindStrategies(options: Pick<CodeFindOptions, "query" | "intent" | "path" | "useSemantic">): CodeFindStrategy[] {
	const intent = options.intent ?? "auto";
	if (intent === "exact") return ["exact"];
	if (intent === "symbol") return ["symbol", "exact"];
	if (intent === "semantic") return ["semantic", "exact", "symbol"];
	if (intent === "impact") return ["impact"];
	if (intent === "history") return ["history", "exact", "symbol"];
	if (intent === "structure") return ["structure", "exact", "symbol"];

	const query = options.query.toLowerCase();
	let strategies: CodeFindStrategy[];
	if (/\b(why|when|history|commit|changed|change|regression|introduced|removed|renamed)\b/.test(query)) {
		strategies = ["semantic", "history", "exact", "symbol"];
	} else if (options.path && /\b(impact|depend|import|shared|break|affected)\b/.test(query)) {
		strategies = ["impact", "exact", "symbol"];
	} else if (queryLooksStructural(options.query)) {
		strategies = ["structure", "exact", "symbol"];
	} else if (queryLooksLikeIdentifier(options.query)) {
		strategies = ["exact", "symbol", "semantic"];
	} else {
		strategies = ["semantic", "exact", "symbol"];
	}
	return options.useSemantic === false ? strategies.filter((strategy) => strategy !== "semantic") : strategies;
}

function exactSearch(cwd: string, options: CodeFindOptions): CodeFindResult[] {
	const query = options.query.trim();
	if (!query) return [];
	const phrase = query.replace(/^"|"$/g, "").toLowerCase();
	const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9_$]+/i).filter((term) => term.length >= 3))];
	const results: CodeFindResult[] = [];

	for (const file of sourceFiles(resolve(cwd), options.paths)) {
		const text = readTextFile(cwd, file);
		if (!text) continue;
		const lines = text.split("\n");
		for (let index = 0; index < lines.length; index++) {
			const rawLine = lines[index];
			const line = rawLine.toLowerCase();
			let score = line.includes(phrase) ? 120 : 0;
			const matchedTerms = terms.filter((term) => line.includes(term));
			if (score === 0 && matchedTerms.length > 0) score = matchedTerms.length * 12;
			if (score === 0) continue;
			results.push({
				strategies: ["exact"],
				path: file,
				line: index + 1,
				title: matchedTerms.length > 0 ? `matched ${matchedTerms.join(", ")}` : `matched "${query}"`,
				reason: "literal text match",
				preview: rawLine.trim(),
				score,
			});
		}
	}

	return results.sort((a, b) => b.score - a.score || (a.path ?? "").localeCompare(b.path ?? "") || (a.line ?? 0) - (b.line ?? 0)).slice(0, clampLimit(options.limit));
}

async function semanticFind(cwd: string, options: CodeFindOptions, notes: string[]): Promise<CodeFindResult[]> {
	try {
		const semantic = await import("../semantic-search/index.ts");
		let index = semantic.loadSearchIndex(cwd) ?? semantic.buildSearchIndex(cwd, { writeToDisk: true });
		let semanticResults: Array<{ path: string; startLine: number; endLine: number; score: number; reason: string[]; symbols: string[]; preview: string }>;
		if (options.useEmbeddings) {
			try {
				index = await semantic.buildSearchIndexWithEmbeddings(cwd, { writeToDisk: true });
				semanticResults = (await semantic.searchIndexWithEmbeddings(index, { query: options.query, topK: options.limit, paths: options.paths })).results;
			} catch (error) {
				notes.push(`Ollama semantic embeddings unavailable; used lexical semantic index (${error instanceof Error ? error.message : String(error)}).`);
				semanticResults = semantic.searchIndex(index, { query: options.query, topK: options.limit, paths: options.paths });
			}
		} else {
			semanticResults = semantic.searchIndex(index, { query: options.query, topK: options.limit, paths: options.paths });
		}
		return semanticResults.map((result) => ({
			strategies: ["semantic"],
			path: result.path,
			line: result.startLine,
			endLine: result.endLine,
			title: result.symbols[0] ?? `${result.path}:${result.startLine}-${result.endLine}`,
			reason: result.reason.join("; "),
			preview: result.preview,
			score: result.score * 100,
		}));
	} catch (error) {
		notes.push(`semantic_search unavailable (${error instanceof Error ? error.message : String(error)}).`);
		return [];
	}
}

function symbolFind(cwd: string, options: CodeFindOptions): CodeFindResult[] {
	return searchSymbols(cwd, { query: options.query, paths: options.paths, limit: options.limit }).map((symbol) => ({
		strategies: ["symbol"],
		path: symbol.path,
		line: symbol.line,
		title: `${symbol.kind} ${symbol.name}`,
		reason: "symbol name/path/signature match",
		preview: symbol.signature,
		score: symbol.score ?? 0,
	}));
}

function impactFind(cwd: string, options: CodeFindOptions): CodeFindResult[] {
	const graph = buildDependencyGraph(cwd);
	const text = formatDependencyMap(graph, options.path);
	return [{
		strategies: ["impact"],
		path: options.path ? normalizeRelativePath(options.path) : undefined,
		title: options.path ? `dependency impact for ${normalizeRelativePath(options.path)}` : "dependency graph overview",
		reason: "import graph impact analysis",
		preview: text,
		score: 80,
	}];
}

function historyFind(cwd: string, options: CodeFindOptions, notes: string[]): CodeFindResult[] {
	try {
		return runGitPickaxe(cwd, options.query, "string", options.limit, options.path).map((commit) => ({
			strategies: ["history"],
			title: `${commit.shortHash} ${commit.subject}`,
			reason: `${commit.date} ${commit.author}`,
			preview: commit.hash,
			score: 70,
		}));
	} catch (error) {
		notes.push(`git_pickaxe unavailable (${error instanceof Error ? error.message : String(error)}).`);
		return [];
	}
}

function structureFind(cwd: string, options: CodeFindOptions, notes: string[]): CodeFindResult[] {
	const text = runAstSearch(cwd, { pattern: options.query, paths: options.paths, limit: options.limit });
	if (/requires ast-grep CLI|No ast-grep matches/i.test(text)) notes.push(text);
	return [{ strategies: ["structure"], title: "ast-grep structural search", reason: "structural code pattern", preview: text, score: 60 }];
}

function addCodeFindResult(map: Map<string, CodeFindResult>, result: CodeFindResult): void {
	const key = `${result.path ?? "<global>"}:${result.line ?? 0}:${result.endLine ?? 0}:${result.title}`;
	const existing = map.get(key);
	if (!existing) {
		map.set(key, { ...result, strategies: [...result.strategies] });
		return;
	}
	existing.strategies = [...new Set([...existing.strategies, ...result.strategies])];
	existing.score = Math.max(existing.score, result.score);
	if (!existing.preview && result.preview) existing.preview = result.preview;
	existing.reason = [...new Set([existing.reason, result.reason])].join("; ");
}

export async function codeFind(cwd: string, options: CodeFindOptions): Promise<CodeFindReport> {
	const intent = options.intent ?? "auto";
	const strategies = inferCodeFindStrategies(options);
	const notes: string[] = [];
	const results = new Map<string, CodeFindResult>();

	for (const strategy of strategies) {
		if (strategy === "exact") for (const result of exactSearch(cwd, options)) addCodeFindResult(results, result);
		else if (strategy === "symbol") for (const result of symbolFind(cwd, options)) addCodeFindResult(results, result);
		else if (strategy === "semantic") for (const result of await semanticFind(cwd, options, notes)) addCodeFindResult(results, result);
		else if (strategy === "impact") for (const result of impactFind(cwd, options)) addCodeFindResult(results, result);
		else if (strategy === "history") for (const result of historyFind(cwd, options, notes)) addCodeFindResult(results, result);
		else if (strategy === "structure") for (const result of structureFind(cwd, options, notes)) addCodeFindResult(results, result);
	}

	return {
		query: options.query,
		intent,
		strategies,
		notes,
		results: [...results.values()]
			.sort((a, b) => b.score - a.score || (a.path ?? "").localeCompare(b.path ?? "") || (a.line ?? 0) - (b.line ?? 0))
			.slice(0, clampLimit(options.limit)),
	};
}

export function formatCodeFindResults(report: CodeFindReport): string {
	const lines = [
		`Code find results for "${report.query}" (${report.results.length} shown):`,
		`Strategies: ${report.strategies.join(", ")}`,
	];
	if (report.notes.length > 0) {
		lines.push("", "Notes:");
		for (const note of report.notes) lines.push(`- ${note}`);
	}
	if (report.results.length === 0) {
		lines.push("", "No candidates found. Try semantic_search for broader concept search or grep/find for exact terms.");
		return lines.join("\n");
	}
	lines.push("");
	for (const [index, result] of report.results.entries()) {
		const location = result.path ? `${result.path}${result.line ? `:${result.line}${result.endLine && result.endLine !== result.line ? `-${result.endLine}` : ""}` : ""}` : "project";
		lines.push(`${index + 1}. [${result.strategies.join("+")}] ${location} — ${result.title}`);
		lines.push(`   Why: ${result.reason}`);
		if (result.preview) {
			const preview = truncateText(result.preview, 900).text;
			for (const line of preview.split("\n").slice(0, 8)) lines.push(`   ${line}`);
		}
	}
	return lines.join("\n");
}

export default function codeIntelExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "code_find",
		label: "Code Find",
		description: "Orchestrate the best local code search strategy: exact text, symbols, semantic index, dependency impact, git history, or AST structure.",
		promptSnippet: "Choose and run the best code search strategy for a query",
		promptGuidelines: [
			"Use code_find as the first search tool when you are unsure whether exact, symbol, semantic, dependency, history, or AST search is the best fit.",
			"After code_find returns candidates, use read on the reported path and line range before editing.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "What to find: exact text, symbol, feature concept, history question, dependency impact, or AST pattern." }),
			intent: Type.Optional(StringEnum(["auto", "exact", "symbol", "semantic", "impact", "history", "structure"] as const, { description: "Optional strategy hint. Defaults to auto." })),
			path: Type.Optional(Type.String({ description: "Optional target path for impact/history searches." })),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Optional path prefixes/substrings to constrain search." })),
			limit: Type.Optional(Type.Number({ description: `Maximum results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`, minimum: 1, maximum: MAX_LIMIT })),
			useSemantic: Type.Optional(Type.Boolean({ description: "Allow semantic index candidates in auto mode. Defaults to true." })),
			useEmbeddings: Type.Optional(Type.Boolean({ description: "Use Ollama embeddings for semantic candidates. Defaults to false for speed." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: `Finding code for: ${params.query}` }], details: {} });
			if (signal?.aborted) return { content: [{ type: "text" as const, text: "code_find cancelled." }], details: { cancelled: true } };
			const report = await codeFind(ctx.cwd, params as CodeFindOptions);
			return {
				content: [{ type: "text" as const, text: formatCodeFindResults(report) }],
				details: report,
			};
		},
	});

	pi.registerTool({
		name: "symbol_search",
		label: "Symbol Search",
		description: "Search project symbols by name/path/signature using local parsing. Best for functions, classes, types, commands, tools, and markdown headings.",
		promptSnippet: "Find functions, classes, types, commands, tools, and headings by symbol name",
		promptGuidelines: [
			"Use symbol_search when you know or can guess a function, class, type, command, tool, or heading name.",
			"After symbol_search returns candidates, use read on the reported path and line before editing.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Symbol name or partial name to search for." }),
			kind: Type.Optional(StringEnum(["function", "class", "interface", "type", "enum", "variable", "method", "command", "tool", "heading"] as const, { description: "Optional symbol kind filter." })),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Optional path prefixes/substrings to constrain search." })),
			limit: Type.Optional(Type.Number({ description: `Maximum results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`, minimum: 1, maximum: MAX_LIMIT })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const results = searchSymbols(ctx.cwd, params as SymbolSearchOptions);
			return {
				content: [{ type: "text" as const, text: formatSymbolResults(params.query, results) }],
				details: { query: params.query, results },
			};
		},
	});

	pi.registerTool({
		name: "dependency_map",
		label: "Dependency Map",
		description: "Build a local import graph. Shows direct imports and reverse dependents for a file, or high-degree files when no path is provided.",
		promptSnippet: "Inspect local import dependencies and reverse dependents",
		promptGuidelines: [
			"Use dependency_map before changing shared modules to understand import impact.",
		],
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Optional target file path. If omitted, shows high-degree files in the graph." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const graph = buildDependencyGraph(ctx.cwd);
			return {
				content: [{ type: "text" as const, text: formatDependencyMap(graph, params.path) }],
				details: { path: params.path, files: graph.files.length },
			};
		},
	});

	pi.registerTool({
		name: "git_pickaxe",
		label: "Git Pickaxe",
		description: "Search git history for commits that added/removed an exact string (-S) or regex (-G). Best for understanding when/why behavior changed.",
		promptSnippet: "Search git history for commits that touched a string or regex",
		promptGuidelines: [
			"Use git_pickaxe when current code is unclear and history may explain why a behavior exists or changed.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "String or regex to search in git history." }),
			mode: Type.Optional(StringEnum(["string", "regex"] as const, { description: "string uses git log -S; regex uses git log -G. Defaults to string." })),
			path: Type.Optional(Type.String({ description: "Optional path limit." })),
			limit: Type.Optional(Type.Number({ description: `Maximum commits (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`, minimum: 1, maximum: MAX_LIMIT })),
			allRefs: Type.Optional(Type.Boolean({ description: "Search all refs with --all. Defaults to false." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const mode = (params.mode ?? "string") as GitPickaxeMode;
				const results = runGitPickaxe(ctx.cwd, params.query, mode, params.limit, params.path, params.allRefs ?? false);
				return {
					content: [{ type: "text" as const, text: formatGitPickaxeResults(params.query, mode, results) }],
					details: { query: params.query, mode, results },
				};
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
					details: { error: true, query: params.query },
				};
			}
		},
	});

	pi.registerTool({
		name: "ast_search",
		label: "AST Search",
		description: "Run ast-grep structural search when the ast-grep CLI (`sg` or `ast-grep`) is installed. Best for code shapes, not plain text.",
		promptSnippet: "Run ast-grep structural code search for code patterns",
		promptGuidelines: [
			"Use ast_search for structural patterns such as function calls, object shapes, imports, or API usage when grep would be too noisy.",
		],
		parameters: Type.Object({
			pattern: Type.String({ description: "ast-grep pattern, e.g. console.log($A) or pi.registerTool($$$)." }),
			lang: Type.Optional(Type.String({ description: "ast-grep language, e.g. ts, tsx, js, python, rust." })),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Optional paths to search." })),
			limit: Type.Optional(Type.Number({ description: "Reserved for future output limiting. Current output is truncated by size.", minimum: 1, maximum: MAX_LIMIT })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const text = runAstSearch(ctx.cwd, params as AstSearchOptions);
				return { content: [{ type: "text" as const, text }], details: { pattern: params.pattern, lang: params.lang } };
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
					details: { error: true, pattern: params.pattern },
				};
			}
		},
	});
}
