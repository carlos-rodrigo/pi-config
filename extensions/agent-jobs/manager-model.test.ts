import test from "node:test";
import assert from "node:assert/strict";
import { ForegroundRegistry, buildManagerSnapshot, sanitizeDisplay, boundedPreview, elapsed } from "./manager-model.ts";

const job = (jobId: string, overrides: Record<string, unknown> = {}) => ({
	jobId, agent: "researcher", task: "Inspect only", state: "running", cwd: "/project",
	createdAt: "2026-10-01T10:00:00Z", ...overrides,
});

test("merges foreground durable identity during launch and failure without duplicate rows", () => {
	const registry = new ForegroundRegistry();
	const run = registry.begin([{ agent: "researcher", task: "inspect", cwd: "/project" }]);
	registry.launching(run, 0);
	assert.equal(buildManagerSnapshot("/project", [], registry.entries(), "session").rows[0]?.state, "launching");
	registry.bind(run, 0, "job-1");
	assert.equal(buildManagerSnapshot("/project", [job("job-1")], registry.entries(), "session").rows.length, 1);
	registry.update(run, [{ state: "failed", output: "spawn failed" }]);
	const snapshot = buildManagerSnapshot("/project", [job("job-1", { state: "failed" })], registry.entries(), "session");
	assert.equal(snapshot.rows.length, 1);
	assert.equal(snapshot.rows[0]?.state, "failed");
	registry.finish(run);
	assert.equal(registry.entries().length, 0);
});

test("keeps all active jobs, limits recent, normalizes bad display fields and session origin", () => {
	const jobs = Array.from({ length: 30 }, (_, i) => job(`done-${i}`, { state: "completed", followUp: true, followUpSent: false }));
	jobs.push(...Array.from({ length: 25 }, (_, i) => job(`active-${i}`)));
	jobs.push(job("bad-display", { agent: 42, task: null, createdAt: [], model: {}, originSessionId: "session" }));
	const snapshot = buildManagerSnapshot("/project", jobs, [], "session");
	assert.equal(snapshot.running, 26);
	assert.equal(snapshot.rows.length, 46);
	const malformed = snapshot.rows.find(row => row.jobId === "bad-display")!;
	assert.equal(malformed.agent, "unknown agent");
	assert.equal(malformed.task, "Task unavailable");
	assert.equal(malformed.origin, "current");
	assert.equal(malformed.createdAt, undefined);
	assert.ok(snapshot.warnings.length > 0);
	assert.equal(buildManagerSnapshot("/project", [job("other", { originSessionId: "another" }), job("legacy")], [], "session").rows[0]?.origin, "unknown");
});

test("recent rows use completion time so a long-running job that just finished stays visible", () => {
	const olderCompletions = Array.from({ length: 20 }, (_, i) => job(`finished-${i}`, {
		state: "completed", createdAt: "2026-10-02T10:00:00Z", completedAt: "2026-10-02T11:00:00Z",
	}));
	const justFinished = job("long-running", { state: "completed", createdAt: "2026-10-01T10:00:00Z", completedAt: "2026-10-03T11:00:00Z" });
	const snapshot = buildManagerSnapshot("/project", [...olderCompletions, justFinished], []);
	assert.equal(snapshot.rows.length, 20);
	assert.equal(snapshot.rows[0]?.jobId, "long-running");
});

test("retains bounded pre-durable failures and marks unlaunched tasks cancelled at run end", () => {
	const registry = new ForegroundRegistry();
	for (let i = 0; i < 25; i++) {
		const run = registry.begin([{ agent: "missing", task: "inspect", cwd: "/project" }]);
		registry.update(run, [{ state: "failed", output: "unknown agent" }]);
		registry.finish(run);
	}
	assert.equal(registry.entries().length, 20);
	const run = registry.begin([{ agent: "researcher", task: "inspect", cwd: "/project" }]);
	registry.finish(run);
	assert.equal(registry.entries().filter(row => row.state === "cancelled").length, 1);
	assert.equal(registry.entries().length, 20);
});

test("strips terminal controls, including incomplete and unusual escape sequences", () => {
	for (const text of ["\x1bcRESET", "\x1b7save", "\x1b(Bfont", "\x1b]52;c;secret", "\x1b[31", "\x9b31mred", "\x00hello\x07"]) {
		assert.doesNotMatch(sanitizeDisplay(text), /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/);
	}
	assert.equal(sanitizeDisplay("\x1b[31mred\x1b[0m\nnext"), "red\nnext");
	assert.equal(sanitizeDisplay("a\n\tb", true), "a b");
	const preview = boundedPreview(Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n"));
	assert.ok(preview.split("\n").length <= 200);
	assert.match(preview, /truncated/i);
	assert.match(preview, /line 299/);
	assert.equal(elapsed(undefined, undefined, 1000), "unknown");
	assert.equal(elapsed(1000, 61000, 999000), "1m");
});
