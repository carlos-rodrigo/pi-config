import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import TurndownService from "turndown";

type WebfetchFormat = "text" | "markdown" | "html";
type WebsearchProvider = "exa" | "tavily";

type FetchedPage = {
	url: string;
	finalUrl: string;
	status: number;
	statusText: string;
	contentType: string;
	body: string;
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

async function fetchPage(url: string): Promise<FetchedPage> {
	const cached = fetchCache.get(url);
	if (cached && cached.expiresAt > Date.now()) {
		const { expiresAt: _expiresAt, ...rest } = cached;
		return { ...rest, cached: true };
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

	try {
		const response = await fetch(url, {
			method: "GET",
			redirect: "follow",
			headers: {
				accept: "text/markdown, text/html, application/xhtml+xml, text/plain;q=0.9, */*;q=0.1",
				"user-agent": "pi-config-web-tools/0.1",
			},
			signal: controller.signal,
		});

		const contentType = response.headers.get("content-type") ?? "";
		const body = await response.text();
		if (!isTextLikeContent(contentType, body)) {
			throw new Error(`Unsupported content type '${contentType || "unknown"}'.`);
		}

		const page = {
			url,
			finalUrl: response.url || url,
			status: response.status,
			statusText: response.statusText,
			contentType,
			body,
		};

		fetchCache.set(url, { ...page, expiresAt: Date.now() + WEBFETCH_CACHE_MS });
		return { ...page, cached: false };
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(`Timed out fetching ${url} after ${FETCH_TIMEOUT_MS}ms.`);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
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
): Promise<WebsearchResult[]> {
	const response = await fetch("https://api.exa.ai/search", {
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
	});

	if (!response.ok) {
		throw new Error(`Exa search failed with ${response.status} ${response.statusText}.`);
	}

	const payload = (await response.json()) as {
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
): Promise<WebsearchResult[]> {
	const response = await fetch("https://api.tavily.com/search", {
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
	});

	if (!response.ok) {
		throw new Error(`Tavily search failed with ${response.status} ${response.statusText}.`);
	}

	const payload = (await response.json()) as {
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
		async execute(_toolCallId, params) {
			try {
				const normalizedUrl = normalizeWebUrl(params.url);
				const format = (params.format ?? "markdown") as WebfetchFormat;
				const maxChars = Math.min(Math.max(params.maxChars ?? DEFAULT_WEBFETCH_MAX_CHARS, 500), MAX_WEBFETCH_MAX_CHARS);
				const page = await fetchPage(normalizedUrl);
				const rendered = renderFetchedContent(page.body, page.contentType, format);
				const truncated = truncateText(rendered, maxChars);

				const summary = [
					`Fetched ${page.finalUrl}`,
					`Status: ${page.status} ${page.statusText}`,
					`Content-Type: ${page.contentType || "unknown"}`,
					`Format: ${format}`,
					page.cached ? "Cache: hit" : "Cache: miss",
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
						truncated: truncated.truncated,
					},
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: { url: params.url, format: params.format ?? "markdown" },
					isError: true,
				};
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
		async execute(_toolCallId, params) {
			try {
				const provider = resolveWebsearchProvider(params.provider as WebsearchProvider | undefined);
				const limit = Math.min(Math.max(params.limit ?? DEFAULT_WEBSEARCH_LIMIT, 1), MAX_WEBSEARCH_LIMIT);
				const allowedDomains = params.allowed_domains?.map(normalizeDomain).filter(Boolean);
				const blockedDomains = params.blocked_domains?.map(normalizeDomain).filter(Boolean);

				const results =
					provider === "exa"
						? await searchExa(process.env.EXA_API_KEY!, params.query, limit, allowedDomains, blockedDomains)
						: await searchTavily(process.env.TAVILY_API_KEY!, params.query, limit, allowedDomains, blockedDomains);

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
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: {
						query: params.query,
						provider: params.provider ?? "exa",
					},
					isError: true,
				};
			}
		},
	});
}
