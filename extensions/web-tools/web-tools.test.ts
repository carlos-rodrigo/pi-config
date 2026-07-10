import test from "node:test";
import assert from "node:assert/strict";

import webToolsExtension, {
	fetchPage,
	filterWebsearchResults,
	formatWebsearchResults,
	isPublicIpAddress,
	normalizeWebUrl,
	readResponseTextLimited,
	renderFetchedContent,
	resolveWebsearchProvider,
} from "./index.ts";

function registeredTools() {
	const tools = new Map<string, any>();
	webToolsExtension({
		registerTool(definition: any) {
			tools.set(definition.name, definition);
		},
	} as any);
	return tools;
}

test("webfetch rejects invalid URLs as tool failures", async () => {
	const tool = registeredTools().get("webfetch");
	await assert.rejects(tool.execute("call-1", { url: "ftp://example.com/file" }, undefined, undefined, {}), /Only http\/https URLs are allowed/);
});

test("webfetch blocks localhost targets before fetching", async () => {
	const tool = registeredTools().get("webfetch");
	await assert.rejects(tool.execute("call-2", { url: "https://127.0.0.1/private" }, undefined, undefined, {}), /private|local|public/i);
});

test("webfetch validates redirect targets and cancels redirect bodies", async () => {
	let calls = 0;
	let cancelled = false;
	const body = new ReadableStream({
		cancel() {
			cancelled = true;
		},
	});
	await assert.rejects(
		fetchPage("https://93.184.216.34/start", undefined, {
			request: async () => {
				calls += 1;
				return new Response(body, { status: 302, headers: { location: "https://localhost/secret" } });
			},
		}),
		/private|local|public/i,
	);
	assert.equal(calls, 1);
	assert.equal(cancelled, true);
});

test("webfetch pins the validated DNS address into the transport", async () => {
	let resolverCalls = 0;
	const page = await fetchPage("https://rebind.example/page", undefined, {
		resolveAddresses: async () => {
			resolverCalls += 1;
			return resolverCalls === 1
				? [{ address: "93.184.216.34", family: 4 }]
				: [{ address: "127.0.0.1", family: 4 }];
		},
		request: async (_url, pinned) => {
			assert.deepEqual(pinned, { address: "93.184.216.34", family: 4 });
			return new Response("safe", { status: 200, headers: { "content-type": "text/plain" } });
		},
	});
	assert.equal(page.body, "safe");
	assert.equal(resolverCalls, 1);
});

test("webfetch cancellation interrupts DNS resolution", async () => {
	const controller = new AbortController();
	const pending = fetchPage("https://slow-dns.example/page", controller.signal, {
		resolveAddresses: async (_hostname, signal) => new Promise((_, reject) => {
			signal?.addEventListener("abort", () => {
				const error = new Error("cancelled");
				error.name = "AbortError";
				reject(error);
			}, { once: true });
		}),
	});
	controller.abort();
	await assert.rejects(pending, (error: any) => error?.name === "AbortError");
});

test("webfetch cache stays bounded", async () => {
	let requests = 0;
	const dependencies = {
		resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 as const }],
		request: async () => {
			requests += 1;
			return new Response("cached", { status: 200, headers: { "content-type": "text/plain" } });
		},
	};
	for (let index = 0; index <= 100; index += 1) {
		await fetchPage(`https://cache-${index}.example/page`, undefined, dependencies);
	}
	await fetchPage("https://cache-0.example/page", undefined, dependencies);
	assert.equal(requests, 102);
});

test("webfetch honors an already-aborted tool signal", async () => {
	const controller = new AbortController();
	controller.abort();
	const tool = registeredTools().get("webfetch");
	await assert.rejects(
		tool.execute("call-4", { url: "https://93.184.216.34/" }, controller.signal, undefined, {}),
		(error: any) => error?.name === "AbortError",
	);
});

test("readResponseTextLimited stops buffering at the byte cap", async () => {
	const response = new Response("0123456789");
	const result = await readResponseTextLimited(response, 5);
	assert.equal(result.text, "01234");
	assert.equal(result.truncated, true);
});

test("public-address validation blocks IPv4-mapped loopback IPv6", () => {
	assert.equal(isPublicIpAddress("::ffff:7f00:1"), false);
	assert.equal(isPublicIpAddress("2606:4700:4700::1111"), true);
});

test("normalizeWebUrl upgrades http URLs to https", () => {
	assert.equal(normalizeWebUrl("http://example.com/docs"), "https://example.com/docs");
	assert.equal(normalizeWebUrl("https://example.com/docs"), "https://example.com/docs");
});

test("normalizeWebUrl rejects unsupported protocols", () => {
	assert.throws(() => normalizeWebUrl("ftp://example.com/file"), /Only http\/https URLs are allowed/i);
});

test("resolveWebsearchProvider mirrors opencode provider rules", () => {
	assert.equal(resolveWebsearchProvider("exa", { EXA_API_KEY: "exa-key" }), "exa");
	assert.equal(resolveWebsearchProvider("tavily", { TAVILY_API_KEY: "tavily-key" }), "tavily");
	assert.throws(() => resolveWebsearchProvider(undefined, {}), /EXA_API_KEY environment variable is required/i);
	assert.throws(() => resolveWebsearchProvider("tavily", {}), /TAVILY_API_KEY environment variable is required/i);
});

test("renderFetchedContent converts html into markdown and plain text", () => {
	const html = "<html><body><h1>Title</h1><p>Hello <strong>world</strong>.</p></body></html>";

	assert.match(renderFetchedContent(html, "text/html; charset=utf-8", "markdown"), /# Title/);
	assert.equal(renderFetchedContent(html, "text/html; charset=utf-8", "text"), "Title\n\nHello world.");
	assert.match(renderFetchedContent(html, "text/html; charset=utf-8", "html"), /<strong>world<\/strong>/);
});

test("filterWebsearchResults applies allowed and blocked domains", () => {
	const results = [
		{ title: "Allowed", url: "https://docs.example.com/page", snippet: "A" },
		{ title: "Blocked", url: "https://news.example.com/post", snippet: "B" },
		{ title: "Other", url: "https://other.dev/post", snippet: "C" },
	];

	assert.deepEqual(
		filterWebsearchResults(results, ["example.com"], ["news.example.com"]).map((result) => result.title),
		["Allowed"],
	);
});

test("formatWebsearchResults produces markdown-link summaries", () => {
	const text = formatWebsearchResults("pi web tools", "exa", [
		{
			title: "Pi Docs",
			url: "https://example.com/pi-docs",
			snippet: "Useful docs for web tools.",
			publishedDate: "2026-03-16",
			score: 0.91,
		},
	]);

	assert.match(text, /Web results for "pi web tools" \(exa\):/i);
	assert.match(text, /\[Pi Docs\]\(https:\/\/example.com\/pi-docs\)/);
	assert.match(text, /Snippet: Useful docs for web tools\./);
});
