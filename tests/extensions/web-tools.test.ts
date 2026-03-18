import test from "node:test";
import assert from "node:assert/strict";

import {
	filterWebsearchResults,
	formatWebsearchResults,
	normalizeWebUrl,
	renderFetchedContent,
	resolveWebsearchProvider,
} from "../../extensions/web-tools.ts";

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
