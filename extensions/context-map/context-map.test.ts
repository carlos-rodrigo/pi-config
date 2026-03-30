import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, parseSessionFile, parseSessionBranch, buildSessionChain } from "./lib/parse-session.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("estimateTokens", () => {
	it("returns at least 1 for non-empty strings", () => {
		assert.ok(estimateTokens("hi") >= 1);
	});

	it("returns 0 for empty strings", () => {
		assert.equal(estimateTokens(""), 0);
	});

	it("scales roughly with string length", () => {
		const short = estimateTokens("hello");
		const long = estimateTokens("hello".repeat(100));
		assert.ok(long > short);
	});
});

describe("parseSessionFile", () => {
	function writeTempSession(lines: any[]): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-map-test-"));
		const file = path.join(dir, "session.jsonl");
		fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
		return file;
	}

	it("returns null for nonexistent files", () => {
		assert.equal(parseSessionFile("/tmp/does-not-exist-12345.jsonl"), null);
	});

	it("parses a minimal session with user and assistant messages", () => {
		const file = writeTempSession([
			{ type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" },
			{
				type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "Hello world", timestamp: 1000 },
			},
			{
				type: "message", id: "m2", parentId: "m1", timestamp: "2026-01-01T00:00:02.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Hi there!" }],
					usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.01 } },
					timestamp: 2000,
				},
			},
		]);

		const result = parseSessionFile(file);
		assert.ok(result);
		assert.equal(result.sessionId, "s1");
		assert.equal(result.blocks.length, 2);
		assert.equal(result.blocks[0]!.kind, "user");
		assert.equal(result.blocks[0]!.label, "User");
		assert.equal(result.blocks[1]!.kind, "assistant");
		assert.ok(result.contextUsage);
		assert.equal(result.contextUsage.total, 15);
		assert.equal(result.contextUsage.cost, 0.01);

		fs.rmSync(path.dirname(file), { recursive: true });
	});

	it("splits assistant messages into thinking + text + tool calls", () => {
		const file = writeTempSession([
			{ type: "session", version: 3, id: "s2", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" },
			{
				type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "Let me think about this..." },
						{ type: "text", text: "Here's my answer" },
						{ type: "toolCall", id: "tc1", name: "Read", arguments: { path: "foo.ts" } },
					],
					usage: { input: 100, output: 50, totalTokens: 150 },
					timestamp: 1000,
				},
			},
		]);

		const result = parseSessionFile(file);
		assert.ok(result);
		assert.equal(result.blocks.length, 3);
		assert.equal(result.blocks[0]!.kind, "thinking");
		assert.equal(result.blocks[1]!.kind, "assistant");
		assert.equal(result.blocks[2]!.kind, "tool-call");
		assert.equal(result.blocks[2]!.label, "Read()");

		fs.rmSync(path.dirname(file), { recursive: true });
	});

	it("parses tool results with error flag", () => {
		const file = writeTempSession([
			{ type: "session", version: 3, id: "s3", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" },
			{
				type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z",
				message: {
					role: "toolResult", toolCallId: "tc1", toolName: "Bash",
					content: [{ type: "text", text: "command not found" }],
					isError: true, timestamp: 1000,
				},
			},
		]);

		const result = parseSessionFile(file);
		assert.ok(result);
		assert.equal(result.blocks.length, 1);
		assert.equal(result.blocks[0]!.kind, "tool-result");
		assert.equal(result.blocks[0]!.label, "Bash()");
		assert.equal(result.blocks[0]!.isError, true);

		fs.rmSync(path.dirname(file), { recursive: true });
	});

	it("parses compaction entries", () => {
		const file = writeTempSession([
			{ type: "session", version: 3, id: "s4", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" },
			{
				type: "compaction", id: "c1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z",
				summary: "Previously discussed X and Y", tokensBefore: 50000,
			},
		]);

		const result = parseSessionFile(file);
		assert.ok(result);
		assert.equal(result.blocks.length, 1);
		assert.equal(result.blocks[0]!.kind, "compaction");
		assert.ok(result.blocks[0]!.detail.includes("50000"));

		fs.rmSync(path.dirname(file), { recursive: true });
	});

	it("tracks parentSession for chain building", () => {
		const file = writeTempSession([
			{
				type: "session", version: 3, id: "s5",
				timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp",
				parentSession: "/tmp/parent.jsonl",
			},
		]);

		const result = parseSessionFile(file);
		assert.ok(result);
		assert.equal(result.parentSession, "/tmp/parent.jsonl");

		fs.rmSync(path.dirname(file), { recursive: true });
	});
});

describe("parseSessionBranch", () => {
	it("parses an in-memory branch array", () => {
		const branch = [
			{
				type: "message", id: "m1",
				message: { role: "user", content: "Hello", timestamp: 1000 },
			},
			{
				type: "message", id: "m2",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "World" }],
					usage: { input: 10, output: 5, totalTokens: 15 },
					timestamp: 2000,
				},
			},
			{
				type: "message", id: "m3",
				message: {
					role: "toolResult", toolCallId: "t1", toolName: "grep",
					content: [{ type: "text", text: "results" }],
					isError: false, timestamp: 3000,
				},
			},
		];

		const result = parseSessionBranch(branch, "test-id", "test-file");
		assert.equal(result.blocks.length, 3);
		assert.equal(result.blocks[0]!.kind, "user");
		assert.equal(result.blocks[1]!.kind, "assistant");
		assert.equal(result.blocks[2]!.kind, "tool-result");
		assert.equal(result.blocks[2]!.label, "grep()");
	});
});

describe("buildSessionChain", () => {
	it("follows parentSession links to build a chain", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-chain-test-"));
		const parent = path.join(dir, "parent.jsonl");
		const child = path.join(dir, "child.jsonl");

		fs.writeFileSync(parent, [
			JSON.stringify({ type: "session", version: 3, id: "p1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
			JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "First session", timestamp: 1000 } }),
		].join("\n"));

		fs.writeFileSync(child, [
			JSON.stringify({ type: "session", version: 3, id: "c1", timestamp: "2026-01-02T00:00:00.000Z", cwd: "/tmp", parentSession: parent }),
			JSON.stringify({ type: "message", id: "m2", parentId: null, timestamp: "2026-01-02T00:00:01.000Z", message: { role: "user", content: "Second session", timestamp: 2000 } }),
		].join("\n"));

		const chain = buildSessionChain(child);
		assert.equal(chain.length, 2);
		assert.equal(chain[0]!.sessionId, "p1"); // oldest first
		assert.equal(chain[1]!.sessionId, "c1");

		fs.rmSync(dir, { recursive: true });
	});

	it("handles missing parent gracefully", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-chain-test-"));
		const child = path.join(dir, "child.jsonl");

		fs.writeFileSync(child, JSON.stringify({
			type: "session", version: 3, id: "c1",
			timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp",
			parentSession: "/tmp/nonexistent.jsonl",
		}));

		const chain = buildSessionChain(child);
		assert.equal(chain.length, 1);
		assert.equal(chain[0]!.sessionId, "c1");

		fs.rmSync(dir, { recursive: true });
	});
});
