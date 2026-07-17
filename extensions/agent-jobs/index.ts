import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { execChecked } from "../lib/process.ts";

export type AgentJobMode = "standard" | "review";
export type AgentJobState = "running" | "completed" | "failed" | "cancelled";
export type LoopTool = "amp" | "claude" | "opencode" | "pi";

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface AgentEventParseResult {
	finalOutput: string;
	assistantMessages: number;
	toolCalls: number;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export interface AgentJobStatus {
	jobId: string;
	agent: string;
	agentSource: "user" | "project" | "unknown";
	mode: AgentJobMode;
	task: string;
	cwd: string;
	createdAt: string;
	updatedAt: string;
	state: AgentJobState;
	tmuxWindow: string;
	jobDir: string;
	runScriptPath: string;
	eventLogPath: string;
	stderrPath: string;
	resultPath: string;
	exitPath: string;
	pidPath: string;
	promptPath: string;
	systemPromptPath?: string;
	reviewContextPath?: string;
	model?: string;
	tools?: string[];
	exitCode?: number;
	completedAt?: string;
	cancelRequestedAt?: string;
	summary?: string;
	errorMessage?: string;
	usage?: UsageStats;
	followUp: boolean;
	followUpSent: boolean;
}

export interface LoopJobStatus {
	jobId: string;
	feature: string;
	task?: string;
	cwd: string;
	createdAt: string;
	updatedAt: string;
	state: AgentJobState;
	tmuxWindow: string;
	jobDir: string;
	runScriptPath: string;
	stdoutPath: string;
	stderrPath: string;
	resultPath: string;
	exitPath: string;
	pidPath: string;
	loopLogPath: string;
	loopSummaryPath: string;
	loopProgressPath: string;
	loopScriptPath: string;
	command: string[];
	maxIterations: number;
	tool?: LoopTool;
	toolOrder?: string;
	agent?: string;
	sleepSeconds: number;
	pollSeconds: number;
	rateLimitStreak?: number;
	exitCode?: number;
	completedAt?: string;
	cancelRequestedAt?: string;
	summary?: string;
	errorMessage?: string;
	followUp: boolean;
	followUpSent: boolean;
}

const JOBS_DIR = path.join(".pi", "agent-jobs");
const LOOP_JOBS_DIR = path.join(".pi", "loop-jobs");
const LOOP_DEFAULT_MAX_ITERATIONS = 10;
const LOOP_DEFAULT_SLEEP_SECONDS = 2;
const LOOP_DEFAULT_POLL_SECONDS = 3;
const LOOP_DEFAULT_RATE_LIMIT_STREAK = 3;
const WATCH_INTERVAL_MS = 5000;
const MAX_RESULT_CHARS = 60_000;
const FOLLOW_UP_RESULT_CHARS = 12_000;
const STDERR_TAIL_CHARS = 8000;
const MAX_DIFF_CHARS = 18_000;
const MAX_UNTRACKED_FILES = 10;
const MAX_UNTRACKED_FILE_CHARS = 2000;
const MAX_UNTRACKED_TOTAL_CHARS = 8000;

type JobWatch = { interval: NodeJS.Timeout; poll: () => void };
const watchedJobs = new Map<string, JobWatch>();
const watchedLoopJobs = new Map<string, JobWatch>();
type CompletionFollowUpKind = "agent" | "loop";
type PendingFollowUpAck = { cwd: string };
const pendingFollowUpAcks = new Map<string, PendingFollowUpAck>();
const COMPLETION_FOLLOW_UP_MARKER = "pi-agent-jobs-follow-up";

function followUpKey(kind: CompletionFollowUpKind, jobId: string): string {
	return `${kind}:${jobId}`;
}

function completionFollowUpMarker(kind: CompletionFollowUpKind, jobId: string): string {
	return `<!-- ${COMPLETION_FOLLOW_UP_MARKER}:${kind}:${jobId} -->`;
}

function parseCompletionFollowUpMarker(text: string): { kind: CompletionFollowUpKind; jobId: string } | undefined {
	const match = text.match(new RegExp(`<!-- ${COMPLETION_FOLLOW_UP_MARKER}:(agent|loop):([a-zA-Z0-9_.-]+) -->\\s*$`));
	if (!match) return undefined;
	return { kind: match[1] as CompletionFollowUpKind, jobId: match[2]! };
}

function needsCompletionFollowUp(status: AgentJobStatus | LoopJobStatus): boolean {
	return status.state !== "running" && status.followUp && !status.followUpSent;
}

function pollWaitingFollowUps(): void {
	for (const watch of watchedJobs.values()) watch.poll();
	for (const watch of watchedLoopJobs.values()) watch.poll();
}

function runningJobCount(cwd: string): number {
	const prefix = `${cwd}:`;
	return [...watchedJobs.keys()].filter((key) => key.startsWith(prefix)).length;
}

function runningLoopJobCount(cwd: string): number {
	const prefix = `${cwd}:`;
	return [...watchedLoopJobs.keys()].filter((key) => key.startsWith(prefix)).length;
}

function emitRunningJobCount(pi: ExtensionAPI, cwd: string): void {
	pi.events?.emit("agent-jobs:running-count", { cwd, count: runningJobCount(cwd) });
}

function emitRunningLoopJobCount(pi: ExtensionAPI, cwd: string): void {
	pi.events?.emit("loop-jobs:running-count", { cwd, count: runningLoopJobCount(cwd) });
}

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const AgentJobModeSchema = StringEnum(["standard", "review"] as const, {
	description: 'Job prompt mode. Use "review" for oracle reviews so the launcher snapshots git diff context first.',
	default: "standard",
});

const LoopToolSchema = StringEnum(["amp", "claude", "opencode", "pi"] as const, {
	description: "Tool used by loop.sh for each implementation iteration. Defaults to loop.sh auto-detection.",
});

function nowIso(): string {
	return new Date().toISOString();
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function sanitizeJobPart(value: string): string {
	const sanitized = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized || "agent";
}

export function createJobId(agentName: string, timestamp = new Date(), random = randomBytes(3).toString("hex")): string {
	const stamp = timestamp.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
	return `${sanitizeJobPart(agentName)}-${stamp}-${random}`;
}

function assertSafeJobId(jobId: string): void {
	if (!/^[a-zA-Z0-9_.-]+$/.test(jobId) || jobId.includes("..")) {
		throw new Error(`Invalid job id: ${jobId}`);
	}
}

function jobsRoot(cwd: string): string {
	return path.join(cwd, JOBS_DIR);
}

function jobDirFor(cwd: string, jobId: string): string {
	assertSafeJobId(jobId);
	return path.join(jobsRoot(cwd), jobId);
}

function truncateMiddle(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const keep = Math.floor((maxChars - 80) / 2);
	return `${text.slice(0, keep).trimEnd()}\n\n…[truncated ${text.length - keep * 2} chars]…\n\n${text.slice(-keep).trimStart()}`;
}

function truncateTail(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `…[truncated ${text.length - maxChars} chars]…\n${text.slice(-maxChars)}`;
}

function firstNonEmptyLine(text: string): string {
	const line = text.split("\n").map((part) => part.trim()).find(Boolean);
	return line ? (line.length > 160 ? `${line.slice(0, 157)}…` : line) : "";
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
	const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	await fs.promises.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	await fs.promises.rename(tmp, filePath);
}

async function readJson<T>(filePath: string): Promise<T> {
	return JSON.parse(await fs.promises.readFile(filePath, "utf8")) as T;
}

function fileExists(filePath: string): boolean {
	try {
		fs.accessSync(filePath);
		return true;
	} catch {
		return false;
	}
}

function textFromMessageContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text?: string } => Boolean(part) && typeof part === "object" && "type" in part)
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

export function parseAgentEvents(eventsJsonl: string): AgentEventParseResult {
	const result: AgentEventParseResult = {
		finalOutput: "",
		assistantMessages: 0,
		toolCalls: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	};

	for (const line of eventsJsonl.split("\n")) {
		if (!line.trim()) continue;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}

		if (event.type === "tool_execution_start") {
			result.toolCalls++;
			continue;
		}

		if (event.type !== "message_end" || !event.message || event.message.role !== "assistant") continue;

		result.assistantMessages++;
		result.usage.turns++;
		const text = textFromMessageContent(event.message.content).trim();
		if (text) result.finalOutput = text;

		const usage = event.message.usage;
		if (usage) {
			result.usage.input += usage.input || 0;
			result.usage.output += usage.output || 0;
			result.usage.cacheRead += usage.cacheRead || 0;
			result.usage.cacheWrite += usage.cacheWrite || 0;
			result.usage.cost += usage.cost?.total || 0;
			result.usage.contextTokens = usage.totalTokens || result.usage.contextTokens;
		}
		if (event.message.model) result.model = event.message.model;
		if (event.message.stopReason) result.stopReason = event.message.stopReason;
		if (event.message.errorMessage) result.errorMessage = event.message.errorMessage;
	}

	return result;
}

function buildPiInvocationArgs(agent: AgentConfig, promptPath: string, systemPromptPath?: string): string[] {
	const args = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	if (systemPromptPath) args.push("--append-system-prompt", systemPromptPath);
	args.push(`@${promptPath}`, "Execute the task described in the attached prompt file.");
	return args;
}

function buildPiCommand(agent: AgentConfig, promptPath: string, systemPromptPath?: string): string {
	const args = buildPiInvocationArgs(agent, promptPath, systemPromptPath);
	return ["pi", ...args].map(shellQuote).join(" ");
}

export function buildRunScript(params: {
	cwd: string;
	jobId: string;
	agent: AgentConfig;
	promptPath: string;
	systemPromptPath?: string;
	eventLogPath: string;
	stderrPath: string;
	exitPath: string;
	pidPath: string;
	resultPath: string;
}): string {
	const piCommand = buildPiCommand(params.agent, params.promptPath, params.systemPromptPath);
	return `#!/usr/bin/env bash
set -u
cd ${shellQuote(params.cwd)}
echo "$$" > ${shellQuote(params.pidPath)}
echo "pi background agent job: ${params.jobId}"
echo "agent: ${params.agent.name}"
echo "events: ${params.eventLogPath}"
echo "stderr: ${params.stderrPath}"
echo "result: ${params.resultPath}"
echo ""
echo "Running agent in JSON mode..."
${piCommand} > ${shellQuote(params.eventLogPath)} 2> ${shellQuote(params.stderrPath)}
code=$?
finished_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
exit_tmp=${shellQuote(`${params.exitPath}.tmp`)}
printf '{"exitCode":%s,"finishedAt":"%s"}\n' "$code" "$finished_at" > "$exit_tmp"
mv "$exit_tmp" ${shellQuote(params.exitPath)}
echo ""
echo "Agent process exited with code $code"
echo "Result will be written by the parent pi extension: ${params.resultPath}"
exit "$code"
`;
}

export function buildTmuxNewWindowArgs(windowName: string, cwd: string, runScriptPath: string): string[] {
	const command = `bash ${shellQuote(runScriptPath)}`;
	return ["new-window", "-d", "-n", windowName, "-c", cwd, command];
}

function isSensitivePath(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/").toLowerCase();
	const base = path.basename(normalized);
	return (
		base === ".env" ||
		base.startsWith(".env.") ||
		/secret|token|credential|private[_-]?key|id_rsa|id_ed25519/.test(normalized)
	);
}

function looksBinary(buffer: Buffer): boolean {
	return buffer.subarray(0, 8000).includes(0);
}

async function execText(pi: ExtensionAPI, cwd: string, command: string, signal?: AbortSignal): Promise<string> {
	try {
		const result = await pi.exec("bash", ["-lc", command], { cwd, signal, timeout: 20_000 });
		return `${result.stdout || ""}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`.trim();
	} catch (error) {
		return `[command failed: ${command}] ${error instanceof Error ? error.message : String(error)}`;
	}
}

async function collectUntrackedFiles(cwd: string, untrackedList: string): Promise<string> {
	const files = untrackedList.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, MAX_UNTRACKED_FILES);
	let total = 0;
	const sections: string[] = [];

	for (const file of files) {
		if (isSensitivePath(file)) {
			sections.push(`### ${file}\n\n[Skipped: sensitive-looking path]`);
			continue;
		}

		const absolute = path.resolve(cwd, file);
		const relative = path.relative(cwd, absolute);
		if (relative.startsWith("..") || path.isAbsolute(relative)) continue;

		try {
			const buffer = await fs.promises.readFile(absolute);
			if (looksBinary(buffer)) {
				sections.push(`### ${file}\n\n[Skipped: binary file]`);
				continue;
			}
			const text = buffer.toString("utf8");
			const remaining = MAX_UNTRACKED_TOTAL_CHARS - total;
			if (remaining <= 0) break;
			const clipped = text.length > Math.min(MAX_UNTRACKED_FILE_CHARS, remaining)
				? `${text.slice(0, Math.min(MAX_UNTRACKED_FILE_CHARS, remaining)).trimEnd()}\n…[truncated]…`
				: text;
			total += clipped.length;
			sections.push(`### ${file}\n\n\`\`\`\n${clipped}\n\`\`\``);
		} catch (error) {
			sections.push(`### ${file}\n\n[Could not read: ${error instanceof Error ? error.message : String(error)}]`);
		}
	}

	return sections.join("\n\n");
}

export async function collectReviewContext(pi: ExtensionAPI, cwd: string, focus: string, signal?: AbortSignal): Promise<string> {
	const insideWorkTree = await execText(pi, cwd, "git rev-parse --is-inside-work-tree", signal);
	if (!/^true\b/.test(insideWorkTree)) {
		return `# Review Context\n\nFocus: ${focus || "current work"}\n\nNot a git worktree or git is unavailable. Inspect local files directly.`;
	}

	const [status, stagedStat, unstagedStat, stagedDiff, unstagedDiff, untracked] = await Promise.all([
		execText(pi, cwd, "git status --short", signal),
		execText(pi, cwd, "git diff --cached --stat", signal),
		execText(pi, cwd, "git diff --stat", signal),
		execText(pi, cwd, "git diff --cached --", signal),
		execText(pi, cwd, "git diff --", signal),
		execText(pi, cwd, "git ls-files --others --exclude-standard", signal),
	]);

	const untrackedContents = untracked && !untracked.startsWith("[command failed") ? await collectUntrackedFiles(cwd, untracked) : "";

	return [
		"# Review Context",
		"",
		`Focus: ${focus || "current work"}`,
		`Generated: ${nowIso()}`,
		`Working directory: ${cwd}`,
		"",
		"## Instructions for Oracle",
		"",
		"- Treat this snapshot as the source of truth for changed work.",
		"- Review only changed files/diff and directly related code needed to validate correctness.",
		"- Use read/grep/find/ls to inspect local files when line-level evidence is needed.",
		"- Do not modify files.",
		"",
		"## git status --short",
		"",
		"```",
		status || "(clean)",
		"```",
		"",
		"## Diff stats",
		"",
		"### staged",
		"```",
		stagedStat || "(none)",
		"```",
		"",
		"### unstaged",
		"```",
		unstagedStat || "(none)",
		"```",
		"",
		"## Staged diff",
		"",
		"```diff",
		truncateMiddle(stagedDiff || "(none)", MAX_DIFF_CHARS),
		"```",
		"",
		"## Unstaged diff",
		"",
		"```diff",
		truncateMiddle(unstagedDiff || "(none)", MAX_DIFF_CHARS),
		"```",
		untrackedContents ? "\n## Untracked file previews\n\n" + untrackedContents : "",
	].join("\n");
}

function buildAgentTask(task: string, mode: AgentJobMode, reviewContextPath?: string): string {
	if (mode !== "review") return `Task: ${task}`;
	return [
		`Review the current work relevant to: ${task || "current work"}`,
		"",
		`A parent Pi process wrote a review context snapshot at: ${reviewContextPath}`,
		"First read that file, then inspect directly related local files as needed.",
		"Keep the review evidence-first, repo-specific, concise, and action-oriented.",
		"Do not modify code.",
	].join("\n");
}

function findMissingTools(pi: ExtensionAPI, agent: AgentConfig): string[] {
	if (!agent.tools || agent.tools.length === 0 || typeof pi.getAllTools !== "function") return [];
	const available = new Set(pi.getAllTools().map((tool: any) => tool.name));
	return agent.tools.filter((tool) => !available.has(tool));
}

async function readStatus(cwd: string, jobId: string): Promise<AgentJobStatus> {
	return readJson<AgentJobStatus>(path.join(jobDirFor(cwd, jobId), "status.json"));
}

async function writeStatus(status: AgentJobStatus): Promise<void> {
	await writeJson(path.join(status.jobDir, "status.json"), status);
}

async function finalizeIfDone(pi: ExtensionAPI, cwd: string, jobId: string, sendFollowUp: boolean): Promise<AgentJobStatus> {
	let status = await readStatus(cwd, jobId);
	if (status.state === "running" && fileExists(status.exitPath)) {
		const exit = await readJson<{ exitCode: number; finishedAt: string }>(status.exitPath);
		const events = fileExists(status.eventLogPath) ? await fs.promises.readFile(status.eventLogPath, "utf8") : "";
		const stderr = fileExists(status.stderrPath) ? await fs.promises.readFile(status.stderrPath, "utf8") : "";
		const parsed = parseAgentEvents(events);
		const hasModelError = parsed.stopReason === "error" || Boolean(parsed.errorMessage);
		const state: AgentJobState = status.cancelRequestedAt
			? "cancelled"
			: exit.exitCode === 0 && !hasModelError
				? "completed"
				: "failed";
		const fallbackOutput = state === "cancelled"
			? "Cancelled by user."
			: state === "failed" && stderr.trim()
				? `Agent failed.\n\n## stderr\n\n${truncateTail(stderr, STDERR_TAIL_CHARS)}`
				: "(no output)";
		const output = parsed.finalOutput || parsed.errorMessage || fallbackOutput;
		const resultText = truncateMiddle(output, MAX_RESULT_CHARS);

		await fs.promises.writeFile(status.resultPath, `${resultText.trim()}\n`, "utf8");

		status = {
			...status,
			state,
			exitCode: exit.exitCode,
			completedAt: exit.finishedAt,
			updatedAt: nowIso(),
			summary: firstNonEmptyLine(resultText) || (state === "completed" ? "Completed with no output." : state === "cancelled" ? "Cancelled by user." : "Failed with no output."),
			errorMessage: state === "failed" ? parsed.errorMessage || (stderr.trim() ? firstNonEmptyLine(stderr) : `exit code ${exit.exitCode}`) : undefined,
			usage: parsed.usage,
		};
		await writeStatus(status);
	}

	if (sendFollowUp && needsCompletionFollowUp(status)) {
		await sendCompletionFollowUp(pi, status, await readTextIfExists(status.resultPath));
	}
	return status;
}

async function sendCompletionFollowUp(pi: ExtensionAPI, status: AgentJobStatus, resultText: string): Promise<boolean> {
	const clipped = resultText.length > FOLLOW_UP_RESULT_CHARS
		? `${resultText.slice(0, FOLLOW_UP_RESULT_CHARS).trimEnd()}\n\n…[result truncated; full result: ${status.resultPath}]…`
		: resultText;
	const verdict = status.state === "completed" ? "finished" : status.state === "cancelled" ? "was cancelled" : "failed";
	const message = [
		`Background ${status.agent} job ${status.jobId} ${verdict}.`,
		`Mode: ${status.mode}`,
		`Result file: ${status.resultPath}`,
		`Event log: ${status.eventLogPath}`,
		status.reviewContextPath ? `Review context: ${status.reviewContextPath}` : undefined,
		"",
		"## Agent Output",
		"",
		clipped.trim() || "(no output)",
		"",
		"Use this result to continue the user's workflow. If this was the first step of a researcher → oracle workflow, start the oracle step now with the relevant context.",
		completionFollowUpMarker("agent", status.jobId),
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
	const key = followUpKey("agent", status.jobId);
	if (pendingFollowUpAcks.has(key)) return true;
	if (pendingFollowUpAcks.size > 0) return false;
	pendingFollowUpAcks.set(key, { cwd: status.cwd });

	try {
		pi.sendUserMessage(message, { deliverAs: "followUp" });
		return true;
	} catch {
		pendingFollowUpAcks.delete(key);
		return false;
	}
}

function stopWatchingJob(pi: ExtensionAPI, cwd: string, jobId: string): void {
	const key = `${cwd}:${jobId}`;
	const watch = watchedJobs.get(key);
	if (!watch) return;
	clearInterval(watch.interval);
	watchedJobs.delete(key);
	emitRunningJobCount(pi, cwd);
}

function watchJob(pi: ExtensionAPI, cwd: string, jobId: string): void {
	const key = `${cwd}:${jobId}`;
	if (watchedJobs.has(key)) return;
	let polling = false;

	const poll = () => {
		if (polling) return;
		polling = true;
		void finalizeIfDone(pi, cwd, jobId, true)
			.then((status) => {
				if (status.state !== "running" && !needsCompletionFollowUp(status)) stopWatchingJob(pi, cwd, jobId);
			})
			.catch(() => {
				// Keep watching: status/result files can be transiently unavailable during atomic updates or reloads.
			})
			.finally(() => {
				polling = false;
			});
	};
	const interval = setInterval(poll, WATCH_INTERVAL_MS);
	watchedJobs.set(key, { interval, poll });
	emitRunningJobCount(pi, cwd);
	poll();
}

async function resumeRunningJobs(pi: ExtensionAPI, cwd: string): Promise<void> {
	const root = jobsRoot(cwd);
	if (!fileExists(root)) {
		emitRunningJobCount(pi, cwd);
		return;
	}
	const entries = await fs.promises.readdir(root, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			const status = await readStatus(cwd, entry.name);
			if (status.state === "running" || needsCompletionFollowUp(status)) watchJob(pi, cwd, entry.name);
		} catch {
			// Ignore malformed old job dirs.
		}
	}
	emitRunningJobCount(pi, cwd);
}

async function listStatuses(cwd: string): Promise<AgentJobStatus[]> {
	const root = jobsRoot(cwd);
	if (!fileExists(root)) return [];
	const entries = await fs.promises.readdir(root, { withFileTypes: true });
	const statuses: AgentJobStatus[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			statuses.push(await readStatus(cwd, entry.name));
		} catch {
			// Ignore malformed old job dirs.
		}
	}
	return statuses.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

type LaunchContext = {
	cwd: string;
	signal?: AbortSignal;
	hasUI?: boolean;
	ui?: {
		confirm(title: string, message: string): Promise<boolean>;
	};
};

async function launchAgentJob(
	pi: ExtensionAPI,
	ctx: LaunchContext,
	params: {
		agent: string;
		task: string;
		cwd?: string;
		agentScope?: AgentScope;
		confirmProjectAgents?: boolean;
		mode?: AgentJobMode;
		followUp?: boolean;
	},
): Promise<AgentJobStatus> {
	if (!process.env.TMUX) throw new Error("Not inside tmux — cannot start a background agent window.");

	const cwd = params.cwd ? (path.isAbsolute(params.cwd) ? params.cwd : path.resolve(ctx.cwd, params.cwd)) : ctx.cwd;
	const stat = await fs.promises.stat(cwd).catch(() => undefined);
	if (!stat?.isDirectory()) throw new Error(`Working directory not found: ${cwd}`);

	const agentScope = params.agentScope ?? "user";
	const discovery = discoverAgents(cwd, agentScope);
	const agent = discovery.agents.find((candidate) => candidate.name === params.agent);
	if (!agent) {
		const available = discovery.agents.map((candidate) => `${candidate.name} (${candidate.source})`).join(", ") || "none";
		throw new Error(`Unknown agent "${params.agent}". Available agents: ${available}`);
	}

	if (agent.source === "project" && (params.confirmProjectAgents ?? true) && ctx.hasUI && ctx.ui) {
		const ok = await ctx.ui.confirm(
			"Run project-local agent?",
			`Agent: ${agent.name}\nSource: ${agent.filePath}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
		);
		if (!ok) throw new Error("Canceled: project-local agent not approved.");
	}

	const missingTools = findMissingTools(pi, agent);
	if (missingTools.length > 0) {
		throw new Error(`Agent "${agent.name}" requires unavailable tools: ${missingTools.join(", ")}. Install/reload the needed extensions first.`);
	}

	const mode = params.mode ?? "standard";
	const jobId = createJobId(agent.name);
	const jobDir = jobDirFor(cwd, jobId);
	await fs.promises.mkdir(jobDir, { recursive: true, mode: 0o700 });

	const eventLogPath = path.join(jobDir, "events.jsonl");
	const stderrPath = path.join(jobDir, "stderr.log");
	const resultPath = path.join(jobDir, "result.md");
	const exitPath = path.join(jobDir, "exit.json");
	const pidPath = path.join(jobDir, "pid");
	const promptPath = path.join(jobDir, "prompt.md");
	const runScriptPath = path.join(jobDir, "run.sh");
	const systemPromptPath = agent.systemPrompt.trim() ? path.join(jobDir, "system-prompt.md") : undefined;
	const reviewContextPath = mode === "review" ? path.join(jobDir, "review-context.md") : undefined;

	if (reviewContextPath) {
		await fs.promises.writeFile(reviewContextPath, await collectReviewContext(pi, cwd, params.task, ctx.signal), "utf8");
	}
	if (systemPromptPath) await fs.promises.writeFile(systemPromptPath, agent.systemPrompt, { encoding: "utf8", mode: 0o600 });
	await fs.promises.writeFile(promptPath, buildAgentTask(params.task, mode, reviewContextPath), { encoding: "utf8", mode: 0o600 });

	const runScript = buildRunScript({
		cwd,
		jobId,
		agent,
		promptPath,
		systemPromptPath,
		eventLogPath,
		stderrPath,
		exitPath,
		pidPath,
		resultPath,
	});
	await fs.promises.writeFile(runScriptPath, runScript, { encoding: "utf8", mode: 0o700 });

	const tmuxWindow = `pi-${sanitizeJobPart(agent.name).slice(0, 12)}-${jobId.slice(-6)}`;
	const createdAt = nowIso();
	const status: AgentJobStatus = {
		jobId,
		agent: agent.name,
		agentSource: agent.source,
		mode,
		task: params.task,
		cwd,
		createdAt,
		updatedAt: createdAt,
		state: "running",
		tmuxWindow,
		jobDir,
		runScriptPath,
		eventLogPath,
		stderrPath,
		resultPath,
		exitPath,
		pidPath,
		promptPath,
		systemPromptPath,
		reviewContextPath,
		model: agent.model,
		tools: agent.tools,
		followUp: params.followUp ?? true,
		followUpSent: false,
	};
	await writeStatus(status);

	try {
		await execChecked(pi, "tmux", buildTmuxNewWindowArgs(tmuxWindow, cwd, runScriptPath), { signal: ctx.signal, timeout: 10_000 });
	} catch (error) {
		const failed = {
			...status,
			state: "failed" as const,
			updatedAt: nowIso(),
			completedAt: nowIso(),
			summary: "Failed to launch tmux window.",
			errorMessage: error instanceof Error ? error.message : String(error),
		};
		await writeStatus(failed);
		throw error;
	}
	watchJob(pi, cwd, jobId);
	return status;
}

function formatStarted(status: AgentJobStatus): string {
	return [
		`Started background ${status.agent} job ${status.jobId} in tmux window ${status.tmuxWindow}.`,
		`Mode: ${status.mode}`,
		`Status: ${path.join(status.jobDir, "status.json")}`,
		`Result: ${status.resultPath}`,
		`Events: ${status.eventLogPath}`,
		status.reviewContextPath ? `Review context: ${status.reviewContextPath}` : undefined,
		status.followUp
			? "The main workflow is not blocked; a follow-up message will arrive when the job finishes."
			: "The main workflow is not blocked; use agent_job_status to read the result when it finishes.",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

function formatStatus(status: AgentJobStatus, resultPreview?: string): string {
	const lines = [
		`${status.jobId} — ${status.agent} — ${status.state}`,
		`Mode: ${status.mode}`,
		`Created: ${status.createdAt}`,
		status.completedAt ? `Completed: ${status.completedAt}` : undefined,
		status.summary ? `Summary: ${status.summary}` : undefined,
		status.errorMessage ? `Error: ${status.errorMessage}` : undefined,
		`Tmux window: ${status.tmuxWindow}`,
		`Result: ${status.resultPath}`,
		`Events: ${status.eventLogPath}`,
		resultPreview ? `\n## Result Preview\n\n${resultPreview}` : undefined,
	];
	return lines.filter((line): line is string => line !== undefined).join("\n");
}

function loopJobsRoot(cwd: string): string {
	return path.join(cwd, LOOP_JOBS_DIR);
}

function loopJobDirFor(cwd: string, jobId: string): string {
	assertSafeJobId(jobId);
	return path.join(loopJobsRoot(cwd), jobId);
}

function positiveInt(name: string, value: number | undefined, fallback: number): number {
	const resolved = value ?? fallback;
	if (!Number.isInteger(resolved) || resolved <= 0) throw new Error(`${name} must be a positive integer.`);
	return resolved;
}

function nonNegativeInt(name: string, value: number | undefined, fallback: number): number {
	const resolved = value ?? fallback;
	if (!Number.isInteger(resolved) || resolved < 0) throw new Error(`${name} must be a non-negative integer.`);
	return resolved;
}

async function resolveLoopScriptPath(cwd: string, explicitPath?: string): Promise<string> {
	const candidates = explicitPath
		? [explicitPath]
		: [
			path.join(cwd, ".agents", "skills", "loop", "loop.sh"),
			path.join(os.homedir(), ".agents", "skills", "loop", "loop.sh"),
			path.join(os.homedir(), "agents", "skills", "loop", "loop.sh"),
		];

	for (const candidate of candidates) {
		const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
		const stat = await fs.promises.stat(resolved).catch(() => undefined);
		if (stat?.isFile()) return resolved;
	}

	throw new Error(`loop.sh not found. Checked: ${candidates.join(", ")}`);
}

export function buildLoopCommandArgs(params: {
	loopScriptPath: string;
	feature: string;
	task?: string;
	cwd: string;
	maxIterations: number;
	tool?: LoopTool;
	toolOrder?: string;
	agent?: string;
	sleepSeconds: number;
	pollSeconds: number;
	rateLimitStreak?: number;
}): string[] {
	const args = ["bash", params.loopScriptPath, "--feature", params.feature, "--project-root", params.cwd];
	if (params.task) args.push("--task", params.task);
	if (params.tool) args.push("--tool", params.tool);
	if (params.toolOrder) args.push("--tool-order", params.toolOrder);
	if (params.agent) args.push("--agent", params.agent);
	args.push("--sleep", String(params.sleepSeconds), "--poll", String(params.pollSeconds));
	if (params.rateLimitStreak) args.push("--rate-limit-streak", String(params.rateLimitStreak));
	args.push(String(params.maxIterations));
	return args;
}

export function buildLoopRunScript(params: {
	cwd: string;
	jobId: string;
	command: string[];
	stdoutPath: string;
	stderrPath: string;
	exitPath: string;
	pidPath: string;
	resultPath: string;
}): string {
	const command = params.command.map(shellQuote).join(" ");
	return `#!/usr/bin/env bash
set -u
cd ${shellQuote(params.cwd)}
echo "$$" > ${shellQuote(params.pidPath)}
echo "pi background loop job: ${params.jobId}"
echo "stdout: ${params.stdoutPath}"
echo "stderr: ${params.stderrPath}"
echo "result: ${params.resultPath}"
echo ""
echo "Running loop..."
${command} > ${shellQuote(params.stdoutPath)} 2> ${shellQuote(params.stderrPath)}
code=$?
finished_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
exit_tmp=${shellQuote(`${params.exitPath}.tmp`)}
printf '{"exitCode":%s,"finishedAt":"%s"}\n' "$code" "$finished_at" > "$exit_tmp"
mv "$exit_tmp" ${shellQuote(params.exitPath)}
echo ""
echo "Loop process exited with code $code"
echo "Result will be written by the parent pi extension: ${params.resultPath}"
exit "$code"
`;
}

function tokenizeCommandArgs(input: string): string[] {
	const tokens: string[] = [];
	const regex = /"((?:\\.|[^"])*)"|'([^']*)'|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(input)) !== null) {
		if (match[1] !== undefined) tokens.push(match[1].replace(/\\(["\\])/g, "$1"));
		else if (match[2] !== undefined) tokens.push(match[2]);
		else if (match[3] !== undefined) tokens.push(match[3]);
	}
	return tokens;
}

export type ParsedLoopBgArgs = {
	help?: boolean;
	feature?: string;
	task?: string;
	cwd?: string;
	maxIterations?: number;
	tool?: LoopTool;
	toolOrder?: string;
	agent?: string;
	sleepSeconds?: number;
	pollSeconds?: number;
	rateLimitStreak?: number;
	loopScriptPath?: string;
	followUp?: boolean;
};

function readValue(tokens: string[], index: number, flag: string): string {
	const value = tokens[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
	return value;
}

function parseNumberFlag(tokens: string[], index: number, flag: string): number {
	const raw = readValue(tokens, index, flag);
	const parsed = Number(raw);
	if (!Number.isInteger(parsed)) throw new Error(`${flag} must be an integer.`);
	return parsed;
}

function parseLoopTool(value: string): LoopTool {
	if (["amp", "claude", "opencode", "pi"].includes(value)) return value as LoopTool;
	throw new Error(`Unsupported loop tool: ${value}`);
}

export function parseLoopBgCommandArgs(input: string): ParsedLoopBgArgs {
	const tokens = tokenizeCommandArgs(input);
	const parsed: ParsedLoopBgArgs = {};
	const positional: string[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		switch (token) {
			case "-h":
			case "--help":
				parsed.help = true;
				break;
			case "--feature":
				parsed.feature = readValue(tokens, i, token);
				i++;
				break;
			case "--task":
				parsed.task = readValue(tokens, i, token);
				i++;
				break;
			case "--project-root":
			case "--cwd":
				parsed.cwd = readValue(tokens, i, token);
				i++;
				break;
			case "--max":
			case "--max-iterations":
				parsed.maxIterations = parseNumberFlag(tokens, i, token);
				i++;
				break;
			case "--tool":
				parsed.tool = parseLoopTool(readValue(tokens, i, token));
				i++;
				break;
			case "--tool-order":
				parsed.toolOrder = readValue(tokens, i, token);
				i++;
				break;
			case "--agent":
				parsed.agent = readValue(tokens, i, token);
				i++;
				break;
			case "--sleep":
				parsed.sleepSeconds = parseNumberFlag(tokens, i, token);
				i++;
				break;
			case "--poll":
				parsed.pollSeconds = parseNumberFlag(tokens, i, token);
				i++;
				break;
			case "--rate-limit-streak":
				parsed.rateLimitStreak = parseNumberFlag(tokens, i, token);
				i++;
				break;
			case "--loop-script":
				parsed.loopScriptPath = readValue(tokens, i, token);
				i++;
				break;
			case "--no-follow-up":
				parsed.followUp = false;
				break;
			default:
				positional.push(token);
		}
	}

	if (!parsed.feature && positional[0]) parsed.feature = positional[0];
	if (!parsed.task && positional[1] && /^TASK-[A-Za-z0-9_.-]+$/i.test(positional[1])) parsed.task = positional[1];
	const numeric = positional.find((token) => /^\d+$/.test(token));
	if (parsed.maxIterations === undefined && numeric) parsed.maxIterations = Number(numeric);
	return parsed;
}

function loopCommandUsage(): string {
	return "Usage: /loop-bg [--feature <name>] [--task TASK-002] [--max 5] [--tool pi] [--project-root <path>]";
}

export type ParsedLoopJobStatusArgs = {
	help?: boolean;
	jobId?: string;
	cwd?: string;
};

export function parseLoopJobStatusCommandArgs(input: string): ParsedLoopJobStatusArgs {
	const tokens = tokenizeCommandArgs(input);
	const parsed: ParsedLoopJobStatusArgs = {};
	const positional: string[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		switch (token) {
			case "-h":
			case "--help":
				parsed.help = true;
				break;
			case "--project-root":
			case "--cwd":
				parsed.cwd = readValue(tokens, i, token);
				i++;
				break;
			default:
				positional.push(token);
		}
	}

	if (positional[0]) parsed.jobId = positional[0];
	return parsed;
}

function loopJobStatusCommandUsage(): string {
	return "Usage: /loop-job-status [--project-root <path>] [jobId]";
}

async function readLoopStatus(cwd: string, jobId: string): Promise<LoopJobStatus> {
	return readJson<LoopJobStatus>(path.join(loopJobDirFor(cwd, jobId), "status.json"));
}

async function writeLoopStatus(status: LoopJobStatus): Promise<void> {
	await writeJson(path.join(status.jobDir, "status.json"), status);
}

async function acknowledgeCompletionFollowUp(pi: ExtensionAPI, kind: CompletionFollowUpKind, jobId: string): Promise<void> {
	const key = followUpKey(kind, jobId);
	const pending = pendingFollowUpAcks.get(key);
	if (!pending) return;

	try {
		if (kind === "agent") {
			const status = await readStatus(pending.cwd, jobId);
			if (needsCompletionFollowUp(status)) {
				await writeStatus({ ...status, followUpSent: true, updatedAt: nowIso() });
			}
			stopWatchingJob(pi, pending.cwd, jobId);
		} else {
			const status = await readLoopStatus(pending.cwd, jobId);
			if (needsCompletionFollowUp(status)) {
				await writeLoopStatus({ ...status, followUpSent: true, updatedAt: nowIso() });
			}
			stopWatchingLoopJob(pi, pending.cwd, jobId);
		}
		pendingFollowUpAcks.delete(key);
		setTimeout(pollWaitingFollowUps, 0);
	} catch {
		pendingFollowUpAcks.delete(key);
		setTimeout(pollWaitingFollowUps, WATCH_INTERVAL_MS);
	}
}

async function readTextIfExists(filePath: string): Promise<string> {
	return fileExists(filePath) ? fs.promises.readFile(filePath, "utf8") : "";
}

function formatLoopResult(status: LoopJobStatus, exitCode: number, summary: string, log: string, stdout: string, stderr: string): string {
	const sections = [
		`# Loop Job ${status.jobId}`,
		"",
		`State: ${status.cancelRequestedAt ? "cancelled" : exitCode === 0 ? "completed" : "failed"}`,
		`Feature: ${status.feature}`,
		status.task ? `Task: ${status.task}` : "Task: next ready task",
		`Project: ${status.cwd}`,
		`Exit code: ${exitCode}`,
		`Loop log: ${status.loopLogPath}`,
		`Latest iteration: ${status.loopSummaryPath}`,
		"",
		summary.trim() ? `## Latest Iteration\n\n${summary.trim()}` : undefined,
		log.trim() ? `## Loop Log Tail\n\n\`\`\`text\n${truncateTail(log.trim(), 10_000)}\n\`\`\`` : undefined,
		stderr.trim() ? `## stderr Tail\n\n\`\`\`text\n${truncateTail(stderr.trim(), 4000)}\n\`\`\`` : undefined,
		stdout.trim() ? `## stdout Tail\n\n\`\`\`text\n${truncateTail(stdout.trim(), 4000)}\n\`\`\`` : undefined,
	];
	return sections.filter((section): section is string => section !== undefined).join("\n").trim();
}

async function finalizeLoopIfDone(pi: ExtensionAPI, cwd: string, jobId: string, sendFollowUp: boolean): Promise<LoopJobStatus> {
	let status = await readLoopStatus(cwd, jobId);
	if (status.state === "running" && fileExists(status.exitPath)) {
		const exit = await readJson<{ exitCode: number; finishedAt: string }>(status.exitPath);
		const [summary, log, stdout, stderr] = await Promise.all([
			readTextIfExists(status.loopSummaryPath),
			readTextIfExists(status.loopLogPath),
			readTextIfExists(status.stdoutPath),
			readTextIfExists(status.stderrPath),
		]);
		const state: AgentJobState = status.cancelRequestedAt ? "cancelled" : exit.exitCode === 0 ? "completed" : "failed";
		const resultText = truncateMiddle(formatLoopResult(status, exit.exitCode, summary, log, stdout, stderr), MAX_RESULT_CHARS);
		await fs.promises.writeFile(status.resultPath, `${resultText.trim()}\n`, "utf8");

		status = {
			...status,
			state,
			exitCode: exit.exitCode,
			completedAt: exit.finishedAt,
			updatedAt: nowIso(),
			summary: state === "cancelled" ? "Cancelled by user." : firstNonEmptyLine(summary) || firstNonEmptyLine(log) || (state === "completed" ? "Loop completed." : `Loop exited ${exit.exitCode}.`),
			errorMessage: state === "failed" ? firstNonEmptyLine(stderr) || `exit code ${exit.exitCode}` : undefined,
		};
		await writeLoopStatus(status);
	}

	if (sendFollowUp && needsCompletionFollowUp(status)) {
		await sendLoopCompletionFollowUp(pi, status, await readTextIfExists(status.resultPath));
	}
	return status;
}

async function sendLoopCompletionFollowUp(pi: ExtensionAPI, status: LoopJobStatus, resultText: string): Promise<boolean> {
	const clipped = resultText.length > FOLLOW_UP_RESULT_CHARS
		? `${resultText.slice(0, FOLLOW_UP_RESULT_CHARS).trimEnd()}\n\n…[result truncated; full result: ${status.resultPath}]…`
		: resultText;
	const verdict = status.state === "completed" ? "finished" : status.state === "cancelled" ? "was cancelled" : "failed";
	const message = [
		`Background loop job ${status.jobId} ${verdict}.`,
		`Feature: ${status.feature}`,
		status.task ? `Task: ${status.task}` : "Task: next ready task",
		`Result file: ${status.resultPath}`,
		`Loop log: ${status.loopLogPath}`,
		`Latest iteration: ${status.loopSummaryPath}`,
		"",
		"## Loop Output",
		"",
		clipped.trim() || "(no output)",
		"",
		"Use this result to continue the user's workflow.",
		completionFollowUpMarker("loop", status.jobId),
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
	const key = followUpKey("loop", status.jobId);
	if (pendingFollowUpAcks.has(key)) return true;
	if (pendingFollowUpAcks.size > 0) return false;
	pendingFollowUpAcks.set(key, { cwd: status.cwd });

	try {
		pi.sendUserMessage(message, { deliverAs: "followUp" });
		return true;
	} catch {
		pendingFollowUpAcks.delete(key);
		return false;
	}
}

function stopWatchingLoopJob(pi: ExtensionAPI, cwd: string, jobId: string): void {
	const key = `${cwd}:${jobId}`;
	const watch = watchedLoopJobs.get(key);
	if (!watch) return;
	clearInterval(watch.interval);
	watchedLoopJobs.delete(key);
	emitRunningLoopJobCount(pi, cwd);
}

function watchLoopJob(pi: ExtensionAPI, cwd: string, jobId: string): void {
	const key = `${cwd}:${jobId}`;
	if (watchedLoopJobs.has(key)) return;
	let polling = false;

	const poll = () => {
		if (polling) return;
		polling = true;
		void finalizeLoopIfDone(pi, cwd, jobId, true)
			.then((status) => {
				if (status.state !== "running" && !needsCompletionFollowUp(status)) stopWatchingLoopJob(pi, cwd, jobId);
			})
			.catch(() => {
				// Keep watching: status/result files can be transiently unavailable during atomic updates or reloads.
			})
			.finally(() => {
				polling = false;
			});
	};
	const interval = setInterval(poll, WATCH_INTERVAL_MS);
	watchedLoopJobs.set(key, { interval, poll });
	emitRunningLoopJobCount(pi, cwd);
	poll();
}

async function resumeRunningLoopJobs(pi: ExtensionAPI, cwd: string): Promise<void> {
	const root = loopJobsRoot(cwd);
	if (!fileExists(root)) {
		emitRunningLoopJobCount(pi, cwd);
		return;
	}
	const entries = await fs.promises.readdir(root, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			const status = await readLoopStatus(cwd, entry.name);
			if (status.state === "running" || needsCompletionFollowUp(status)) watchLoopJob(pi, cwd, entry.name);
		} catch {
			// Ignore malformed old job dirs.
		}
	}
	emitRunningLoopJobCount(pi, cwd);
}

async function listLoopStatuses(cwd: string): Promise<LoopJobStatus[]> {
	const root = loopJobsRoot(cwd);
	if (!fileExists(root)) return [];
	const entries = await fs.promises.readdir(root, { withFileTypes: true });
	const statuses: LoopJobStatus[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			statuses.push(await readLoopStatus(cwd, entry.name));
		} catch {
			// Ignore malformed old job dirs.
		}
	}
	return statuses.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

type LoopLaunchParams = ParsedLoopBgArgs;

type LoopFeatureCandidate = {
	feature: string;
	tasksDir: string;
};

async function listLoopFeatureCandidates(cwd: string): Promise<LoopFeatureCandidate[]> {
	const featuresRoot = path.join(cwd, ".features");
	const entries = await fs.promises.readdir(featuresRoot, { withFileTypes: true }).catch(() => []);
	const candidates: LoopFeatureCandidate[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === "archive") continue;
		const tasksDir = path.join(featuresRoot, entry.name, "tasks");
		const tasksStat = await fs.promises.stat(tasksDir).catch(() => undefined);
		if (tasksStat?.isDirectory()) candidates.push({ feature: entry.name, tasksDir });
	}

	return candidates;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function taskFileTexts(tasksDir: string): Promise<string[]> {
	const entries = await fs.promises.readdir(tasksDir, { withFileTypes: true }).catch(() => []);
	const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "_active.md");
	return Promise.all(files.map((entry) => fs.promises.readFile(path.join(tasksDir, entry.name), "utf8").catch(() => "")));
}

async function featureHasTask(candidate: LoopFeatureCandidate, task: string): Promise<boolean> {
	const idPattern = new RegExp(`^id:\\s*${escapeRegExp(task)}\\s*$`, "im");
	return (await taskFileTexts(candidate.tasksDir)).some((text) => idPattern.test(text) || new RegExp(`^#\\s*${escapeRegExp(task)}\\b`, "im").test(text));
}

async function featureHasReadyTask(candidate: LoopFeatureCandidate): Promise<boolean> {
	return (await taskFileTexts(candidate.tasksDir)).some((text) => /^status:\s*(ready|open)\b/im.test(text));
}

export async function resolveLoopFeature(cwd: string, feature?: string, task?: string): Promise<string> {
	const candidates = await listLoopFeatureCandidates(cwd);
	if (feature) {
		const match = candidates.find((candidate) => candidate.feature === feature);
		if (!match) throw new Error(`Feature '${feature}' not found at ${path.join(cwd, ".features", feature, "tasks")}`);
		return match.feature;
	}

	if (task) {
		const matches: LoopFeatureCandidate[] = [];
		for (const candidate of candidates) {
			if (await featureHasTask(candidate, task)) matches.push(candidate);
		}
		if (matches.length === 1) return matches[0]!.feature;
		if (matches.length > 1) throw new Error(`Task '${task}' exists in multiple features: ${matches.map((candidate) => candidate.feature).join(", ")}. Pass feature explicitly.`);
	}

	const ready: LoopFeatureCandidate[] = [];
	for (const candidate of candidates) {
		if (await featureHasReadyTask(candidate)) ready.push(candidate);
	}
	if (ready.length === 1) return ready[0]!.feature;
	if (candidates.length === 1) return candidates[0]!.feature;

	const available = candidates.map((candidate) => candidate.feature).join(", ") || "none";
	throw new Error(`Feature not specified and could not infer a single loop feature. Available features: ${available}. Pass feature explicitly.`);
}

async function launchLoopJob(pi: ExtensionAPI, ctx: LaunchContext, params: LoopLaunchParams): Promise<LoopJobStatus> {
	if (!process.env.TMUX) throw new Error("Not inside tmux — cannot start a background loop window.");

	const cwd = params.cwd ? (path.isAbsolute(params.cwd) ? params.cwd : path.resolve(ctx.cwd, params.cwd)) : ctx.cwd;
	const stat = await fs.promises.stat(cwd).catch(() => undefined);
	if (!stat?.isDirectory()) throw new Error(`Working directory not found: ${cwd}`);

	const feature = await resolveLoopFeature(cwd, params.feature, params.task);

	const loopScriptPath = await resolveLoopScriptPath(cwd, params.loopScriptPath);
	const maxIterations = positiveInt("maxIterations", params.maxIterations, LOOP_DEFAULT_MAX_ITERATIONS);
	const sleepSeconds = nonNegativeInt("sleepSeconds", params.sleepSeconds, LOOP_DEFAULT_SLEEP_SECONDS);
	const pollSeconds = nonNegativeInt("pollSeconds", params.pollSeconds, LOOP_DEFAULT_POLL_SECONDS);
	const rateLimitStreak = positiveInt("rateLimitStreak", params.rateLimitStreak, LOOP_DEFAULT_RATE_LIMIT_STREAK);
	const jobId = createJobId(`loop-${feature}`);
	const jobDir = loopJobDirFor(cwd, jobId);
	await fs.promises.mkdir(jobDir, { recursive: true, mode: 0o700 });

	const loopArtifactsDir = path.join(cwd, ".features", feature, "artifacts", "loop");
	const loopLogPath = path.join(loopArtifactsDir, "loop.log");
	const loopSummaryPath = path.join(loopArtifactsDir, "latest-iteration.md");
	const loopProgressPath = path.join(loopArtifactsDir, "progress.txt");
	const stdoutPath = path.join(jobDir, "stdout.log");
	const stderrPath = path.join(jobDir, "stderr.log");
	const resultPath = path.join(jobDir, "result.md");
	const exitPath = path.join(jobDir, "exit.json");
	const pidPath = path.join(jobDir, "pid");
	const runScriptPath = path.join(jobDir, "run.sh");
	const command = buildLoopCommandArgs({
		loopScriptPath,
		feature,
		task: params.task,
		cwd,
		maxIterations,
		tool: params.tool,
		toolOrder: params.toolOrder,
		agent: params.agent,
		sleepSeconds,
		pollSeconds,
		rateLimitStreak,
	});

	const runScript = buildLoopRunScript({ cwd, jobId, command, stdoutPath, stderrPath, exitPath, pidPath, resultPath });
	await fs.promises.writeFile(runScriptPath, runScript, { encoding: "utf8", mode: 0o700 });

	const tmuxWindow = `pi-loop-${jobId.slice(-6)}`;
	const createdAt = nowIso();
	const status: LoopJobStatus = {
		jobId,
		feature,
		task: params.task,
		cwd,
		createdAt,
		updatedAt: createdAt,
		state: "running",
		tmuxWindow,
		jobDir,
		runScriptPath,
		stdoutPath,
		stderrPath,
		resultPath,
		exitPath,
		pidPath,
		loopLogPath,
		loopSummaryPath,
		loopProgressPath,
		loopScriptPath,
		command,
		maxIterations,
		tool: params.tool,
		toolOrder: params.toolOrder,
		agent: params.agent,
		sleepSeconds,
		pollSeconds,
		rateLimitStreak,
		followUp: params.followUp ?? true,
		followUpSent: false,
	};
	await writeLoopStatus(status);

	try {
		await execChecked(pi, "tmux", buildTmuxNewWindowArgs(tmuxWindow, cwd, runScriptPath), { signal: ctx.signal, timeout: 10_000 });
	} catch (error) {
		const failed = {
			...status,
			state: "failed" as const,
			updatedAt: nowIso(),
			completedAt: nowIso(),
			summary: "Failed to launch tmux window.",
			errorMessage: error instanceof Error ? error.message : String(error),
		};
		await writeLoopStatus(failed);
		throw error;
	}
	watchLoopJob(pi, cwd, jobId);
	return status;
}

function formatLoopStarted(status: LoopJobStatus): string {
	return [
		`Started background loop job ${status.jobId} in tmux window ${status.tmuxWindow}.`,
		`Feature: ${status.feature}`,
		status.task ? `Task: ${status.task}` : "Task: next ready task",
		`Status: ${path.join(status.jobDir, "status.json")}`,
		`Result: ${status.resultPath}`,
		`Loop log: ${status.loopLogPath}`,
		`Latest iteration: ${status.loopSummaryPath}`,
		status.followUp
			? "The main workflow is not blocked; a follow-up message will arrive when the loop finishes."
			: "The main workflow is not blocked; use loop_job_status to read the result when it finishes.",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

function formatLoopStatus(status: LoopJobStatus, resultPreview?: string): string {
	const lines = [
		`${status.jobId} — loop:${status.feature} — ${status.state}`,
		status.task ? `Task: ${status.task}` : "Task: next ready task",
		`Created: ${status.createdAt}`,
		status.completedAt ? `Completed: ${status.completedAt}` : undefined,
		status.summary ? `Summary: ${status.summary}` : undefined,
		status.errorMessage ? `Error: ${status.errorMessage}` : undefined,
		`Tmux window: ${status.tmuxWindow}`,
		`Result: ${status.resultPath}`,
		`Loop log: ${status.loopLogPath}`,
		`Latest iteration: ${status.loopSummaryPath}`,
		resultPreview ? `\n## Result Preview\n\n${resultPreview}` : undefined,
	];
	return lines.filter((line): line is string => line !== undefined).join("\n");
}

export default function agentJobsExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		void resumeRunningJobs(pi, ctx.cwd);
		void resumeRunningLoopJobs(pi, ctx.cwd);
	});

	pi.on("message_start", async (event) => {
		if (event.message.role !== "user") return;
		const marker = parseCompletionFollowUpMarker(textFromMessageContent(event.message.content));
		if (!marker) return;
		await acknowledgeCompletionFollowUp(pi, marker.kind, marker.jobId);
	});

	pi.on("session_shutdown", () => {
		for (const watch of watchedJobs.values()) clearInterval(watch.interval);
		for (const watch of watchedLoopJobs.values()) clearInterval(watch.interval);
		watchedJobs.clear();
		watchedLoopJobs.clear();
		pendingFollowUpAcks.clear();
	});

	pi.registerCommand("research-bg", {
		description: "Run the researcher agent in a background tmux window",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!task) {
				ctx.ui.notify("Usage: /research-bg <topic>", "warning");
				return;
			}
			try {
				const status = await launchAgentJob(pi, ctx, { agent: "researcher", task, mode: "standard" });
				ctx.ui.notify(`Started researcher job ${status.jobId}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("ask-oracle-bg", {
		description: "Run the oracle agent in a background tmux window",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!task) {
				ctx.ui.notify("Usage: /ask-oracle-bg <question>", "warning");
				return;
			}
			try {
				const status = await launchAgentJob(pi, ctx, { agent: "oracle", task, mode: "standard" });
				ctx.ui.notify(`Started oracle job ${status.jobId}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("deep-review-bg", {
		description: "Run an oracle review with a git diff snapshot in a background tmux window",
		handler: async (args, ctx) => {
			const task = args.trim() || "current work";
			try {
				const status = await launchAgentJob(pi, ctx, { agent: "oracle", task, mode: "review" });
				ctx.ui.notify(`Started oracle review job ${status.jobId}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("agent-job-status", {
		description: "Show background agent job status (usage: /agent-job-status [jobId])",
		handler: async (args, ctx) => {
			const jobId = args.trim();
			try {
				if (jobId) {
					const status = await finalizeIfDone(pi, ctx.cwd, jobId, false);
					ctx.ui.notify(`${status.jobId}: ${status.state}${status.summary ? ` — ${status.summary}` : ""}`, "info");
					return;
				}
				const statuses = await listStatuses(ctx.cwd);
				if (statuses.length === 0) ctx.ui.notify("No background agent jobs found", "info");
				else ctx.ui.notify(statuses.slice(0, 5).map((status) => `${status.jobId}: ${status.state}`).join("\n"), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("loop-bg", {
		description: "Run loop.sh for a feature in a background tmux window",
		handler: async (args, ctx) => {
			try {
				const parsed = parseLoopBgCommandArgs(args.trim());
				if (parsed.help) {
					ctx.ui.notify(loopCommandUsage(), "info");
					return;
				}
				const status = await launchLoopJob(pi, ctx, parsed);
				ctx.ui.notify(`Started loop job ${status.jobId}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("loop-job-status", {
		description: "Show background loop job status (usage: /loop-job-status [--project-root <path>] [jobId])",
		handler: async (args, ctx) => {
			try {
				const parsed = parseLoopJobStatusCommandArgs(args.trim());
				if (parsed.help) {
					ctx.ui.notify(loopJobStatusCommandUsage(), "info");
					return;
				}
				const cwd = parsed.cwd ? (path.isAbsolute(parsed.cwd) ? parsed.cwd : path.resolve(ctx.cwd, parsed.cwd)) : ctx.cwd;
				if (parsed.jobId) {
					const status = await finalizeLoopIfDone(pi, cwd, parsed.jobId, false);
					ctx.ui.notify(`${status.jobId}: ${status.state}${status.summary ? ` — ${status.summary}` : ""}`, "info");
					return;
				}
				const statuses = await listLoopStatuses(cwd);
				if (statuses.length === 0) ctx.ui.notify("No background loop jobs found", "info");
				else ctx.ui.notify(statuses.slice(0, 5).map((status) => `${status.jobId}: ${status.state}`).join("\n"), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerTool({
		name: "agent_job_start",
		label: "Agent Job Start",
		description:
			"Start a specialized agent in a detached tmux window and return immediately. " +
			"The job writes status, JSON events, stderr, and final result files under .pi/agent-jobs, then sends a follow-up message when finished.",
		parameters: Type.Object({
			agent: Type.String({ description: 'Agent name to run, e.g. "researcher" or "oracle".' }),
			task: Type.String({ description: "Task to delegate to the background agent." }),
			cwd: Type.Optional(Type.String({ description: "Working directory for the agent process. Defaults to current cwd." })),
			agentScope: Type.Optional(AgentScopeSchema),
			confirmProjectAgents: Type.Optional(Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true })),
			mode: Type.Optional(AgentJobModeSchema),
			followUp: Type.Optional(Type.Boolean({ description: "Send a follow-up user message when the job finishes. Default: true.", default: true })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const status = await launchAgentJob(pi, { cwd: ctx.cwd, signal }, {
				agent: params.agent,
				task: params.task,
				cwd: params.cwd,
				agentScope: params.agentScope as AgentScope | undefined,
				confirmProjectAgents: params.confirmProjectAgents,
				mode: params.mode as AgentJobMode | undefined,
				followUp: params.followUp,
			});
			return {
				content: [{ type: "text" as const, text: formatStarted(status) }],
				details: status,
				terminate: true,
			};
		},
		renderCall(args, theme) {
			const mode = args.mode && args.mode !== "standard" ? ` [${args.mode}]` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("agent_job_start "))}${theme.fg("accent", args.agent || "agent")}${theme.fg("dim", mode)}`, 0, 0);
		},
		renderResult(result, _options, theme, context) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			return new Text(context.isError ? theme.fg("error", text) : theme.fg("success", text), 0, 0);
		},
	});

	pi.registerTool({
		name: "agent_job_status",
		label: "Agent Job Status",
		description: "Check a background agent job, or list recent jobs when jobId is omitted.",
		parameters: Type.Object({
			jobId: Type.Optional(Type.String({ description: "Job id returned by agent_job_start." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.jobId) {
				const status = await finalizeIfDone(pi, ctx.cwd, params.jobId, false);
				const preview = fileExists(status.resultPath) ? truncateTail(await fs.promises.readFile(status.resultPath, "utf8"), 6000) : undefined;
				return { content: [{ type: "text" as const, text: formatStatus(status, preview) }], details: status };
			}
			const statuses = await listStatuses(ctx.cwd);
			const text = statuses.length === 0
				? "No background agent jobs found."
				: statuses.slice(0, 10).map((status) => `${status.jobId}\t${status.agent}\t${status.state}\t${status.summary || ""}`).join("\n");
			return { content: [{ type: "text" as const, text }], details: { jobs: statuses.slice(0, 10) } };
		},
	});

	pi.registerTool({
		name: "loop_job_start",
		label: "Loop Job Start",
		description:
			"Start loop.sh for a project feature/task in a detached tmux window and return immediately. " +
			"Use when the user says things like 'run a loop for this task in background'. " +
			"The job writes status and result files under .pi/loop-jobs, reuses .features/{feature}/artifacts/loop/, and sends a follow-up message when finished.",
		promptSnippet: "Run loop.sh for a feature/task in a background tmux window and notify when it finishes",
		promptGuidelines: [
			"Use loop_job_start when the user asks to run/start/continue a task loop in the background or says 'run a loop for this task in background'.",
			"For loop_job_start, infer feature/task from the current task context when possible; if missing, inspect .features/*/tasks/_active.md or pass task only and let the tool infer the feature.",
			"For loop_job_start, use maxIterations around 5 for a named task and around 20 for a whole feature unless the user specifies otherwise.",
		],
		parameters: Type.Object({
			feature: Type.Optional(Type.String({ description: "Feature folder name under .features/. Optional when task uniquely identifies a feature or only one feature has ready work." })),
			task: Type.Optional(Type.String({ description: "Optional target task id, e.g. TASK-002. When omitted, loop.sh picks the next ready task." })),
			cwd: Type.Optional(Type.String({ description: "Project root to run in. Defaults to current cwd." })),
			maxIterations: Type.Optional(Type.Number({ description: `Maximum loop iterations (default ${LOOP_DEFAULT_MAX_ITERATIONS}).`, minimum: 1, maximum: 100 })),
			tool: Type.Optional(LoopToolSchema),
			toolOrder: Type.Optional(Type.String({ description: 'Tool priority for loop.sh auto-detection, e.g. "pi,amp,claude,opencode".' })),
			agent: Type.Optional(Type.String({ description: "Optional Pi agent name passed through to loop.sh --agent." })),
			sleepSeconds: Type.Optional(Type.Number({ description: `Delay between iterations (default ${LOOP_DEFAULT_SLEEP_SECONDS}).`, minimum: 0, maximum: 3600 })),
			pollSeconds: Type.Optional(Type.Number({ description: `Heartbeat log interval while each iteration runs (default ${LOOP_DEFAULT_POLL_SECONDS}).`, minimum: 0, maximum: 3600 })),
			rateLimitStreak: Type.Optional(Type.Number({ description: `Consecutive rate-limit failures before stopping (default ${LOOP_DEFAULT_RATE_LIMIT_STREAK}).`, minimum: 1, maximum: 100 })),
			loopScriptPath: Type.Optional(Type.String({ description: "Optional explicit path to loop.sh. Defaults to project/user loop skill locations." })),
			followUp: Type.Optional(Type.Boolean({ description: "Send a follow-up user message when the loop finishes. Default: true.", default: true })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const status = await launchLoopJob(pi, { cwd: ctx.cwd, signal }, {
				feature: params.feature,
				task: params.task,
				cwd: params.cwd,
				maxIterations: params.maxIterations,
				tool: params.tool as LoopTool | undefined,
				toolOrder: params.toolOrder,
				agent: params.agent,
				sleepSeconds: params.sleepSeconds,
				pollSeconds: params.pollSeconds,
				rateLimitStreak: params.rateLimitStreak,
				loopScriptPath: params.loopScriptPath,
				followUp: params.followUp,
			});
			return {
				content: [{ type: "text" as const, text: formatLoopStarted(status) }],
				details: status,
				terminate: true,
			};
		},
		renderCall(args, theme) {
			const task = args.task ? ` ${args.task}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("loop_job_start "))}${theme.fg("accent", args.feature || "feature")}${theme.fg("dim", task)}`, 0, 0);
		},
		renderResult(result, _options, theme, context) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			return new Text(context.isError ? theme.fg("error", text) : theme.fg("success", text), 0, 0);
		},
	});

	pi.registerTool({
		name: "loop_job_status",
		label: "Loop Job Status",
		description: "Check a background loop job, or list recent loop jobs when jobId is omitted.",
		parameters: Type.Object({
			jobId: Type.Optional(Type.String({ description: "Job id returned by loop_job_start." })),
			cwd: Type.Optional(Type.String({ description: "Project root where the loop job was started. Defaults to current cwd." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = params.cwd ? (path.isAbsolute(params.cwd) ? params.cwd : path.resolve(ctx.cwd, params.cwd)) : ctx.cwd;
			if (params.jobId) {
				const status = await finalizeLoopIfDone(pi, cwd, params.jobId, false);
				const preview = fileExists(status.resultPath) ? truncateTail(await fs.promises.readFile(status.resultPath, "utf8"), 6000) : undefined;
				return { content: [{ type: "text" as const, text: formatLoopStatus(status, preview) }], details: status };
			}
			const statuses = await listLoopStatuses(cwd);
			const text = statuses.length === 0
				? "No background loop jobs found."
				: statuses.slice(0, 10).map((status) => `${status.jobId}\t${status.feature}\t${status.state}\t${status.summary || ""}`).join("\n");
			return { content: [{ type: "text" as const, text }], details: { jobs: statuses.slice(0, 10) } };
		},
	});

	pi.registerTool({
		name: "loop_job_cancel",
		label: "Loop Job Cancel",
		description: "Cancel a running background loop job by sending Ctrl+C to its tmux window.",
		parameters: Type.Object({
			jobId: Type.String({ description: "Job id returned by loop_job_start." }),
			cwd: Type.Optional(Type.String({ description: "Project root where the loop job was started. Defaults to current cwd." })),
			killWindow: Type.Optional(Type.Boolean({ description: "Also kill the tmux window after sending Ctrl+C. Default: false.", default: false })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cwd = params.cwd ? (path.isAbsolute(params.cwd) ? params.cwd : path.resolve(ctx.cwd, params.cwd)) : ctx.cwd;
			const status = await readLoopStatus(cwd, params.jobId);
			if (status.state !== "running") {
				return { content: [{ type: "text" as const, text: `Loop job ${status.jobId} is already ${status.state}.` }], details: status };
			}
			if (status.cancelRequestedAt) {
				return { content: [{ type: "text" as const, text: `Cancellation is already pending for loop job ${status.jobId}.` }], details: status };
			}
			await execChecked(pi, "tmux", ["send-keys", "-t", status.tmuxWindow, "C-c"], { signal, timeout: 5000 });
			const requestedAt = nowIso();
			const pending = { ...status, cancelRequestedAt: requestedAt, updatedAt: requestedAt, summary: "Cancellation requested; waiting for the process to exit." };
			if (params.killWindow) {
				try {
					await execChecked(pi, "tmux", ["kill-window", "-t", status.tmuxWindow], { signal, timeout: 5000 });
				} catch (error) {
					await writeLoopStatus(pending);
					throw new Error(`Hard cancellation failed for loop job ${status.jobId}; soft cancellation remains pending.`, { cause: error });
				}
			}
			const updated = params.killWindow
				? { ...pending, state: "cancelled" as const, completedAt: requestedAt, summary: "Cancelled by user." }
				: pending;
			await writeLoopStatus(updated);
			if (params.killWindow) stopWatchingLoopJob(pi, status.cwd, status.jobId);
			return { content: [{ type: "text" as const, text: params.killWindow ? `Cancelled loop job ${status.jobId}.` : `Cancellation requested for loop job ${status.jobId}.` }], details: updated };
		},
	});

	pi.registerTool({
		name: "agent_job_cancel",
		label: "Agent Job Cancel",
		description: "Cancel a running background agent job by sending Ctrl+C to its tmux window.",
		parameters: Type.Object({
			jobId: Type.String({ description: "Job id returned by agent_job_start." }),
			killWindow: Type.Optional(Type.Boolean({ description: "Also kill the tmux window after sending Ctrl+C. Default: false.", default: false })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const status = await readStatus(ctx.cwd, params.jobId);
			if (status.state !== "running") {
				return { content: [{ type: "text" as const, text: `Job ${status.jobId} is already ${status.state}.` }], details: status };
			}
			if (status.cancelRequestedAt) {
				return { content: [{ type: "text" as const, text: `Cancellation is already pending for job ${status.jobId}.` }], details: status };
			}
			await execChecked(pi, "tmux", ["send-keys", "-t", status.tmuxWindow, "C-c"], { signal, timeout: 5000 });
			const requestedAt = nowIso();
			const pending = { ...status, cancelRequestedAt: requestedAt, updatedAt: requestedAt, summary: "Cancellation requested; waiting for the process to exit." };
			if (params.killWindow) {
				try {
					await execChecked(pi, "tmux", ["kill-window", "-t", status.tmuxWindow], { signal, timeout: 5000 });
				} catch (error) {
					await writeStatus(pending);
					throw new Error(`Hard cancellation failed for job ${status.jobId}; soft cancellation remains pending.`, { cause: error });
				}
			}
			const updated = params.killWindow
				? { ...pending, state: "cancelled" as const, completedAt: requestedAt, summary: "Cancelled by user." }
				: pending;
			await writeStatus(updated);
			if (params.killWindow) stopWatchingJob(pi, status.cwd, status.jobId);
			return { content: [{ type: "text" as const, text: params.killWindow ? `Cancelled job ${status.jobId}.` : `Cancellation requested for job ${status.jobId}.` }], details: updated };
		},
	});
}
