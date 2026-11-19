import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatterList } from "./agents.ts";
import { providerUnavailableReason } from "./model-fallback.ts";

// Shapes and texts copied from real failed jobs under .pi/agent-jobs/ (content and signatures trimmed).
const CLAUDE_FIVE_HOUR_LIMIT = "Claude quota exceeded — rate limit (five_hour) — resets 12:10:00 AM: You've hit your 5-hour limit · resets 12:10am (America/Buenos_Aires)";
const CHATGPT_SHARING_LIMIT = "The ChatGPT user has reached their Subscription Sharing usage limit. Ask the user to try again after their usage limit resets or use an API key instead.";
const UNKNOWN_MODEL_STDERR = 'Warning: No models match pattern "claude-bridge/claude-opus-5-5"\nError: Model "claude-bridge/no-such-model" not found. Use --list-models to see available models.\n';

function assistantEnd(stopReason: string, errorMessage?: string): string {
	return JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], api: "claude-bridge", provider: "claude-bridge", model: "claude-opus-5-5", stopReason, errorMessage } });
}

function partialRunThen(...lines: string[]): string {
	return [
		JSON.stringify({ type: "session" }),
		JSON.stringify({ type: "message_end", message: { role: "user", content: "Task" } }),
		assistantEnd("toolUse"),
		JSON.stringify({ type: "tool_execution_start" }),
		JSON.stringify({ type: "message_end", message: { role: "toolResult", content: "rate limit exceeded in a tool's own output", isError: true } }),
		...lines,
		JSON.stringify({ type: "agent_end" }),
	].join("\n");
}

test("frontmatter lists accept one model, comma-separated strings and YAML lists", () => {
	assert.deepEqual(parseFrontmatterList("claude-bridge/claude-opus-5-5:high"), ["claude-bridge/claude-opus-5-5:high"]);
	assert.deepEqual(parseFrontmatterList("claude-bridge/claude-opus-5-5:high, openai/gpt-6.1-sol:xhigh"), ["claude-bridge/claude-opus-5-5:high", "openai/gpt-6.1-sol:xhigh"]);
	assert.deepEqual(parseFrontmatterList([" a/one ", "b/two"]), ["a/one", "b/two"]);
	assert.deepEqual(parseFrontmatterList("a/one,, ,b/two"), ["a/one", "b/two"]);
	assert.deepEqual(parseFrontmatterList(["a/one", 7, null, ""]), ["a/one"]);
	assert.deepEqual(parseFrontmatterList(undefined), []);
	assert.deepEqual(parseFrontmatterList(42), []);
});

test("provider unavailability on the last assistant message falls back, including after a partial run", () => {
	const cases: Array<[string, string]> = [
		["Claude 5-hour quota", CLAUDE_FIVE_HOUR_LIMIT],
		["ChatGPT Subscription Sharing usage limit", CHATGPT_SHARING_LIMIT],
		["insufficient quota code", "429 insufficient_quota: You exceeded your current quota"],
		["rate limit", "Rate limit reached for requests"],
		["too many requests", "Too Many Requests"],
		["overloaded", '{"type":"overloaded_error","message":"Overloaded"}'],
		["service unavailable", "503 Service Unavailable"],
		["unauthorized", "401 Unauthorized: invalid x-api-key"],
		["missing credentials", "No API key found for provider openai"],
		["model unavailable", "The model `gpt-6.1-sol` does not exist or you do not have access to it."],
	];
	for (const [name, errorMessage] of cases) {
		assert.equal(providerUnavailableReason(partialRunThen(assistantEnd("error", errorMessage)), ""), errorMessage, name);
	}
});

test("a startup failure with no assistant message falls back only when pi's stderr names an unavailable model or credentials", () => {
	assert.equal(providerUnavailableReason("", UNKNOWN_MODEL_STDERR), 'Error: Model "claude-bridge/no-such-model" not found. Use --list-models to see available models.');
	assert.equal(providerUnavailableReason("", "Error: No API key found for provider anthropic\n"), "Error: No API key found for provider anthropic");
	assert.equal(providerUnavailableReason("", "TypeError: Cannot read properties of undefined\n    at main (cli.js:1:1)\n"), undefined, "crash");
	assert.equal(providerUnavailableReason("", 'Warning: No models match pattern "x"\n'), undefined, "warning alone");
	assert.equal(providerUnavailableReason("", ""), undefined, "killed with no output");
});

test("ordinary failures, cancellation, timeouts and successful work never fall back", () => {
	const cases: Array<[string, string, string]> = [
		["ordinary model error", partialRunThen(assistantEnd("error", "fixture failure")), ""],
		["context overflow", partialRunThen(assistantEnd("error", "prompt is too long: 250000 tokens > 200000 maximum")), ""],
		["provider timeout", partialRunThen(assistantEnd("error", "Request timed out.")), ""],
		["transport failure already retried by pi", partialRunThen(assistantEnd("error", "WebSocket error")), ""],
		["cancelled", partialRunThen(assistantEnd("aborted", "Request was aborted")), ""],
		["cancelled while the provider was rate limiting", partialRunThen(assistantEnd("aborted", "Rate limit reached; request aborted")), ""],
		["cancelled mid-tool after a quota error was retried", partialRunThen(assistantEnd("error", CLAUDE_FIVE_HOUR_LIMIT), assistantEnd("aborted")), ""],
		["success with a non-zero exit and quota text on stderr", partialRunThen(assistantEnd("stop")), CLAUDE_FIVE_HOUR_LIMIT],
		["tool output mentioning rate limits", partialRunThen(assistantEnd("stop")), ""],
		["malformed lines", "not json\n{\n", ""],
	];
	for (const [name, events, stderr] of cases) assert.equal(providerUnavailableReason(events, stderr), undefined, name);
});

test("the run.sh classifier exits 0 only for provider unavailability; unreadable logs or a crash mean no fallback", t => {
	const dir = mkdtempSync(join(tmpdir(), "model-fallback-cli-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const cli = fileURLToPath(new URL("./model-fallback-cli.ts", import.meta.url));
	const classify = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", ...args]).status;
	const quota = join(dir, "quota.jsonl");
	const ordinary = join(dir, "ordinary.jsonl");
	writeFileSync(quota, partialRunThen(assistantEnd("error", CLAUDE_FIVE_HOUR_LIMIT)));
	writeFileSync(ordinary, partialRunThen(assistantEnd("error", "fixture failure")));
	assert.equal(classify(cli, quota, join(dir, "missing.log")), 0, "quota");
	assert.equal(classify(cli, ordinary, ""), 1, "ordinary failure");
	assert.equal(classify(cli, join(dir, "missing.jsonl"), join(dir, "missing.log")), 1, "unreadable logs");
	assert.notEqual(classify(join(dir, "no-such-classifier.ts"), quota, ""), 0, "missing classifier");
});
