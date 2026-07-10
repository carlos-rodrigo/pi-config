import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const SELF_IMPROVEMENT_SCHEMA_VERSION = 1;
export const SELF_IMPROVEMENT_DIR = ".pi/self-improvement";
export const ARCHIVE_FILE = "archive.jsonl";
export const VERIFICATION_EVENT = "self-improvement:verification";
export const WARNING_EVENT = "self-improvement:warning";

const MAX_FAILURE_TEXT = 1_200;
const MAX_TOUCHED_FILES = 40;
const MAX_TOOL_FAILURES = 10;
const DEFAULT_LIMIT = 20;
const MAX_REPLAY_LITE_STEPS = 80;
const MAX_REPLAY_LITE_FILES = 5;
const MAX_REPLAY_LITE_SUMMARY = 240;

type ArchiveKind = "run" | "verification" | "warning" | "note";

type BenchmarkEvidence = {
	count: number;
	latest?: {
		id?: string;
		totalScore?: number;
		passed?: number;
		failed?: number;
		failures: string[];
	};
	errors: string[];
};

export type ReplayLiteStep = {
	type: "tool" | "verification" | "warning";
	name: string;
	status: "started" | "passed" | "failed" | "skipped" | "warning";
	atMs?: number;
	durationMs?: number;
	summary?: string;
	touchedFiles?: string[];
};

export type ReplayLite = {
	steps: ReplayLiteStep[];
	truncated?: boolean;
};

export type VerificationArchivePayload = {
	schemaVersion?: number;
	projectRoot: string;
	command: string;
	status: "passed" | "failed" | "skipped";
	durationMs?: number;
	failureSummary?: string;
	touchedPaths?: string[];
	trigger: "auto" | "manual" | "setup";
	timestamp?: string;
};

export type WarningArchivePayload = {
	type: string;
	message: string;
	toolName?: string;
	count?: number;
	timestamp?: string;
};

export type ArchiveRecord = {
	schemaVersion: 1;
	kind: ArchiveKind;
	timestamp: string;
	cwd?: string;
	sessionId?: string;
	durationMs?: number;
	model?: string;
	workflowMode?: string;
	prompt?: {
		chars: number;
		preview?: string;
	};
	toolCounts?: Record<string, number>;
	toolFailures?: Array<{ toolName: string; message: string }>;
	touchedFiles?: string[];
	replayLite?: ReplayLite;
	verification?: VerificationArchivePayload;
	warning?: WarningArchivePayload;
	note?: string;
};

export type ArchiveReadResult = {
	path: string;
	records: ArchiveRecord[];
	errors: string[];
};

export type ArchiveSummary = {
	totalRecords: number;
	runs: number;
	verifications: number;
	warnings: number;
	notes: number;
	failedVerifications: number;
	passedVerifications: number;
	toolFailures: number;
	topTools: Array<{ name: string; count: number }>;
	topTouchedFiles: Array<{ path: string; count: number }>;
	recentFailures: ArchiveRecord[];
	recentWarnings: ArchiveRecord[];
	lastRun?: ArchiveRecord;
};

type RunState = {
	startedAt: number;
	sessionId?: string;
	cwd: string;
	prompt?: string;
	model?: string;
	workflowMode?: string;
	toolCounts: Record<string, number>;
	toolFailures: Array<{ toolName: string; message: string }>;
	touchedFiles: Set<string>;
	replayLite: ReplayLite;
	pendingToolSteps: Map<string, number[]>;
};

function isoNow(): string {
	return new Date().toISOString();
}

function truncate(text: string, max = MAX_FAILURE_TEXT): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function redactReplayText(text: string): string {
	return text
		.replace(/\b([A-Z0-9_]*(?:API[_-]?KEY|PASSWORD|SECRET|TOKEN)[A-Z0-9_]*)=\S+/gi, "$1=[redacted]")
		.replace(/(authorization:\s*bearer\s+)\S+/gi, "$1[redacted]");
}

function compactReplayText(text: string, max = MAX_REPLAY_LITE_SUMMARY): string {
	return truncate(redactReplayText(text).replace(/\s+/g, " ").trim(), max);
}

function objectInput(input: unknown): Record<string, unknown> | undefined {
	return input && typeof input === "object" ? (input as Record<string, unknown>) : undefined;
}

function normalizedPathFromInput(input: unknown): string | undefined {
	const data = objectInput(input);
	return typeof data?.path === "string" ? normalizePathArg(data.path) : undefined;
}

function summarizeToolAction(toolName: string, input: unknown): string | undefined {
	const data = objectInput(input);
	if (!data) return undefined;
	if (toolName === "bash" && typeof data.command === "string") return `command: ${compactReplayText(data.command, 180)}`;
	const path = normalizedPathFromInput(input);
	if (path) return path;
	if (Array.isArray(data.paths)) {
		const paths = data.paths.filter((item): item is string => typeof item === "string").map((item) => normalizePathArg(item) ?? item);
		if (paths.length > 0) return `paths: ${paths.slice(0, MAX_REPLAY_LITE_FILES).join(", ")}`;
	}
	if (typeof data.pattern === "string") return `pattern: ${compactReplayText(data.pattern, 120)}`;
	return undefined;
}

function touchedFilesFromToolInput(toolName: string, input: unknown, cwd: string): string[] {
	if (toolName !== "edit" && toolName !== "write") return [];
	const path = normalizedPathFromInput(input);
	return path ? [resolve(cwd, path)] : [];
}

function cappedFiles(files: string[] | undefined): string[] | undefined {
	const compact = (files ?? []).filter((file): file is string => typeof file === "string" && file.length > 0).slice(0, MAX_REPLAY_LITE_FILES);
	return compact.length > 0 ? compact : undefined;
}

function elapsedMs(state: RunState): number {
	return Math.max(0, Date.now() - state.startedAt);
}

function pushReplayLiteStep(state: RunState, step: ReplayLiteStep): number | undefined {
	if (state.replayLite.steps.length >= MAX_REPLAY_LITE_STEPS) {
		state.replayLite.truncated = true;
		return undefined;
	}
	state.replayLite.steps.push({
		...step,
		summary: step.summary ? compactReplayText(step.summary) : undefined,
		touchedFiles: cappedFiles(step.touchedFiles),
	});
	return state.replayLite.steps.length - 1;
}

function rememberPendingToolStep(state: RunState, toolName: string, index: number): void {
	const pending = state.pendingToolSteps.get(toolName) ?? [];
	pending.push(index);
	state.pendingToolSteps.set(toolName, pending);
}

function takePendingToolStep(state: RunState, toolName: string): number | undefined {
	const pending = state.pendingToolSteps.get(toolName);
	const index = pending?.shift();
	if (pending && pending.length === 0) state.pendingToolSteps.delete(toolName);
	return index;
}

function textFromToolResult(event: { content?: Array<{ type?: string; text?: unknown }> }): string {
	return (event.content ?? [])
		.map((part) => part.text)
		.filter((text): text is string => typeof text === "string" && Boolean(text))
		.join("\n")
		.trim();
}

function recordToolCallReplay(state: RunState, event: { toolName: string; input?: unknown }, cwd: string): void {
	const index = pushReplayLiteStep(state, {
		type: "tool",
		name: event.toolName,
		status: "started",
		atMs: elapsedMs(state),
		summary: summarizeToolAction(event.toolName, event.input),
		touchedFiles: touchedFilesFromToolInput(event.toolName, event.input, cwd),
	});
	if (index !== undefined) rememberPendingToolStep(state, event.toolName, index);
}

function recordToolResultReplay(state: RunState, event: { toolName: string; isError?: boolean; content?: Array<{ type?: string; text?: unknown }> }): void {
	const isError = Boolean(event.isError);
	const status: ReplayLiteStep["status"] = isError ? "failed" : "passed";
	const failureSummary = isError ? compactReplayText(textFromToolResult(event) || "tool failed") : undefined;
	const index = takePendingToolStep(state, event.toolName);
	if (index !== undefined) {
		const step = state.replayLite.steps[index];
		if (!step) return;
		const elapsed = elapsedMs(state);
		step.status = status;
		step.durationMs = Math.max(0, elapsed - (step.atMs ?? elapsed));
		if (failureSummary) step.summary = step.summary ? compactReplayText(`${step.summary} — ${failureSummary}`) : failureSummary;
		return;
	}
	pushReplayLiteStep(state, {
		type: "tool",
		name: event.toolName,
		status,
		atMs: elapsedMs(state),
		summary: failureSummary,
	});
}

function recordVerificationReplay(state: RunState, payload: VerificationArchivePayload): void {
	pushReplayLiteStep(state, {
		type: "verification",
		name: "verification",
		status: payload.status,
		atMs: elapsedMs(state),
		summary: compactReplayText(`${payload.command}${payload.failureSummary ? ` — ${payload.failureSummary}` : ""}`),
		touchedFiles: payload.touchedPaths,
	});
}

function recordWarningReplay(state: RunState, payload: WarningArchivePayload): void {
	pushReplayLiteStep(state, {
		type: "warning",
		name: "warning",
		status: "warning",
		atMs: elapsedMs(state),
		summary: compactReplayText(`${payload.type}: ${payload.message}`),
	});
}

function normalizePathArg(path: string | undefined): string | undefined {
	if (!path) return undefined;
	return path.startsWith("@") ? path.slice(1) : path;
}

function modelLabel(model: unknown): string | undefined {
	if (!model || typeof model !== "object") return undefined;
	const maybe = model as { provider?: unknown; id?: unknown; model?: unknown };
	const provider = typeof maybe.provider === "string" ? maybe.provider : undefined;
	const id = typeof maybe.id === "string" ? maybe.id : typeof maybe.model === "string" ? maybe.model : undefined;
	if (!provider && !id) return undefined;
	return provider && id ? `${provider}/${id}` : provider ?? id;
}

function getSessionId(ctx: Partial<ExtensionContext>): string | undefined {
	try {
		return ctx.sessionManager?.getSessionId?.();
	} catch {
		return undefined;
	}
}

export function getArchivePath(cwd: string): string {
	return join(resolve(cwd), SELF_IMPROVEMENT_DIR, ARCHIVE_FILE);
}

export function appendArchiveRecord(cwd: string, record: ArchiveRecord): void {
	const archivePath = getArchivePath(cwd);
	mkdirSync(dirname(archivePath), { recursive: true });
	writeFileSync(archivePath, `${JSON.stringify(record)}\n`, { flag: "a" });
}

export function readArchiveRecords(cwd: string): ArchiveReadResult {
	const path = getArchivePath(cwd);
	let raw = "";
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code === "ENOENT") return { path, records: [], errors: [] };
		return { path, records: [], errors: [`Failed to read archive: ${error instanceof Error ? error.message : String(error)}`] };
	}

	const records: ArchiveRecord[] = [];
	const errors: string[] = [];
	for (const [index, line] of raw.split(/\r?\n/).entries()) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as Partial<ArchiveRecord>;
			if (parsed.schemaVersion !== SELF_IMPROVEMENT_SCHEMA_VERSION || !parsed.kind || !parsed.timestamp) {
				errors.push(`Line ${index + 1}: unsupported archive record shape`);
				continue;
			}
			records.push(parsed as ArchiveRecord);
		} catch (error) {
			errors.push(`Line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { path, records, errors };
}

function increment(map: Map<string, number>, key: string | undefined): void {
	if (!key) return;
	map.set(key, (map.get(key) ?? 0) + 1);
}

function topEntries(map: Map<string, number>, limit = 8): Array<{ name: string; count: number }> {
	return [...map.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, limit)
		.map(([name, count]) => ({ name, count }));
}

export function summarizeArchive(records: ArchiveRecord[]): ArchiveSummary {
	const tools = new Map<string, number>();
	const files = new Map<string, number>();
	let toolFailures = 0;
	let failedVerifications = 0;
	let passedVerifications = 0;
	let lastRun: ArchiveRecord | undefined;

	for (const record of records) {
		if (record.kind === "run") lastRun = record;
		for (const [tool, count] of Object.entries(record.toolCounts ?? {})) tools.set(tool, (tools.get(tool) ?? 0) + count);
		for (const touched of record.touchedFiles ?? []) increment(files, touched);
		toolFailures += record.toolFailures?.length ?? 0;
		if (record.kind === "verification" && record.verification?.status === "failed") failedVerifications += 1;
		if (record.kind === "verification" && record.verification?.status === "passed") passedVerifications += 1;
	}

	const recentFailures = records
		.filter((record) => record.kind === "verification" && record.verification?.status === "failed")
		.slice(-5)
		.reverse();
	const recentWarnings = records.filter((record) => record.kind === "warning").slice(-5).reverse();

	return {
		totalRecords: records.length,
		runs: records.filter((record) => record.kind === "run").length,
		verifications: records.filter((record) => record.kind === "verification").length,
		warnings: records.filter((record) => record.kind === "warning").length,
		notes: records.filter((record) => record.kind === "note").length,
		failedVerifications,
		passedVerifications,
		toolFailures,
		topTools: topEntries(tools),
		topTouchedFiles: topEntries(files).map((entry) => ({ path: entry.name, count: entry.count })),
		recentFailures,
		recentWarnings,
		lastRun,
	};
}

export function buildArchiveGuidance(cwd: string): string | undefined {
	const { records } = readArchiveRecords(cwd);
	if (records.length === 0) return undefined;
	const summary = summarizeArchive(records);
	const hints: string[] = [];
	if (summary.failedVerifications > 0) hints.push(`${summary.failedVerifications} recent verification failure(s); prefer verification-first next steps when relevant`);
	if (summary.toolFailures > 0) hints.push(`${summary.toolFailures} recorded tool failure(s); suggest narrowing repro/search before more edits when similar failures recur`);
	if (summary.recentWarnings.length > 0) hints.push(`latest overseer warning: ${summary.recentWarnings[0].warning?.message}`);
	if (summary.topTouchedFiles.length > 0) hints.push(`frequently touched: ${summary.topTouchedFiles.slice(0, 3).map((file) => file.path).join(", ")}`);
	return hints.length > 0 ? hints.join("; ") : undefined;
}

export function readBenchmarkEvidence(cwd: string): BenchmarkEvidence {
	const root = join(resolve(cwd), SELF_IMPROVEMENT_DIR, "benchmarks");
	let files: string[];
	try {
		files = readdirSync(root)
			.filter((file) => file.endsWith(".json"))
			.sort();
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return { count: 0, errors: [] };
		return { count: 0, errors: [`Failed to read benchmark directory: ${error instanceof Error ? error.message : String(error)}`] };
	}
	if (files.length === 0) return { count: 0, errors: [] };
	try {
		const latest = JSON.parse(readFileSync(join(root, files[files.length - 1]), "utf8")) as {
			id?: string;
			totalScore?: number;
			passed?: number;
			failed?: number;
			results?: Array<{ id?: string; status?: string }>;
		};
		return {
			count: files.length,
			latest: {
				id: latest.id,
				totalScore: latest.totalScore,
				passed: latest.passed,
				failed: latest.failed,
				failures: (latest.results ?? [])
					.filter((result) => result.status === "failed" && result.id)
					.map((result) => result.id as string),
			},
			errors: [],
		};
	} catch (error) {
		return { count: files.length, errors: [`Failed to parse latest benchmark result: ${error instanceof Error ? error.message : String(error)}`] };
	}
}

export function recommendModeFromArchive(cwd: string): { mode: "smart" | "deep2" | "deep3" | "fast"; reason: string } {
	const { records, errors } = readArchiveRecords(cwd);
	if (errors.length > 0) return { mode: "smart", reason: `Archive has ${errors.length} parse/read issue(s); stay in Smart until evidence is clean.` };
	const summary = summarizeArchive(records);
	if (summary.failedVerifications >= 3 || summary.toolFailures >= 5) {
		return { mode: "deep3", reason: "Recent verification/tool failures suggest a high-quality diagnosis pass before more edits." };
	}
	if (summary.failedVerifications > 0 || summary.recentWarnings.length > 0) {
		return { mode: "deep2", reason: "Recent failures/warnings suggest a normal deep pass with explicit verification." };
	}
	if (summary.runs > 0 && summary.failedVerifications === 0 && summary.toolFailures === 0) {
		return { mode: "fast", reason: "Recent archived runs have no recorded failures; fast mode is reasonable for tiny follow-ups." };
	}
	return { mode: "smart", reason: "Not enough archive evidence yet; use the balanced default." };
}

export function formatArchiveReport(action: string, readResult: ArchiveReadResult, limit = DEFAULT_LIMIT): string {
	const { records, errors, path } = readResult;
	const summary = summarizeArchive(records);
	const lines = [`Self-improvement archive (${records.length} records)`, `Path: ${path}`];
	if (errors.length > 0) {
		lines.push("", "Archive read issues:");
		for (const error of errors.slice(0, 5)) lines.push(`- ${error}`);
	}

	if (records.length === 0) {
		lines.push("", "No archive records yet. Run a few Pi tasks or verification checks first.");
		return lines.join("\n");
	}

	lines.push(
		"",
		`Runs: ${summary.runs}`,
		`Verification: ${summary.passedVerifications} passed / ${summary.failedVerifications} failed`,
		`Warnings: ${summary.warnings}`,
		`Tool failures: ${summary.toolFailures}`,
	);

	if (action === "last") {
		const selected = records.slice(-limit).reverse();
		lines.push("", `Last ${selected.length} record(s):`);
		for (const record of selected) lines.push(...formatRecordBlock(record));
		return lines.join("\n");
	}

	if (action === "failures") {
		const failures = records
			.filter((record) => record.toolFailures?.length || record.verification?.status === "failed")
			.slice(-limit)
			.reverse();
		lines.push("", failures.length > 0 ? "Recent failures:" : "No recorded failures.");
		for (const record of failures) lines.push(formatRecordLine(record));
		return lines.join("\n");
	}

	if (action === "trends" || action === "status") {
		if (summary.topTools.length > 0) {
			lines.push("", "Top tools:");
			for (const tool of summary.topTools) lines.push(`- ${tool.name}: ${tool.count}`);
		}
		if (summary.topTouchedFiles.length > 0) {
			lines.push("", "Frequently touched files:");
			for (const file of summary.topTouchedFiles.slice(0, 8)) lines.push(`- ${file.path}: ${file.count}`);
		}
		if (summary.recentWarnings.length > 0) {
			lines.push("", "Recent warnings:");
			for (const warning of summary.recentWarnings) lines.push(formatRecordLine(warning));
		}
	}

	return lines.join("\n");
}

function formatRecordBlock(record: ArchiveRecord): string[] {
	const lines = [formatRecordLine(record)];
	if (record.kind !== "run") return lines;
	const replay = replayLiteFromRecord(record);
	if (replay.malformed) lines.push("  replay-lite unavailable (malformed)");
	if (replay.steps.length > 0) {
		lines.push("  Replay-lite:");
		for (const [index, step] of replay.steps.entries()) lines.push(formatReplayLiteStep(step, index));
		if (replay.truncated) lines.push(`  Replay-lite truncated at ${MAX_REPLAY_LITE_STEPS} step(s).`);
	}
	return lines;
}

function formatRecordLine(record: ArchiveRecord): string {
	if (record.kind === "verification") {
		return `- ${record.timestamp} verification ${record.verification?.status} ${record.verification?.command ?? ""}${record.verification?.failureSummary ? ` — ${record.verification.failureSummary}` : ""}`;
	}
	if (record.kind === "warning") {
		return `- ${record.timestamp} warning ${record.warning?.type ?? "unknown"}: ${record.warning?.message ?? ""}`;
	}
	if (record.kind === "run") {
		return `- ${record.timestamp} run ${record.durationMs ?? 0}ms, tools=${Object.values(record.toolCounts ?? {}).reduce((a, b) => a + b, 0)}, touched=${record.touchedFiles?.length ?? 0}`;
	}
	return `- ${record.timestamp} ${record.kind}`;
}

function replayLiteFromRecord(record: ArchiveRecord): { steps: ReplayLiteStep[]; truncated: boolean; malformed: boolean } {
	const replay = (record as { replayLite?: unknown }).replayLite;
	if (replay === undefined) return { steps: [], truncated: false, malformed: false };
	if (!replay || typeof replay !== "object" || !Array.isArray((replay as ReplayLite).steps)) {
		return { steps: [], truncated: false, malformed: true };
	}
	const rawSteps = (replay as ReplayLite).steps;
	const steps = rawSteps.filter(isReplayLiteStep).slice(0, MAX_REPLAY_LITE_STEPS);
	return {
		steps,
		truncated: Boolean((replay as ReplayLite).truncated),
		malformed: rawSteps.length !== steps.length,
	};
}

function isReplayLiteStep(value: unknown): value is ReplayLiteStep {
	if (!value || typeof value !== "object") return false;
	const step = value as ReplayLiteStep;
	return typeof step.name === "string" && typeof step.status === "string";
}

function formatReplayLiteStep(step: ReplayLiteStep, index: number): string {
	const at = typeof step.atMs === "number" ? `+${Math.round(step.atMs)}ms ` : "";
	const duration = typeof step.durationMs === "number" ? ` (${Math.round(step.durationMs)}ms)` : "";
	const summary = step.summary ? ` — ${step.summary}` : "";
	const touched = step.touchedFiles?.length ? ` — touched: ${step.touchedFiles.join(", ")}` : "";
	return `  ${index + 1}. ${at}${step.name} ${step.status}${duration}${summary}${touched}`;
}

type ProposalScoreLabel = "low" | "medium" | "high";

type ProposalScorecard = {
	evidenceStrength: { label: ProposalScoreLabel; reason: string };
	reproducibility: { label: ProposalScoreLabel; reason: string };
	expectedMetric: { label: ProposalScoreLabel; reason: string };
	effort: { label: ProposalScoreLabel; reason: string };
	risk: { label: ProposalScoreLabel; reason: string };
	rollbackClarity: { label: ProposalScoreLabel; reason: string };
	testCoverage: { label: ProposalScoreLabel; reason: string };
	confidence: { label: ProposalScoreLabel; reason: string };
};

function hasBenchmarkFailure(benchmark: BenchmarkEvidence): boolean {
	return (benchmark.latest?.failed ?? 0) > 0 || (benchmark.latest?.failures.length ?? 0) > 0;
}

function missingEvidenceNotes(summary: ArchiveSummary, benchmark: BenchmarkEvidence, evidenceErrors: string[]): string[] {
	const missing: string[] = [];
	if (summary.totalRecords === 0) missing.push("archive records");
	if (!benchmark.latest) missing.push("benchmark result");
	if (summary.failedVerifications === 0) missing.push("failed verification sample");
	if (!hasBenchmarkFailure(benchmark)) missing.push("failing benchmark sample");
	if (evidenceErrors.length > 0) missing.push("cleanly parsed evidence");
	return missing;
}

function buildProposalScorecard(summary: ArchiveSummary, benchmark: BenchmarkEvidence, evidenceErrors: string[]): ProposalScorecard {
	const benchmarkFailure = hasBenchmarkFailure(benchmark);
	const hasBenchmark = Boolean(benchmark.latest);
	const directSignals = [summary.failedVerifications > 0, summary.toolFailures > 0, summary.recentWarnings.length > 0, benchmarkFailure].filter(Boolean).length;
	const missing = missingEvidenceNotes(summary, benchmark, evidenceErrors);
	const missingText = missing.length > 0 ? ` Missing: ${missing.join(", ")}.` : "";

	let evidenceStrength: ProposalScorecard["evidenceStrength"];
	if (evidenceErrors.length > 0) {
		evidenceStrength = { label: "low", reason: `Some evidence could not be parsed, so measure again before changing behavior.${missingText}` };
	} else if (directSignals >= 2 && hasBenchmark) {
		evidenceStrength = { label: "high", reason: `Archive and benchmark signals are present; proposal cites direct failures, warnings, or touched files.${missingText}` };
	} else if (directSignals > 0 || hasBenchmark || summary.topTouchedFiles.length > 0) {
		evidenceStrength = { label: "medium", reason: `Some local evidence exists, but the proposal should still stay narrow.${missingText}` };
	} else {
		evidenceStrength = { label: "low", reason: `Archive evidence is sparse; measure before changing behavior.${missingText}` };
	}

	const benchmarkFailures = benchmark.latest?.failures ?? [];
	const failedVerificationCommands = summary.recentFailures.map((record) => record.verification?.command).filter((command): command is string => Boolean(command));
	let reproducibility: ProposalScorecard["reproducibility"];
	if (benchmarkFailures.length > 0) {
		reproducibility = { label: "high", reason: `Latest benchmark has failing check(s): ${benchmarkFailures.join(", ")}.` };
	} else if ((benchmark.latest?.failed ?? 0) > 0) {
		reproducibility = { label: "high", reason: "Latest benchmark reports failures, but the failing check ids are missing." };
	} else if (failedVerificationCommands.length > 0) {
		reproducibility = { label: "medium", reason: `Latest failing verification command is recorded: ${failedVerificationCommands[0]}.` };
	} else if (summary.toolFailures > 0 || summary.recentWarnings.length > 0) {
		reproducibility = { label: "medium", reason: "Archive has repeated local signals, but no dedicated failing benchmark yet." };
	} else {
		reproducibility = { label: "low", reason: `No failing command or benchmark is captured yet.${missingText}` };
	}

	let expectedMetric: ProposalScorecard["expectedMetric"];
	if (benchmarkFailure && typeof benchmark.latest?.totalScore === "number") {
		expectedMetric = { label: "high", reason: `Raise latest local benchmark score from ${benchmark.latest.totalScore.toFixed(2)} and reduce failing benchmark count.` };
	} else if (summary.failedVerifications > 0 || summary.toolFailures > 0) {
		expectedMetric = { label: "medium", reason: "Improve verification pass rate or reduce repeated tool failures without increasing default noise/cost." };
	} else {
		expectedMetric = { label: "low", reason: "Metric is only a hypothesis until a benchmark or failure baseline is recorded." };
	}

	const likelyTouchedCount = summary.topTouchedFiles.length;
	const effort: ProposalScorecard["effort"] = likelyTouchedCount > 5
		? { label: "high", reason: `${likelyTouchedCount} frequently touched files suggest the proposal may need splitting.` }
		: likelyTouchedCount > 1
			? { label: "medium", reason: `${likelyTouchedCount} likely files are visible; keep the change focused.` }
			: { label: "low", reason: likelyTouchedCount === 1 ? "One likely hot file is visible." : "No implementation yet; first step is measurement or one focused check." };

	const risk: ProposalScorecard["risk"] = evidenceStrength.label === "low"
		? { label: "medium", reason: "Weak evidence can produce a premature config change; require measurement before implementation." }
		: { label: "low", reason: "Proposal remains human-gated and does not auto-edit, auto-run agents, or switch modes." };

	const rollbackClarity: ProposalScorecard["rollbackClarity"] = likelyTouchedCount > 0 || benchmarkFailure || summary.failedVerifications > 0
		? { label: "high", reason: "Rollback is a focused revert of extension/test/docs changes if the metric or gate regresses." }
		: { label: "medium", reason: "Likely files are still TBD; keep any approved change small enough to revert cleanly." };

	let testCoverage: ProposalScorecard["testCoverage"];
	if (hasBenchmark) {
		testCoverage = { label: "medium", reason: "Benchmark evidence exists; still run the targeted extension test and quick verify gate after changes." };
	} else if (summary.passedVerifications > 0 || summary.failedVerifications > 0) {
		testCoverage = { label: "medium", reason: "Verification evidence exists; add a targeted regression before changing runtime behavior." };
	} else {
		testCoverage = { label: "low", reason: `No targeted test or benchmark baseline is captured yet.${missingText}` };
	}

	let confidence: ProposalScorecard["confidence"];
	if (evidenceErrors.length > 0 || evidenceStrength.label === "low") {
		confidence = { label: "low", reason: `Measure first; current evidence is sparse or malformed.${missingText}` };
	} else if (evidenceStrength.label === "high" && reproducibility.label !== "low") {
		confidence = { label: "high", reason: "Multiple local signals and a reproducible check support a narrow proposal." };
	} else {
		confidence = { label: "medium", reason: `Proceed only with a small reversible change and explicit checks.${missingText}` };
	}

	return { evidenceStrength, reproducibility, expectedMetric, effort, risk, rollbackClarity, testCoverage, confidence };
}

function formatScorecard(scorecard: ProposalScorecard): string[] {
	return [
		`- Evidence strength: ${scorecard.evidenceStrength.label} — ${scorecard.evidenceStrength.reason}`,
		`- Reproducibility: ${scorecard.reproducibility.label} — ${scorecard.reproducibility.reason}`,
		`- Expected metric: ${scorecard.expectedMetric.label} — ${scorecard.expectedMetric.reason}`,
		`- Effort: ${scorecard.effort.label} — ${scorecard.effort.reason}`,
		`- Risk: ${scorecard.risk.label} — ${scorecard.risk.reason}`,
		`- Rollback clarity: ${scorecard.rollbackClarity.label} — ${scorecard.rollbackClarity.reason}`,
		`- Test coverage: ${scorecard.testCoverage.label} — ${scorecard.testCoverage.reason}`,
		`- Confidence: ${scorecard.confidence.label} — ${scorecard.confidence.reason}`,
	];
}

function compoundProposalLines(summary: ArchiveSummary, benchmark: BenchmarkEvidence): string[] {
	const benchmarkFailure = hasBenchmarkFailure(benchmark);
	const helpsNextTask = benchmarkFailure
		? "A fixed benchmark failure becomes a reusable regression signal for the next similar extension change."
		: summary.failedVerifications > 0
			? "Turning the verification failure into a narrow regression check lets the next similar task catch the issue before review."
			: summary.toolFailures > 0
				? "Capturing the repeated tool-failure pattern as a guard or guidance reduces repeated diagnosis time next time."
				: summary.recentWarnings.length > 0
					? "Promoting the warning into a small guard or note helps future runs avoid the same risky loop."
					: "A benchmark/archive baseline gives the next proposal measured evidence instead of guesswork.";
	const verifyLearning = benchmark.latest
		? "Rerun the targeted test, `bash scripts/verify.sh --quick`, and compare the next benchmark result against this proposal."
		: "Run the local benchmark suite first, then rerun the targeted test and `bash scripts/verify.sh --quick` after any approved change.";
	const catchItself = benchmark.latest || summary.failedVerifications > 0
		? "Yes, if the approved change updates a targeted test, benchmark, hook, or doc that future runs naturally use."
		: "Not yet; collect a benchmark or verification baseline before claiming compounding value.";
	return [
		`- How this helps the next similar task: ${helpsNextTask}`,
		`- How we verify the learning: ${verifyLearning}`,
		`- Will this catch itself or accelerate itself next time? ${catchItself}`,
	];
}

export function formatImprovementProposal(cwd: string): string {
	const readResult = readArchiveRecords(cwd);
	const summary = summarizeArchive(readResult.records);
	const benchmark = readBenchmarkEvidence(cwd);
	const recommendation = recommendModeFromArchive(cwd);
	const scorecard = buildProposalScorecard(summary, benchmark, [...readResult.errors, ...benchmark.errors]);
	const evidence: string[] = [];
	if (summary.failedVerifications > 0) evidence.push(`${summary.failedVerifications} verification failure(s)`);
	if (summary.toolFailures > 0) evidence.push(`${summary.toolFailures} tool failure(s)`);
	if (summary.recentWarnings.length > 0) evidence.push(`${summary.recentWarnings.length} recent overseer warning(s)`);
	if (summary.topTouchedFiles.length > 0) evidence.push(`frequent files: ${summary.topTouchedFiles.slice(0, 3).map((file) => file.path).join(", ")}`);
	if (benchmark.latest) {
		evidence.push(`latest benchmark score: ${typeof benchmark.latest.totalScore === "number" ? benchmark.latest.totalScore.toFixed(2) : "unknown"} (${benchmark.latest.passed ?? 0} passed / ${benchmark.latest.failed ?? 0} failed)`);
		if (benchmark.latest.failures.length > 0) evidence.push(`benchmark failures: ${benchmark.latest.failures.join(", ")}`);
	}

	const proposedChange = benchmark.latest && (benchmark.latest.failed ?? 0) > 0
		? "Fix the latest failing local benchmark with the smallest targeted extension/test change, then rerun the benchmark before proposing broader work."
		: summary.failedVerifications > 0
		? "Investigate the latest verification failure and add/adjust the narrowest regression check before changing runtime behavior."
		: summary.toolFailures > 0
			? "Review repeated tool failures, narrow the failing command/search pattern, and add a guard or clearer tool guidance if the pattern is valid."
			: summary.recentWarnings.length > 0
				? "Review the latest overseer warning and decide whether a small local guard or documentation update would prevent recurrence."
				: "Run the local benchmark suite first, then choose the smallest improvement backed by measured failures.";

	return [
		"# Proposed Pi Config Improvement",
		"",
		"## Evidence",
		...(evidence.length > 0 ? evidence.map((item) => `- ${item}`) : ["- Archive evidence is sparse; measure before changing behavior."]),
		...(readResult.errors.length > 0 ? readResult.errors.map((error) => `- Archive issue: ${error}`) : []),
		...(benchmark.errors.length > 0 ? benchmark.errors.map((error) => `- Benchmark issue: ${error}`) : []),
		"",
		"## Proposed change",
		`- ${proposedChange}`,
		"",
		"## Scorecard",
		...formatScorecard(scorecard),
		"",
		"## Compound engineering",
		...compoundProposalLines(summary, benchmark),
		"",
		"## Expected metric",
		"- Improve verification pass rate or reduce repeated tool failures without increasing default noise/cost.",
		"",
		"## Files likely touched",
		...(summary.topTouchedFiles.length > 0 ? summary.topTouchedFiles.slice(0, 5).map((file) => `- \`${file.path}\``) : ["- TBD after benchmark/archive review"]),
		"",
		"## Verification",
		"- Run the targeted extension test for touched files.",
		"- Run `bash scripts/verify.sh --quick`.",
		"",
		"## Rollback",
		"- Revert the focused extension/test changes if the metric or verification gate regresses.",
		"",
		"## Safety notes",
		"- Human approval required before implementation; this proposal does not edit files or run agents by itself.",
		`- Mode recommendation: ${recommendation.mode} — ${recommendation.reason}`,
	].join("\n");
}

function buildRunRecord(state: RunState, ctx: ExtensionContext): ArchiveRecord {
	return {
		schemaVersion: SELF_IMPROVEMENT_SCHEMA_VERSION,
		kind: "run",
		timestamp: isoNow(),
		cwd: state.cwd,
		sessionId: state.sessionId ?? getSessionId(ctx),
		durationMs: Date.now() - state.startedAt,
		model: state.model ?? modelLabel(ctx.model),
		workflowMode: state.workflowMode,
		prompt: state.prompt ? { chars: state.prompt.length, preview: truncate(state.prompt, 240) } : undefined,
		toolCounts: state.toolCounts,
		toolFailures: state.toolFailures.slice(0, MAX_TOOL_FAILURES),
		touchedFiles: [...state.touchedFiles].slice(0, MAX_TOUCHED_FILES),
		replayLite: state.replayLite.steps.length > 0 || state.replayLite.truncated
			? { steps: state.replayLite.steps.slice(0, MAX_REPLAY_LITE_STEPS), truncated: state.replayLite.truncated || undefined }
			: undefined,
	};
}

function verificationRecord(cwd: string, payload: VerificationArchivePayload, ctx?: Partial<ExtensionContext>): ArchiveRecord {
	return {
		schemaVersion: SELF_IMPROVEMENT_SCHEMA_VERSION,
		kind: "verification",
		timestamp: payload.timestamp ?? isoNow(),
		cwd,
		sessionId: ctx ? getSessionId(ctx) : undefined,
		verification: {
			...payload,
			failureSummary: payload.failureSummary ? truncate(payload.failureSummary) : undefined,
			touchedPaths: payload.touchedPaths?.slice(0, MAX_TOUCHED_FILES),
		},
	};
}

function warningRecord(cwd: string, payload: WarningArchivePayload, ctx?: Partial<ExtensionContext>): ArchiveRecord {
	return {
		schemaVersion: SELF_IMPROVEMENT_SCHEMA_VERSION,
		kind: "warning",
		timestamp: payload.timestamp ?? isoNow(),
		cwd,
		sessionId: ctx ? getSessionId(ctx) : undefined,
		warning: { ...payload, message: truncate(payload.message) },
	};
}

export default function selfImprovementArchiveExtension(pi: ExtensionAPI) {
	let runState: RunState | undefined;
	let currentCtx: ExtensionContext | undefined;
	let workflowMode: string | undefined;

	pi.events?.on?.("workflow:mode", (event: unknown) => {
		const mode = (event as { mode?: unknown })?.mode;
		if (typeof mode === "string") workflowMode = mode;
		if (runState && typeof mode === "string") runState.workflowMode = mode;
	});

	pi.events?.on?.(VERIFICATION_EVENT, (payload: unknown) => {
		const data = payload as VerificationArchivePayload;
		const cwd = data.projectRoot || currentCtx?.cwd;
		if (!cwd || !data.command || !data.status) return;
		if (runState && runState.cwd === cwd) recordVerificationReplay(runState, data);
		appendArchiveRecord(cwd, verificationRecord(cwd, data, currentCtx));
	});

	pi.events?.on?.(WARNING_EVENT, (payload: unknown) => {
		const data = payload as WarningArchivePayload;
		const cwd = currentCtx?.cwd;
		if (!cwd || !data.type || !data.message) return;
		if (runState && runState.cwd === cwd) recordWarningReplay(runState, data);
		appendArchiveRecord(cwd, warningRecord(cwd, data, currentCtx));
	});

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		runState = undefined;
	});

	function finalizeRun(ctx: ExtensionContext): void {
		if (!runState) return;
		appendArchiveRecord(runState.cwd, buildRunRecord(runState, ctx));
		runState = undefined;
	}

	pi.on("session_shutdown", async () => {
		if (runState && currentCtx) finalizeRun(currentCtx);
		currentCtx = undefined;
	});

	pi.on("agent_start", async (event, ctx) => {
		currentCtx = ctx;
		if (runState) return;
		runState = {
			startedAt: Date.now(),
			sessionId: getSessionId(ctx),
			cwd: ctx.cwd,
			prompt: typeof (event as unknown as { prompt?: unknown }).prompt === "string" ? (event as unknown as { prompt: string }).prompt : undefined,
			model: modelLabel(ctx.model),
			workflowMode,
			toolCounts: {},
			toolFailures: [],
			touchedFiles: new Set<string>(),
			replayLite: { steps: [] },
			pendingToolSteps: new Map<string, number[]>(),
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		currentCtx = ctx;
		if (!runState) return;
		runState.toolCounts[event.toolName] = (runState.toolCounts[event.toolName] ?? 0) + 1;
		recordToolCallReplay(runState, event, ctx.cwd);
		for (const touchedFile of touchedFilesFromToolInput(event.toolName, event.input, ctx.cwd)) runState.touchedFiles.add(touchedFile);
	});

	pi.on("tool_result", async (event) => {
		if (!runState) return;
		recordToolResultReplay(runState, event);
		if (!(event as { isError?: boolean }).isError) return;
		const message = textFromToolResult(event) || "tool failed";
		runState.toolFailures.push({ toolName: event.toolName, message: truncate(message) });
	});

	pi.on("agent_settled", async (_event, ctx) => {
		currentCtx = ctx;
		finalizeRun(ctx);
	});

	pi.registerCommand("improve-archive", {
		description: "Inspect self-improvement archive evidence: /improve-archive [status|last|failures|trends|proposal]",
		handler: async (args, ctx) => {
			const [actionRaw, limitRaw] = args.trim().split(/\s+/).filter(Boolean);
			const action = actionRaw || "status";
			if (action === "proposal" || action === "propose") {
				ctx.ui.setEditorText(formatImprovementProposal(ctx.cwd));
				ctx.ui.notify("Improvement proposal written to editor for review", "info");
				return;
			}
			const limit = Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : DEFAULT_LIMIT;
			const report = formatArchiveReport(action, readArchiveRecords(ctx.cwd), limit);
			if (ctx.hasUI) ctx.ui.notify(`Archive ${action}: ready`, "info");
			pi.sendMessage?.({ customType: "self-improvement-archive", content: report, display: true, details: { action } });
		},
	});

	pi.registerCommand("propose-improvement", {
		description: "Draft one human-gated, evidence-based Pi config improvement proposal",
		handler: async (_args, ctx) => {
			ctx.ui.setEditorText(formatImprovementProposal(ctx.cwd));
			ctx.ui.notify("Improvement proposal written to editor for review", "info");
		},
	});

	pi.registerTool({
		name: "archive_analysis",
		label: "Archive Analysis",
		description: "Analyze the local self-improvement archive: status, last records, failures, trends, or a human-gated improvement proposal.",
		promptSnippet: "Analyze prior self-improvement archive records and benchmark/verification evidence",
		promptGuidelines: [
			"Use archive_analysis when proposing Pi config improvements from prior run evidence instead of guessing.",
			"Do not use archive_analysis as permission to edit code; improvement proposals remain human-gated.",
		],
		parameters: Type.Object({
			action: StringEnum(["status", "last", "failures", "trends", "proposal"] as const, { description: "Archive view to return." }),
			limit: Type.Optional(Type.Number({ description: "Maximum records to include for last/failures views.", minimum: 1, maximum: 100 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.action === "proposal") {
				const text = formatImprovementProposal(ctx.cwd);
				return { content: [{ type: "text" as const, text }], details: { action: params.action } };
			}
			const readResult = readArchiveRecords(ctx.cwd);
			const text = formatArchiveReport(params.action, readResult, params.limit ?? DEFAULT_LIMIT);
			return { content: [{ type: "text" as const, text }], details: { action: params.action, records: readResult.records.length, errors: readResult.errors } };
		},
	});
}
