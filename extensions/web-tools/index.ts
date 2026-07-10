import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import TurndownService from "turndown";
import { lookup } from "node:dns";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

type WebfetchFormat = "text" | "markdown" | "html";
type WebsearchProvider = "exa" | "tavily";

type FetchedPage = {
	url: string;
	finalUrl: string;
	status: number;
	statusText: string;
	contentType: string;
	body: string;
	bodyTruncated: boolean;
	cached: boolean;
};

type WebsearchResult = {
	title: string;
	url: string;
	snippet?: string;
	publishedDate?: string;
	score?: number;
};

const FETCH_TIMEOUT_MS = 20_000;
const WEBFETCH_CACHE_MS = 5 * 60 * 1000;
const DEFAULT_WEBFETCH_MAX_CHARS = 20_000;
const MAX_WEBFETCH_MAX_CHARS = 100_000;
const DEFAULT_WEBSEARCH_LIMIT = 5;
const MAX_WEBSEARCH_LIMIT = 10;
const MAX_FETCH_BODY_BYTES = 1_000_000;
const MAX_API_BODY_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;
const MAX_FETCH_CACHE_ENTRIES = 100;

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type WebAddressResolver = (hostname: string, signal?: AbortSignal) => Promise<ResolvedAddress[]>;
export type PinnedWebRequest = (url: string, address: ResolvedAddress, init: RequestInit) => Promise<Response>;
export type WebRequestDependencies = { resolveAddresses?: WebAddressResolver; request?: PinnedWebRequest };

const fetchCache = new Map<string, Omit<FetchedPage, "cached"> & { expiresAt: number }>();

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
	bulletListMarker: "-",
});

turndown.remove(["script", "style", "noscript"]);

function isHtmlContent(contentType: string, body: string): boolean {
	return /text\/html|application\/xhtml\+xml/i.test(contentType) || /^\s*<!doctype html/i.test(body) || /^\s*<html[\s>]/i.test(body);
}

function isTextLikeContent(contentType: string, body: string): boolean {
	if (isHtmlContent(contentType, body)) return true;
	return (
		/^text\//i.test(contentType) ||
		/application\/(json|xml|javascript|x-javascript|markdown|x-markdown)/i.test(contentType) ||
		contentType.trim() === ""
	);
}

export function normalizeWebUrl(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) throw new Error("URL is required.");

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error(`Invalid URL: ${raw}`);
	}

	if (url.protocol === "http:") url.protocol = "https:";
	if (url.protocol !== "https:") {
		throw new Error(`Unsupported URL protocol '${url.protocol}'. Only http/https URLs are allowed.`);
	}

	return url.toString();
}

function abortError(): Error {
	const error = new Error("Web request cancelled.");
	error.name = "AbortError";
	return error;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}

function isPublicIpv4(address: string): boolean {
	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
	const [a, b] = parts;
	if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
	if (a === 100 && b >= 64 && b <= 127) return false;
	if (a === 169 && b === 254) return false;
	if (a === 172 && b >= 16 && b <= 31) return false;
	if (a === 192 && (b === 0 || b === 168)) return false;
	if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
	if (a === 203 && b === 0) return false;
	return true;
}

export function isPublicIpAddress(address: string): boolean {
	const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
	if (normalized.startsWith("::ffff:")) return isPublicIpv4(normalized.slice(7));
	const version = isIP(normalized);
	if (version === 4) return isPublicIpv4(normalized);
	if (version !== 6) return false;
	const firstHextet = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
	if (firstHextet < 0x2000 || firstHextet > 0x3fff) return false;
	return !normalized.startsWith("2001:db8:");
}

function resolveHostAddresses(hostname: string, signal?: AbortSignal): Promise<ResolvedAddress[]> {
	throwIfAborted(signal);
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error: Error | null, addresses?: ResolvedAddress[]) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve(addresses ?? []);
		};
		const onAbort = () => finish(abortError());
		signal?.addEventListener("abort", onAbort, { once: true });
		lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
			if (error) finish(error);
			else finish(null, addresses.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 })));
		});
	});
}

export async function resolvePublicWebAddress(
	url: string,
	signal?: AbortSignal,
	resolveAddresses: WebAddressResolver = resolveHostAddresses,
): Promise<ResolvedAddress> {
	const hostname = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
		throw new Error(`Refusing to fetch local hostname '${hostname}'.`);
	}
	if (isIP(hostname)) {
		if (!isPublicIpAddress(hostname)) throw new Error(`Refusing to fetch private or non-public address '${hostname}'.`);
		return { address: hostname, family: isIP(hostname) === 6 ? 6 : 4 };
	}
	const addresses = await resolveAddresses(hostname, signal);
	if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIpAddress(address))) {
		throw new Error(`Refusing to fetch hostname '${hostname}' because it resolves to a private or non-public address.`);
	}
	return addresses[0]!;
}

function requestPinnedUrl(url: string, pinned: ResolvedAddress, init: RequestInit): Promise<Response> {
	return new Promise((resolve, reject) => {
		const target = new URL(url);
		const headers = Object.fromEntries(new Headers(init.headers).entries());
		const options: RequestOptions = {
			protocol: target.protocol,
			hostname: target.hostname,
			port: target.port || undefined,
			path: `${target.pathname}${target.search}`,
			method: init.method ?? "GET",
			headers,
			signal: init.signal ?? undefined,
			lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
		};
		const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(options, (response) => {
			const responseHeaders = new Headers();
			for (const [name, value] of Object.entries(response.headers)) {
				if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
				else if (value !== undefined) responseHeaders.set(name, String(value));
			}
			resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
				status: response.statusCode ?? 500,
				statusText: response.statusMessage,
				headers: responseHeaders,
			}));
		});
		request.once("error", reject);
		if (typeof init.body === "string" || init.body instanceof Uint8Array) request.write(init.body);
		else if (init.body !== undefined && init.body !== null) {
			request.destroy(new Error("Unsupported request body type."));
			return;
		}
		request.end();
	});
}

async function cancelResponseBody(response: Response): Promise<void> {
	await response.body?.cancel().catch(() => undefined);
}

export async function readResponseTextLimited(
	response: Response,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
	throwIfAborted(signal);
	if (!response.body) return { text: "", truncated: false };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	try {
		while (true) {
			throwIfAborted(signal);
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			const remaining = maxBytes - total;
			if (value.byteLength > remaining) {
				if (remaining > 0) chunks.push(value.slice(0, remaining));
				total = maxBytes;
				truncated = true;
				await reader.cancel();
				break;
			}
			chunks.push(value);
			total += value.byteLength;
			if (total >= maxBytes) {
				const next = await reader.read();
				if (!next.done) truncated = true;
				await reader.cancel();
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}
	return { text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"), truncated };
}

function linkedAbortController(signal: AbortSignal | undefined, timeoutMs: number) {
	const controller = new AbortController();
	let timedOut = false;
	const onAbort = () => controller.abort();
	if (signal?.aborted) controller.abort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	return {
		controller,
		timedOut: () => timedOut,
		cleanup() {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

function decodeBasicHtmlEntities(text: string): string {
	return text
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'");
}

function markdownToText(markdown: string): string {
	return decodeBasicHtmlEntities(
		markdown
			.replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ""))
			.replace(/`([^`]+)`/g, "$1")
			.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1")
			.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
			.replace(/^\s{0,3}#{1,6}\s*/gm, "")
			.replace(/^\s*>\s?/gm, "")
			.replace(/^\s*[-*+]\s+/gm, "- ")
			.replace(/^\s*\d+\.\s+/gm, "")
			.replace(/[*_~]+/g, "")
			.replace(/\n{3,}/g, "\n\n")
			.trim(),
	);
}

export function renderFetchedContent(body: string, contentType: string, format: WebfetchFormat): string {
	const html = isHtmlContent(contentType, body);
	if (format === "html") return body.trim();
	if (!html) {
		return format === "text" ? markdownToText(body) : body.trim();
	}

	const markdown = turndown.turndown(body).trim();
	return format === "text" ? markdownToText(markdown) : markdown;
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	return {
		text: `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`,
		truncated: true,
	};
}

export async function fetchPage(url: string, signal?: AbortSignal, dependencies: WebRequestDependencies = {}): Promise<FetchedPage> {
	throwIfAborted(signal);
	const cached = fetchCache.get(url);
	if (cached && cached.expiresAt > Date.now()) {
		const { expiresAt: _expiresAt, ...rest } = cached;
		return { ...rest, cached: true };
	}
	if (cached) fetchCache.delete(url);

	const linked = linkedAbortController(signal, FETCH_TIMEOUT_MS);
	const resolveAddresses = dependencies.resolveAddresses ?? resolveHostAddresses;
	const request = dependencies.request ?? requestPinnedUrl;
	let currentUrl = url;
	try {
		for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
			const pinned = await resolvePublicWebAddress(currentUrl, linked.controller.signal, resolveAddresses);
			const response = await request(currentUrl, pinned, {
				method: "GET",
				redirect: "manual",
				headers: {
					accept: "text/markdown, text/html, application/xhtml+xml, text/plain;q=0.9, */*;q=0.1",
					"user-agent": "pi-config-web-tools/0.1",
				},
				signal: linked.controller.signal,
			});
			if ([301, 302, 303, 307, 308].includes(response.status)) {
				const location = response.headers.get("location");
				await cancelResponseBody(response);
				if (!location) throw new Error(`Redirect from ${currentUrl} did not include a Location header.`);
				if (redirects === MAX_REDIRECTS) throw new Error(`Too many redirects fetching ${url}.`);
				currentUrl = normalizeWebUrl(new URL(location, currentUrl).toString());
				continue;
			}

			const contentType = response.headers.get("content-type") ?? "";
			const bodyResult = await readResponseTextLimited(response, MAX_FETCH_BODY_BYTES, linked.controller.signal);
			if (!isTextLikeContent(contentType, bodyResult.text)) {
				throw new Error(`Unsupported content type '${contentType || "unknown"}'.`);
			}
			const page = {
				url,
				finalUrl: currentUrl,
				status: response.status,
				statusText: response.statusText,
				contentType,
				body: bodyResult.text,
				bodyTruncated: bodyResult.truncated,
			};
			const now = Date.now();
			for (const [key, entry] of fetchCache) if (entry.expiresAt <= now) fetchCache.delete(key);
			while (fetchCache.size >= MAX_FETCH_CACHE_ENTRIES) {
				const oldest = fetchCache.keys().next().value;
				if (oldest === undefined) break;
				fetchCache.delete(oldest);
			}
			fetchCache.set(url, { ...page, expiresAt: now + WEBFETCH_CACHE_MS });
			return { ...page, cached: false };
		}
		throw new Error(`Too many redirects fetching ${url}.`);
	} catch (error) {
		if (signal?.aborted) throw abortError();
		if (linked.timedOut() || (error instanceof Error && error.name === "AbortError")) {
			throw new Error(`Timed out fetching ${url} after ${FETCH_TIMEOUT_MS}ms.`);
		}
		throw error;
	} finally {
		linked.cleanup();
	}
}

async function fetchApiJson(url: string, init: RequestInit, signal?: AbortSignal): Promise<{ response: Response; payload: unknown }> {
	throwIfAborted(signal);
	const linked = linkedAbortController(signal, FETCH_TIMEOUT_MS);
	try {
		const pinned = await resolvePublicWebAddress(url, linked.controller.signal);
		const response = await requestPinnedUrl(url, pinned, { ...init, redirect: "manual", signal: linked.controller.signal });
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			await cancelResponseBody(response);
			throw new Error(`Refusing unexpected API redirect from ${url}.`);
		}
		const body = await readResponseTextLimited(response, MAX_API_BODY_BYTES, linked.controller.signal);
		if (body.truncated) throw new Error(`API response from ${url} exceeded ${MAX_API_BODY_BYTES} bytes.`);
		return { response, payload: body.text ? JSON.parse(body.text) : {} };
	} catch (error) {
		if (signal?.aborted) throw abortError();
		if (linked.timedOut() || (error instanceof Error && error.name === "AbortError")) {
			throw new Error(`Timed out calling ${url} after ${FETCH_TIMEOUT_MS}ms.`);
		}
		throw error;
	} finally {
		linked.cleanup();
	}
}

export function resolveWebsearchProvider(
	requested: WebsearchProvider | undefined,
	env: Record<string, string | undefined> = process.env,
): WebsearchProvider {
	const provider = requested ?? "exa";
	if (provider === "exa") {
		if (!env.EXA_API_KEY) {
			throw new Error("EXA_API_KEY environment variable is required for websearch provider=exa.");
		}
		return provider;
	}
	if (!env.TAVILY_API_KEY) {
		throw new Error("TAVILY_API_KEY environment variable is required for websearch provider=tavily.");
	}
	return provider;
}

function normalizeDomain(domain: string): string {
	return domain.trim().toLowerCase().replace(/^\.+/, "").replace(/^www\./, "");
}

function hostnameForUrl(url: string): string {
	try {
		return normalizeDomain(new URL(url).hostname);
	} catch {
		return "";
	}
}

function domainMatches(hostname: string, domain: string): boolean {
	return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function filterWebsearchResults(
	results: WebsearchResult[],
	allowedDomains?: string[],
	blockedDomains?: string[],
): WebsearchResult[] {
	const allowed = (allowedDomains ?? []).map(normalizeDomain).filter(Boolean);
	const blocked = (blockedDomains ?? []).map(normalizeDomain).filter(Boolean);

	return results.filter((result) => {
		const hostname = hostnameForUrl(result.url);
		if (!hostname) return false;
		if (allowed.length > 0 && !allowed.some((domain) => domainMatches(hostname, domain))) return false;
		if (blocked.some((domain) => domainMatches(hostname, domain))) return false;
		return true;
	});
}

function cleanSnippet(snippet: string | undefined): string | undefined {
	if (!snippet) return undefined;
	return snippet.replace(/\s+/g, " ").trim();
}

async function searchExa(
	apiKey: string,
	query: string,
	limit: number,
	allowedDomains?: string[],
	blockedDomains?: string[],
	signal?: AbortSignal,
): Promise<WebsearchResult[]> {
	const { response, payload: rawPayload } = await fetchApiJson("https://api.exa.ai/search", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": apiKey,
			"user-agent": "pi-config-web-tools/0.1",
		},
		body: JSON.stringify({
			query,
			numResults: limit,
			includeDomains: allowedDomains && allowedDomains.length > 0 ? allowedDomains : undefined,
			excludeDomains: blockedDomains && blockedDomains.length > 0 ? blockedDomains : undefined,
		}),
	}, signal);

	if (!response.ok) {
		throw new Error(`Exa search failed with ${response.status} ${response.statusText}.`);
	}

	const payload = rawPayload as {
		results?: Array<{
			title?: string;
			url?: string;
			text?: string;
			publishedDate?: string;
			score?: number;
		}>;
	};

	return (payload.results ?? [])
		.filter((item): item is NonNullable<typeof item> & { url: string } => typeof item?.url === "string")
		.map((item) => ({
			title: item.title?.trim() || item.url,
			url: item.url,
			snippet: cleanSnippet(item.text),
			publishedDate: item.publishedDate,
			score: item.score,
		}));
}

async function searchTavily(
	apiKey: string,
	query: string,
	limit: number,
	allowedDomains?: string[],
	blockedDomains?: string[],
	signal?: AbortSignal,
): Promise<WebsearchResult[]> {
	const { response, payload: rawPayload } = await fetchApiJson("https://api.tavily.com/search", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"user-agent": "pi-config-web-tools/0.1",
		},
		body: JSON.stringify({
			api_key: apiKey,
			query,
			max_results: limit,
			include_domains: allowedDomains && allowedDomains.length > 0 ? allowedDomains : undefined,
			exclude_domains: blockedDomains && blockedDomains.length > 0 ? blockedDomains : undefined,
			search_depth: "advanced",
		}),
	}, signal);

	if (!response.ok) {
		throw new Error(`Tavily search failed with ${response.status} ${response.statusText}.`);
	}

	const payload = rawPayload as {
		results?: Array<{
			title?: string;
			url?: string;
			content?: string;
			score?: number;
			published_date?: string;
		}>;
	};

	return (payload.results ?? [])
		.filter((item): item is NonNullable<typeof item> & { url: string } => typeof item?.url === "string")
		.map((item) => ({
			title: item.title?.trim() || item.url,
			url: item.url,
			snippet: cleanSnippet(item.content),
			publishedDate: item.published_date,
			score: item.score,
		}));
}

export function formatWebsearchResults(query: string, provider: WebsearchProvider, results: WebsearchResult[]): string {
	if (results.length === 0) {
		return `No web results found for \"${query}\" using ${provider}.`;
	}

	return [
		`Web results for \"${query}\" (${provider}):`,
		"",
		...results.map((result, index) => {
			const parts = [`${index + 1}. [${result.title}](${result.url})`];
			const hostname = hostnameForUrl(result.url);
			if (hostname) parts.push(`   Domain: ${hostname}`);
			if (result.publishedDate) parts.push(`   Published: ${result.publishedDate}`);
			if (typeof result.score === "number") parts.push(`   Score: ${result.score.toFixed(3)}`);
			if (result.snippet) parts.push(`   Snippet: ${truncateText(result.snippet, 400).text}`);
			return parts.join("\n");
		}),
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "webfetch",
		label: "Web Fetch",
		description: "Fetch web content from a URL. Returns text, markdown, or raw HTML. Read-only with a short cache window.",
		parameters: Type.Object({
			url: Type.String({ description: "The URL to fetch. http URLs are automatically upgraded to https." }),
			format: Type.Optional(
				StringEnum(["text", "markdown", "html"] as const, {
					description: "Output format. Prefer markdown unless raw HTML or plain text is required.",
				}),
			),
			maxChars: Type.Optional(
				Type.Number({
					description: `Maximum number of characters to return (default ${DEFAULT_WEBFETCH_MAX_CHARS}, max ${MAX_WEBFETCH_MAX_CHARS}).`,
					minimum: 500,
					maximum: MAX_WEBFETCH_MAX_CHARS,
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			try {
				const normalizedUrl = normalizeWebUrl(params.url);
				const format = (params.format ?? "markdown") as WebfetchFormat;
				const maxChars = Math.min(Math.max(params.maxChars ?? DEFAULT_WEBFETCH_MAX_CHARS, 500), MAX_WEBFETCH_MAX_CHARS);
				const page = await fetchPage(normalizedUrl, signal);
				const rendered = renderFetchedContent(page.body, page.contentType, format);
				const truncated = truncateText(rendered, maxChars);

				const summary = [
					`Fetched ${page.finalUrl}`,
					`Status: ${page.status} ${page.statusText}`,
					`Content-Type: ${page.contentType || "unknown"}`,
					`Format: ${format}`,
					page.cached ? "Cache: hit" : "Cache: miss",
					page.bodyTruncated ? `Body limit: truncated at ${MAX_FETCH_BODY_BYTES} bytes` : "Body limit: not reached",
					truncated.truncated ? `Truncated: yes (${maxChars} chars)` : "Truncated: no",
					"",
					truncated.text,
				].join("\n");

				return {
					content: [{ type: "text", text: summary }],
					details: {
						url: normalizedUrl,
						finalUrl: page.finalUrl,
						status: page.status,
						statusText: page.statusText,
						contentType: page.contentType,
						format,
						cached: page.cached,
						bodyTruncated: page.bodyTruncated,
						truncated: truncated.truncated,
					},
				};
			} catch (error) {
				throw error instanceof Error ? error : new Error(String(error));
			}
		},
	});

	pi.registerTool({
		name: "websearch",
		label: "Web Search",
		description: "Search the web using Opencode-style providers. Defaults to Exa and supports optional Tavily.",
		parameters: Type.Object({
			query: Type.String({ description: "The search query to run." }),
			provider: Type.Optional(
				StringEnum(["exa", "tavily"] as const, {
					description: "Search provider. Defaults to exa to mirror Opencode.",
				}),
			),
			allowed_domains: Type.Optional(
				Type.Array(Type.String({ description: "Only include results from these domains." }), {
					description: "Optional allowlist of result domains.",
				}),
			),
			blocked_domains: Type.Optional(
				Type.Array(Type.String({ description: "Exclude results from these domains." }), {
					description: "Optional blocklist of result domains.",
				}),
			),
			limit: Type.Optional(
				Type.Number({
					description: `Maximum number of results to return (default ${DEFAULT_WEBSEARCH_LIMIT}, max ${MAX_WEBSEARCH_LIMIT}).`,
					minimum: 1,
					maximum: MAX_WEBSEARCH_LIMIT,
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			try {
				const provider = resolveWebsearchProvider(params.provider as WebsearchProvider | undefined);
				const limit = Math.min(Math.max(params.limit ?? DEFAULT_WEBSEARCH_LIMIT, 1), MAX_WEBSEARCH_LIMIT);
				const allowedDomains = params.allowed_domains?.map(normalizeDomain).filter(Boolean);
				const blockedDomains = params.blocked_domains?.map(normalizeDomain).filter(Boolean);

				const results =
					provider === "exa"
						? await searchExa(process.env.EXA_API_KEY!, params.query, limit, allowedDomains, blockedDomains, signal)
						: await searchTavily(process.env.TAVILY_API_KEY!, params.query, limit, allowedDomains, blockedDomains, signal);

				const filtered = filterWebsearchResults(results, allowedDomains, blockedDomains).slice(0, limit);
				return {
					content: [{ type: "text", text: formatWebsearchResults(params.query, provider, filtered) }],
					details: {
						query: params.query,
						provider,
						count: filtered.length,
						results: filtered,
					},
				};
			} catch (error) {
				throw error instanceof Error ? error : new Error(String(error));
			}
		},
	});
}
