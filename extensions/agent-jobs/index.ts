import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, ProjectTrustStore, truncateHead, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { execChecked } from "../lib/process.ts";

type AgentThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

const AGENT_JOB_MODES = ["standard", "review"] as const;
const AGENT_JOB_STATES = ["running", "completed", "failed", "cancelled"] as const;
const LOOP_TOOLS = ["amp", "claude", "opencode", "pi"] as const;

export type AgentJobMode = (typeof AGENT_JOB_MODES)[number];
export type AgentJobState = (typeof AGENT_JOB_STATES)[number];
export type LoopTool = (typeof LOOP_TOOLS)[number];

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
	launcher?: "process" | "tmux";
	processId?: number;
	tmuxWindow?: string;
	originSessionId?: string;
	originSessionFile?: string;
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
	launcher?: "process" | "tmux";
	processId?: number;
	tmuxWindow?: string;
	originSessionId?: string;
	originSessionFile?: string;
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
type SessionIdentity = { id?: string; file?: string };
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

function sessionIdentityFromContext(ctx: { sessionManager?: { getSessionId?(): string; getSessionFile?(): string | undefined } }): SessionIdentity {
	return {
		id: ctx.sessionManager?.getSessionId?.(),
		file: ctx.sessionManager?.getSessionFile?.(),
	};
}

function isOriginSession(status: AgentJobStatus | LoopJobStatus, session: SessionIdentity): boolean {
	if (status.originSessionId) return status.originSessionId === session.id;
	if (status.originSessionFile) return status.originSessionFile === session.file;
	return true;
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

const AgentJobModeSchema = StringEnum(AGENT_JOB_MODES, {
	description: 'Job prompt mode. Use "review" for oracle reviews so the launcher snapshots git diff context first.',
	default: "standard",
});

const LoopToolSchema = StringEnum(LOOP_TOOLS, {
	description: "Tool used by loop.sh for each implementation iteration. Defaults to loop.sh auto-detection.",
});

const MAX_JOB_SUMMARY_TEXT_CHARS = 1_000;

const JobLifecycleFields = {
	task: Type.Optional(Type.String({ description: `First ${MAX_JOB_SUMMARY_TEXT_CHARS} characters of the task.` })),
	cwd: Type.Optional(Type.String()),
	createdAt: Type.Optional(Type.String()),
	updatedAt: Type.Optional(Type.String()),
	completedAt: Type.Optional(Type.String()),
	cancelRequestedAt: Type.Optional(Type.String()),
	exitCode: Type.Optional(Type.Number()),
	summary: Type.Optional(Type.String()),
	errorMessage: Type.Optional(Type.String()),
	resultPath: Type.Optional(Type.String()),
};

const AgentJobSummarySchema = Type.Object({
	jobId: Type.String(),
	state: StringEnum(AGENT_JOB_STATES),
	...JobLifecycleFields,
	agent: Type.Optional(Type.String()),
	mode: Type.Optional(StringEnum(AGENT_JOB_MODES)),
	model: Type.Optional(Type.String()),
	followUp: Type.Optional(Type.Boolean()),
});

const LoopJobSummarySchema = Type.Object({
	jobId: Type.Optional(Type.String()),
	state: Type.Optional(StringEnum(AGENT_JOB_STATES)),
	...JobLifecycleFields,
	feature: Type.Optional(Type.String()),
	maxIterations: Type.Optional(Type.Number()),
	tool: Type.Optional(StringEnum(LOOP_TOOLS)),
	agent: Type.Optional(Type.String()),
	loopSummaryPath: Type.Optional(Type.String()),
	loopProgressPath: Type.Optional(Type.String()),
}, { description: "Loop status files are not validated on read, so every field is optional." });

function jobStatusOutputSchema(summarySchema: typeof AgentJobSummarySchema | typeof LoopJobSummarySchema) {
	return Type.Object({
		job: Type.Optional(summarySchema),
		resultPreview: Type.Optional(Type.String({ description: "Tail of the job result file, when it exists." })),
		jobs: Type.Optional(Type.Array(summarySchema, { description: "Most recent jobs; present when jobId is omitted." })),
	});
}

// Persisted status files may hold legacy or hand-edited values; script summaries keep only well-typed, bounded fields.
function summaryText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.length > MAX_JOB_SUMMARY_TEXT_CHARS ? `${value.slice(0, MAX_JOB_SUMMARY_TEXT_CHARS)}…` : value;
}

function summaryPath(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function summaryNumber(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function summaryEnum<T extends string>(values: readonly T[], value: unknown): T | undefined {
	return values.find((candidate) => candidate === value);
}

function lifecycleSummary(status: AgentJobStatus | LoopJobStatus) {
	return {
		task: summaryText(status.task),
		cwd: summaryPath(status.cwd),
		createdAt: summaryText(status.createdAt),
		updatedAt: summaryText(status.updatedAt),
		completedAt: summaryText(status.completedAt),
		cancelRequestedAt: summaryText(status.cancelRequestedAt),
		exitCode: summaryNumber(status.exitCode),
		summary: summaryText(status.summary),
		errorMessage: summaryText(status.errorMessage),
		resultPath: summaryPath(status.resultPath),
	};
}

/** Job fields for Code Mode scripts; process ids, tmux windows, origin sessions, and launcher files stay internal. */
function agentJobSummary(status: AgentJobStatus) {
	return {
		jobId: status.jobId,
		state: status.state,
		...lifecycleSummary(status),
		agent: summaryText(status.agent),
		mode: summaryEnum(AGENT_JOB_MODES, status.mode),
		model: summaryText(status.model),
		followUp: typeof status.followUp === "boolean" ? status.followUp : undefined,
	};
}

/** Loop fields for Code Mode scripts; process ids, tmux windows, origin sessions, commands, and launcher files stay internal. */
function loopJobSummary(status: LoopJobStatus) {
	return {
		jobId: summaryText(status.jobId),
		state: summaryEnum(AGENT_JOB_STATES, status.state),
		...lifecycleSummary(status),
		feature: summaryText(status.feature),
		agent: summaryText(status.agent),
		tool: summaryEnum(LOOP_TOOLS, status.tool),
		maxIterations: summaryNumber(status.maxIterations),
		loopSummaryPath: summaryPath(status.loopSummaryPath),
		loopProgressPath: summaryPath(status.loopProgressPath),
	};
}

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

export function shouldTerminateAfterAgentJobStart(followUp: boolean): boolean {
	return followUp;
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

function buildPiInvocationArgs(agent: AgentConfig, promptPath: string, systemPromptPath?: string, thinkingLevel?: AgentThinkingLevel): string[] {
	const args = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (thinkingLevel) args.push("--thinking", thinkingLevel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	if (systemPromptPath) args.push("--append-system-prompt", systemPromptPath);
	args.push(`@${promptPath}`, "Execute the task described in the attached prompt file.");
	return args;
}

function buildPiCommand(agent: AgentConfig, promptPath: string, systemPromptPath?: string, thinkingLevel?: AgentThinkingLevel): string {
	const args = buildPiInvocationArgs(agent, promptPath, systemPromptPath, thinkingLevel);
	return ["pi", ...args].map(shellQuote).join(" ");
}

export function buildRunScript(params: {
	cwd: string;
	jobId: string;
	agent: AgentConfig;
	thinkingLevel?: AgentThinkingLevel;
	promptPath: string;
	systemPromptPath?: string;
	eventLogPath: string;
	stderrPath: string;
	exitPath: string;
	pidPath: string;
	resultPath: string;
}): string {
	const piCommand = buildPiCommand(params.agent, params.promptPath, params.systemPromptPath, params.thinkingLevel);
	return `#!/usr/bin/env bash
set -u
cd ${shellQuote(params.cwd)}
echo "pi background agent job: ${params.jobId}"
echo "agent: ${params.agent.name}"
echo "events: ${params.eventLogPath}"
echo "stderr: ${params.stderrPath}"
echo "result: ${params.resultPath}"
echo ""
echo "Running agent in JSON mode..."
child_pid=""
forward_signal() {
  if [ -n "$child_pid" ]; then kill -"$1" "$child_pid" 2>/dev/null || true; fi
}
trap 'forward_signal INT' INT
trap 'forward_signal TERM' TERM
${piCommand} > ${shellQuote(params.eventLogPath)} 2> ${shellQuote(params.stderrPath)} &
child_pid=$!
echo "$$" > ${shellQuote(params.pidPath)}
wait "$child_pid"
code=$?
if kill -0 "$child_pid" 2>/dev/null; then
  wait "$child_pid"
  child_code=$?
  if [ "$child_code" -ne 0 ]; then code=$child_code; fi
fi
trap - INT TERM
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

export async function launchDetachedRunScript(cwd: string, runScriptPath: string, readyPath?: string): Promise<number> {
	const processId = await new Promise<number>((resolve, reject) => {
		const child = spawn("bash", [runScriptPath], {
			cwd,
			detached: true,
			stdio: "ignore",
		});
		const onError = (error: Error) => reject(error);
		child.once("error", onError);
		child.once("spawn", () => {
			child.off("error", onError);
			if (!child.pid) {
				reject(new Error("Detached background process started without a process id."));
				return;
			}
			child.unref();
			resolve(child.pid);
		});
	});
	if (!readyPath) return processId;

	const deadline = Date.now() + 2000;
	while (!fileExists(readyPath)) {
		if (Date.now() >= deadline) {
			signalDetachedProcess(processId, "SIGKILL");
			throw new Error(`Detached background process did not become ready: ${readyPath}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return processId;
}

function signalDetachedProcess(processId: number, signal: NodeJS.Signals): boolean {
	if (!Number.isInteger(processId) || processId <= 0) throw new Error(`Invalid background process id: ${processId}`);
	try {
		process.kill(-processId, signal);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		if (code !== "EINVAL" && code !== "EPERM") throw error;
	}
	try {
		process.kill(processId, signal);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
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

export function buildAgentTask(task: string, mode: AgentJobMode, reviewContextPath?: string): string {
	if (mode !== "review") return `Task: ${task}`;
	return [
		`Review the current work relevant to: ${task || "current work"}`,
		"",
		`A parent Pi process wrote a review context snapshot at: ${reviewContextPath}`,
		"First read that file, then inspect directly related local files as needed.",
		"Run the Are You Proud validation as part of this review, including its five-topic quality review.",
		"Keep the review evidence-first, repo-specific, concise, and action-oriented.",
		"Do not modify code.",
	].join("\n");
}

function findMissingTools(pi: ExtensionAPI, agent: AgentConfig): string[] {
	if (!agent.tools || agent.tools.length === 0 || typeof pi.getAllTools !== "function") return [];
	const available = new Set(pi.getAllTools().map((tool: any) => tool.name));
	return agent.tools.filter((tool) => !available.has(tool));
}

async function assertArtifactPath(file: string, directory = false): Promise<void> {
	const stat = await fs.promises.lstat(file).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (stat && (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()))) {
		throw new Error(`Invalid job artifact (symlink or unexpected type): ${file}`);
	}
}

async function trustedAgentRoot(ctx: { cwd: string; isProjectTrusted?(): boolean }, requested?: string): Promise<string> {
	if (!ctx.isProjectTrusted?.()) throw new Error("Agent jobs require a trusted Pi session.");
	const root = await fs.promises.realpath(path.resolve(ctx.cwd, requested ?? "."));
	const sessionRoot = await fs.promises.realpath(ctx.cwd);
	const trust = new ProjectTrustStore(getAgentDir());
	if ((root !== sessionRoot && (trust.get(root) !== true || trust.get(jobsRoot(root)) !== true)) || trust.get(jobsRoot(root)) === false) {
		throw new Error(`Agent job target is not trusted: ${root}`);
	}
	await assertArtifactPath(path.join(root, ".pi"), true);
	await assertArtifactPath(jobsRoot(root), true);
	return root;
}

async function readStatus(cwd: string, jobId: string): Promise<AgentJobStatus> {
	const root = await fs.promises.realpath(cwd);
	const jobDir = jobDirFor(root, jobId);
	for (const dir of [path.join(root, ".pi"), jobsRoot(root), jobDir]) await assertArtifactPath(dir, true);
	await assertArtifactPath(path.join(jobDir, "status.json"));
	const status = await readJson<AgentJobStatus>(path.join(jobDir, "status.json"));
	if (!status || status.jobId !== jobId || typeof status.cwd !== "string" || typeof status.jobDir !== "string"
		|| !["running", "completed", "failed", "cancelled"].includes(status.state)) throw new Error("Invalid agent job metadata.");
	if (await fs.promises.realpath(status.cwd) !== root || await fs.promises.realpath(status.jobDir) !== jobDir) {
		throw new Error("Invalid agent job cwd or jobDir: outside the selected job.");
	}
	const files = { runScriptPath: "run.sh", eventLogPath: "events.jsonl", stderrPath: "stderr.log", resultPath: "result.md",
		exitPath: "exit.json", pidPath: "pid", promptPath: "prompt.md", systemPromptPath: "system-prompt.md", reviewContextPath: "review-context.md" } as const;
	for (const [key, name] of Object.entries(files) as Array<[keyof typeof files, string]>) {
		const expected = path.join(jobDir, name);
		const supplied = status[key];
		if (supplied !== undefined && (typeof supplied !== "string" || path.basename(supplied) !== name
			|| await fs.promises.realpath(path.dirname(supplied)) !== jobDir)) throw new Error(`Invalid agent job ${key}: outside the selected job.`);
		await assertArtifactPath(expected);
		// Use canonical paths after validation, including defaults for older metadata.
		status[key] = expected;
	}
	return { ...status, cwd: root, jobDir };
}

async function signalOwnedAgent(pi: ExtensionAPI, status: AgentJobStatus, signal: NodeJS.Signals, abortSignal?: AbortSignal): Promise<boolean> {
	const pid = status.processId;
	if (!Number.isInteger(pid) || !pid || pid <= 0) throw new Error("Cannot safely cancel this legacy job: no verifiable process identity.");
	if (Number((await fs.promises.readFile(status.pidPath, "utf8")).trim()) !== pid) throw new Error("Agent process identity does not match its PID file.");
	const result = await pi.exec("ps", ["-p", String(pid), "-o", "pid=,pgid=,args="], { cwd: status.cwd, timeout: 5000, signal: abortSignal });
	if (result.code === 1 && !result.stdout.trim() && !result.stderr.trim()) return false;
	const match = result.stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
	if (result.code !== 0 || !match || Number(match[1]) !== pid || Number(match[2]) !== pid || !match[3]?.startsWith("bash ")) {
		throw new Error("Agent process identity could not be verified; no signal sent.");
	}
	const script = await fs.promises.realpath(match[3].slice(5)).catch(() => undefined);
	if (script !== status.runScriptPath) throw new Error("Agent process identity does not match the expected run script; no signal sent.");
	return signalDetachedProcess(pid, signal);
}

async function writeStatus(status: AgentJobStatus): Promise<void> {
	await writeJson(path.join(status.jobDir, "status.json"), status);
}

async function finalizeIfDone(pi: ExtensionAPI, cwd: string, jobId: string, sendFollowUp: boolean, session: SessionIdentity = {}): Promise<AgentJobStatus> {
	let status = await readStatus(cwd, jobId);
	if (status.state === "running" && fileExists(status.exitPath)) {
		const exit = await readJson<{ exitCode: number; finishedAt: string }>(status.exitPath);
		const events = fileExists(status.eventLogPath) ? await fs.promises.readFile(status.eventLogPath, "utf8") : "";
		const stderr = fileExists(status.stderrPath) ? await fs.promises.readFile(status.stderrPath, "utf8") : "";
		const parsed = parseAgentEvents(events);
		const hasModelError = parsed.stopReason === "error" || parsed.stopReason === "aborted" || Boolean(parsed.errorMessage);
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

	if (sendFollowUp && needsCompletionFollowUp(status) && isOriginSession(status, session)) {
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

function watchJob(pi: ExtensionAPI, cwd: string, jobId: string, session: SessionIdentity = {}): void {
	const key = `${cwd}:${jobId}`;
	if (watchedJobs.has(key)) return;
	let polling = false;

	const poll = () => {
		if (polling) return;
		polling = true;
		void finalizeIfDone(pi, cwd, jobId, true, session)
			.then((status) => {
				if (status.state !== "running" && (!needsCompletionFollowUp(status) || !isOriginSession(status, session))) stopWatchingJob(pi, cwd, jobId);
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

async function resumeRunningJobs(pi: ExtensionAPI, cwd: string, session: SessionIdentity): Promise<void> {
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
			if (status.state === "running" || (needsCompletionFollowUp(status) && isOriginSession(status, session))) watchJob(pi, cwd, entry.name, session);
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
	model?: Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id">;
	thinkingLevel?: AgentThinkingLevel;
	signal?: AbortSignal;
	hasUI?: boolean;
	isProjectTrusted?(): boolean;
	sessionManager?: {
		getSessionId?(): string;
		getSessionFile?(): string | undefined;
	};
	ui?: {
		confirm(title: string, message: string, options?: { signal?: AbortSignal }): Promise<boolean>;
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
	monitor = true,
): Promise<AgentJobStatus> {
	const cwd = await trustedAgentRoot(ctx, params.cwd);
	const stat = await fs.promises.stat(cwd).catch(() => undefined);
	if (!stat?.isDirectory()) throw new Error(`Working directory not found: ${cwd}`);

	const agentScope = params.agentScope ?? "user";
	const discovery = discoverAgents(cwd, agentScope);
	const definition = discovery.agents.find((candidate) => candidate.name === params.agent);
	const agent = definition && { ...definition, model: definition.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined) };
	if (!agent) {
		const available = discovery.agents.map((candidate) => `${candidate.name} (${candidate.source})`).join(", ") || "none";
		throw new Error(`Unknown agent "${params.agent}". Available agents: ${available}`);
	}

	if (agent.source === "project" && (params.confirmProjectAgents ?? true)) {
		if (!ctx.hasUI || !ctx.ui) throw new Error("Project-agent confirmation requires an interactive approval. No agent launched.");
		const ok = await ctx.ui.confirm(
			"Run project-local agent?",
			`Agent: ${agent.name}\nSource: ${agent.filePath}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
			{ signal: ctx.signal },
		);
		if (!ok) throw new Error("Canceled: project-local agent not approved.");
	}

	const missingTools = findMissingTools(pi, agent);
	if (missingTools.length > 0) {
		throw new Error(`Agent "${agent.name}" requires unavailable tools: ${missingTools.join(", ")}. Install/reload the needed extensions first.`);
	}

	ctx.signal?.throwIfAborted();
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
		thinkingLevel: definition?.model ? undefined : ctx.thinkingLevel,
		promptPath,
		systemPromptPath,
		eventLogPath,
		stderrPath,
		exitPath,
		pidPath,
		resultPath,
	});
	await fs.promises.writeFile(runScriptPath, runScript, { encoding: "utf8", mode: 0o700 });

	const originSession = sessionIdentityFromContext(ctx);
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
		launcher: "process",
		originSessionId: originSession.id,
		originSessionFile: originSession.file,
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
		status.processId = await launchDetachedRunScript(cwd, runScriptPath, pidPath);
		status.updatedAt = nowIso();
		await writeStatus(status);
	} catch (error) {
		const failed = {
			...status,
			state: "failed" as const,
			updatedAt: nowIso(),
			completedAt: nowIso(),
			summary: "Failed to launch detached background process.",
			errorMessage: error instanceof Error ? error.message : String(error),
		};
		await writeStatus(failed);
		throw error;
	}
	if (monitor) watchJob(pi, cwd, jobId, originSession);
	return status;
}

function formatStarted(status: AgentJobStatus): string {
	return [
		`Started background ${status.agent} job ${status.jobId} as detached process ${status.processId}.`,
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
		status.processId ? `Process: ${status.processId}` : status.tmuxWindow ? `Legacy tmux window: ${status.tmuxWindow}` : undefined,
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
echo "pi background loop job: ${params.jobId}"
echo "stdout: ${params.stdoutPath}"
echo "stderr: ${params.stderrPath}"
echo "result: ${params.resultPath}"
echo ""
echo "Running loop..."
child_pid=""
forward_signal() {
  if [ -n "$child_pid" ]; then kill -"$1" "$child_pid" 2>/dev/null || true; fi
}
trap 'forward_signal INT' INT
trap 'forward_signal TERM' TERM
${command} > ${shellQuote(params.stdoutPath)} 2> ${shellQuote(params.stderrPath)} &
child_pid=$!
echo "$$" > ${shellQuote(params.pidPath)}
wait "$child_pid"
code=$?
if kill -0 "$child_pid" 2>/dev/null; then
  wait "$child_pid"
  child_code=$?
  if [ "$child_code" -ne 0 ]; then code=$child_code; fi
fi
trap - INT TERM
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

async function finalizeLoopIfDone(pi: ExtensionAPI, cwd: string, jobId: string, sendFollowUp: boolean, session: SessionIdentity = {}): Promise<LoopJobStatus> {
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

	if (sendFollowUp && needsCompletionFollowUp(status) && isOriginSession(status, session)) {
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

function watchLoopJob(pi: ExtensionAPI, cwd: string, jobId: string, session: SessionIdentity = {}): void {
	const key = `${cwd}:${jobId}`;
	if (watchedLoopJobs.has(key)) return;
	let polling = false;

	const poll = () => {
		if (polling) return;
		polling = true;
		void finalizeLoopIfDone(pi, cwd, jobId, true, session)
			.then((status) => {
				if (status.state !== "running" && (!needsCompletionFollowUp(status) || !isOriginSession(status, session))) stopWatchingLoopJob(pi, cwd, jobId);
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

async function resumeRunningLoopJobs(pi: ExtensionAPI, cwd: string, session: SessionIdentity): Promise<void> {
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
			if (status.state === "running" || (needsCompletionFollowUp(status) && isOriginSession(status, session))) watchLoopJob(pi, cwd, entry.name, session);
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

	const originSession = sessionIdentityFromContext(ctx);
	const createdAt = nowIso();
	const status: LoopJobStatus = {
		jobId,
		feature,
		task: params.task,
		cwd,
		createdAt,
		updatedAt: createdAt,
		state: "running",
		launcher: "process",
		originSessionId: originSession.id,
		originSessionFile: originSession.file,
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
		status.processId = await launchDetachedRunScript(cwd, runScriptPath, pidPath);
		status.updatedAt = nowIso();
		await writeLoopStatus(status);
	} catch (error) {
		const failed = {
			...status,
			state: "failed" as const,
			updatedAt: nowIso(),
			completedAt: nowIso(),
			summary: "Failed to launch detached background process.",
			errorMessage: error instanceof Error ? error.message : String(error),
		};
		await writeLoopStatus(failed);
		throw error;
	}
	watchLoopJob(pi, cwd, jobId, originSession);
	return status;
}

function formatLoopStarted(status: LoopJobStatus): string {
	return [
		`Started background loop job ${status.jobId} as detached process ${status.processId}.`,
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
		status.processId ? `Process: ${status.processId}` : status.tmuxWindow ? `Legacy tmux window: ${status.tmuxWindow}` : undefined,
		`Result: ${status.resultPath}`,
		`Loop log: ${status.loopLogPath}`,
		`Latest iteration: ${status.loopSummaryPath}`,
		resultPreview ? `\n## Result Preview\n\n${resultPreview}` : undefined,
	];
	return lines.filter((line): line is string => line !== undefined).join("\n");
}

const ForegroundTaskSchema = Type.Object({
	agent: Type.String({ minLength: 1 }),
	task: Type.String({ minLength: 1 }),
	cwd: Type.Optional(Type.String()),
});

interface ForegroundTask { agent: string; task: string; cwd?: string }
interface ForegroundResult {
	agent: string;
	state: AgentJobState | "queued";
	jobId?: string;
	resultPath?: string;
	output?: string;
}

// Foreground jobs have one owner: this waiter, not the background watcher.
async function cancelForegroundJob(pi: ExtensionAPI, job: AgentJobStatus): Promise<void> {
	let status = await finalizeIfDone(pi, job.cwd, job.jobId, false);
	if (status.state !== "running") return;
	const signalled = await signalOwnedAgent(pi, status, "SIGTERM");
	status = { ...status, cancelRequestedAt: nowIso(), updatedAt: nowIso() };
	await writeStatus(status);
	if (signalled) {
		const deadline = Date.now() + 1000;
		while (!fileExists(status.exitPath) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		if (!fileExists(status.exitPath)) await signalOwnedAgent(pi, status, "SIGKILL");
	}
	if (fileExists(status.exitPath)) {
		await finalizeIfDone(pi, status.cwd, status.jobId, false);
		return;
	}
	const completedAt = nowIso();
	await fs.promises.writeFile(status.resultPath, "Foreground delegation cancelled. No exit marker was available.\n", "utf8");
	await writeStatus({ ...status, state: "cancelled", completedAt, updatedAt: completedAt, summary: "Foreground delegation cancelled." });
}

async function runForegroundAgents(
	pi: ExtensionAPI, ctx: LaunchContext, tasks: ForegroundTask[],
	options: { agentScope?: AgentScope; confirmProjectAgents?: boolean },
	signal: AbortSignal, update: (results: ForegroundResult[]) => void,
): Promise<ForegroundResult[]> {
	const results: ForegroundResult[] = tasks.map((task) => ({ agent: task.agent, state: "queued" }));
	const active = new Map<number, AgentJobStatus>();
	let next = 0;
	try {
		while (next < tasks.length || active.size > 0) {
			signal.throwIfAborted();
			// Launch serially so project-agent confirmation dialogs never overlap.
			while (next < tasks.length && active.size < 4) {
				signal.throwIfAborted();
				const index = next++;
				const task = tasks[index]!;
				try {
					const job = await launchAgentJob(pi, { ...ctx, signal }, { ...options, ...task, followUp: false }, false);
					active.set(index, job);
					results[index] = { agent: task.agent, state: "running", jobId: job.jobId, resultPath: job.resultPath };
				} catch (error) {
					results[index] = { agent: task.agent, state: "failed", output: clipForegroundOutput(error instanceof Error ? error.message : String(error)) };
				}
				update(results.map((result) => ({ ...result })));
			}
			signal.throwIfAborted();
			for (const [index, job] of active) {
				const status = await finalizeIfDone(pi, job.cwd, job.jobId, false);
				if (status.state !== "running") {
					results[index] = { ...results[index]!, state: status.state,
						output: clipForegroundOutput([status.errorMessage, await readTextIfExists(status.resultPath)].filter(Boolean).join("\n\n")) };
					active.delete(index);
				} else {
					// Read only a bounded tail for live progress; the durable log stays complete.
					const file = await fs.promises.open(status.eventLogPath, "r").catch((error: NodeJS.ErrnoException) => {
						if (error.code === "ENOENT") return undefined;
						throw error;
					});
					if (file) {
						try {
							const size = (await file.stat()).size;
							const start = Math.max(0, size - 64 * 1024);
							const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
							const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
							const tail = buffer.toString("utf8", 0, bytesRead);
							const parsed = parseAgentEvents(start ? tail.slice(tail.indexOf("\n") + 1) : tail);
							results[index]!.output = parsed.finalOutput.slice(-1000) || `${parsed.toolCalls} tool calls in recent log`;
						} finally { await file.close(); }
					}
				}
			}
			update(results.map((result) => ({ ...result })));
			if (active.size) await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return results;
	} finally {
		const cleanup = await Promise.allSettled([...active.values()].map((job) => cancelForegroundJob(pi, job)));
		const failures = cleanup.flatMap((result, index) => result.status === "rejected"
			? [`${[...active.values()][index]!.jobId}: ${String(result.reason)}`] : []);
		if (failures.length) throw new Error(`Foreground cleanup failed; inspect durable jobs: ${failures.join("; ")}`);
	}
}

function clipForegroundOutput(text: string): string {
	const output = truncateHead(text, { maxBytes: 4800, maxLines: 198 });
	return output.content + (output.truncated ? "\n[Truncated; inspect the durable result/event log.]" : "");
}

function foregroundText(results: ForegroundResult[]): string {
	return results.map((result) =>
		`### ${result.agent} — ${result.state}\n${result.jobId ? `Job: ${result.jobId}\nResult: ${result.resultPath}\n` : ""}\n${result.output ?? ""}`,
	).join("\n\n");
}

export default function agentJobsExtension(pi: ExtensionAPI) {
	const foregroundRuns = new Map<AbortController, Promise<ForegroundResult[]>>();
	pi.on("session_shutdown", async () => {
		for (const controller of foregroundRuns.keys()) controller.abort();
		await Promise.allSettled(foregroundRuns.values());
	});
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Delegate foreground work with isolated context: agent + task, or tasks for parallel execution (max 8 tasks, 4 concurrent per call). Waits and returns results directly; durable logs remain available. Output capped at 5 KB/200 lines per task.",
		promptSnippet: "Delegate one task or parallel independent tasks and return their results directly",
		promptGuidelines: [
			"Use subagent when child results are needed in the current workflow; use agent_job_start for explicitly background work.",
			"Give subagent bounded tasks, relevant paths, constraints and expected evidence. Keep simple work inline; parallel writers require separate worktrees.",
		],
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ minLength: 1 })),
			task: Type.Optional(Type.String({ minLength: 1 })),
			cwd: Type.Optional(Type.String()),
			tasks: Type.Optional(Type.Array(ForegroundTaskSchema, { minItems: 1, maxItems: 8 })),
			agentScope: Type.Optional(AgentScopeSchema),
			confirmProjectAgents: Type.Optional(Type.Boolean({ default: true })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const single = params.agent !== undefined || params.task !== undefined;
			if (single === (params.tasks !== undefined) || (params.tasks !== undefined && params.cwd !== undefined)) {
				throw new Error("Provide exactly one mode: agent + task (+ cwd), or tasks with per-task cwd.");
			}
			const tasks = params.tasks ?? [{ agent: params.agent ?? "", task: params.task ?? "", cwd: params.cwd }];
			if (!tasks.length || tasks.length > 8 || tasks.some((task) => !task.agent.trim() || !task.task.trim())) {
				throw new Error("Provide 1–8 tasks with non-empty agent and task.");
			}
			const controller = new AbortController();
			const abort = () => controller.abort();
			if (signal?.aborted) abort();
			signal?.addEventListener("abort", abort, { once: true });
			const run = runForegroundAgents(pi, ctx, tasks, params, controller.signal, (results) => {
				onUpdate?.({ content: [{ type: "text", text: foregroundText(results) }], details: { results } });
			});
			foregroundRuns.set(controller, run);
			try {
				const results = await run;
				const text = foregroundText(results);
				if (single && results[0]?.state !== "completed") throw new Error(text);
				return { content: [{ type: "text" as const, text }], details: { results } };
			} finally {
				foregroundRuns.delete(controller);
				signal?.removeEventListener("abort", abort);
			}
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		const session = sessionIdentityFromContext(ctx);
		try {
			const root = await trustedAgentRoot(ctx);
			await resumeRunningJobs(pi, root, session);
		} catch { /* Untrusted or invalid agent job directories must not auto-resume. */ }
		void resumeRunningLoopJobs(pi, ctx.cwd, session);
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
		description: "Run the researcher agent as a detached background process",
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
		description: "Run the oracle agent as a detached background process",
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
		description: "Run an oracle review with a git diff snapshot as a detached background process",
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
		description: "Show background agent job status (usage: /agent-job-status [--project-root <path>] [jobId])",
		handler: async (args, ctx) => {
			try {
				const { jobId, cwd: requestedCwd, help } = parseLoopJobStatusCommandArgs(args.trim());
				if (help) {
					ctx.ui.notify("Usage: /agent-job-status [--project-root <path>] [jobId]", "info");
					return;
				}
				const cwd = await trustedAgentRoot(ctx, requestedCwd);
				if (jobId) {
					const status = await finalizeIfDone(pi, cwd, jobId, false);
					ctx.ui.notify(`${status.jobId}: ${status.state}${status.summary ? ` — ${status.summary}` : ""}`, "info");
					return;
				}
				const statuses = await listStatuses(cwd);
				if (statuses.length === 0) ctx.ui.notify("No background agent jobs found", "info");
				else ctx.ui.notify(statuses.slice(0, 5).map((status) => `${status.jobId}: ${status.state}`).join("\n"), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("loop-bg", {
		description: "Run loop.sh for a feature as a detached background process",
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
			"Start a specialized agent as a detached OS process and return immediately. " +
			"The job writes status, JSON events, stderr, and final result files under .pi/agent-jobs, then sends a follow-up message when finished.",
		promptSnippet: "Start a specialized agent as a detached background process and optionally resume via a completion follow-up",
		promptGuidelines: [
			"Use agent_job_start with followUp=true when the current workflow should resume after one background job finishes.",
			"Use agent_job_start with followUp=false only when the current agent will explicitly poll agent_job_status to completion, such as a parent coordinating several child jobs.",
		],
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
			const status = await launchAgentJob(pi, { cwd: ctx.cwd, model: ctx.model, thinkingLevel: pi.getThinkingLevel(), signal, sessionManager: ctx.sessionManager, hasUI: ctx.hasUI, ui: ctx.ui, isProjectTrusted: () => ctx.isProjectTrusted() }, {
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
				terminate: shouldTerminateAfterAgentJobStart(status.followUp),
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
		description: "Check a background agent job, or list recent jobs when jobId is omitted. Pass cwd when the job was started in another project.",
		parameters: Type.Object({
			jobId: Type.Optional(Type.String({ description: "Job id returned by agent_job_start." })),
			cwd: Type.Optional(Type.String({ description: "Project root where the job was started. Defaults to current cwd." })),
		}),
		outputSchema: jobStatusOutputSchema(AgentJobSummarySchema),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = await trustedAgentRoot(ctx, params.cwd);
			if (params.jobId) {
				const status = await finalizeIfDone(pi, cwd, params.jobId, false);
				const preview = fileExists(status.resultPath) ? truncateTail(await fs.promises.readFile(status.resultPath, "utf8"), 6000) : undefined;
				return {
					content: [{ type: "text" as const, text: formatStatus(status, preview) }],
					details: status,
					structuredContent: { job: agentJobSummary(status), resultPreview: preview },
				};
			}
			const statuses = (await listStatuses(cwd)).slice(0, 10);
			const text = statuses.length === 0
				? "No background agent jobs found."
				: statuses.map((status) => `${status.jobId}\t${status.agent}\t${status.state}\t${status.summary || ""}`).join("\n");
			return { content: [{ type: "text" as const, text }], details: { jobs: statuses }, structuredContent: { jobs: statuses.map(agentJobSummary) } };
		},
	});

	pi.registerTool({
		name: "loop_job_start",
		label: "Loop Job Start",
		description:
			"Start loop.sh for a project feature/task as a detached OS process and return immediately. " +
			"Use when the user says things like 'run a loop for this task in background'. " +
			"The job writes status and result files under .pi/loop-jobs, reuses .features/{feature}/artifacts/loop/, and sends a follow-up message when finished.",
		promptSnippet: "Run loop.sh for a feature/task as a detached background process and notify when it finishes",
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
			const status = await launchLoopJob(pi, { cwd: ctx.cwd, signal, sessionManager: ctx.sessionManager }, {
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
		outputSchema: jobStatusOutputSchema(LoopJobSummarySchema),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = params.cwd ? (path.isAbsolute(params.cwd) ? params.cwd : path.resolve(ctx.cwd, params.cwd)) : ctx.cwd;
			if (params.jobId) {
				const status = await finalizeLoopIfDone(pi, cwd, params.jobId, false);
				const preview = fileExists(status.resultPath) ? truncateTail(await fs.promises.readFile(status.resultPath, "utf8"), 6000) : undefined;
				return {
					content: [{ type: "text" as const, text: formatLoopStatus(status, preview) }],
					details: status,
					structuredContent: { job: loopJobSummary(status), resultPreview: preview },
				};
			}
			const statuses = (await listLoopStatuses(cwd)).slice(0, 10);
			const text = statuses.length === 0
				? "No background loop jobs found."
				: statuses.map((status) => `${status.jobId}\t${status.feature}\t${status.state}\t${status.summary || ""}`).join("\n");
			return { content: [{ type: "text" as const, text }], details: { jobs: statuses }, structuredContent: { jobs: statuses.map(loopJobSummary) } };
		},
	});

	pi.registerTool({
		name: "loop_job_cancel",
		label: "Loop Job Cancel",
		description: "Cancel a running background loop process.",
		parameters: Type.Object({
			jobId: Type.String({ description: "Job id returned by loop_job_start." }),
			cwd: Type.Optional(Type.String({ description: "Project root where the loop job was started. Defaults to current cwd." })),
			killWindow: Type.Optional(Type.Boolean({ description: "Force-kill the process after requesting cancellation. Retained for compatibility; default false.", default: false })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cwd = params.cwd ? (path.isAbsolute(params.cwd) ? params.cwd : path.resolve(ctx.cwd, params.cwd)) : ctx.cwd;
			const status = await finalizeLoopIfDone(pi, cwd, params.jobId, false);
			if (status.state !== "running") {
				return { content: [{ type: "text" as const, text: `Loop job ${status.jobId} is already ${status.state}.` }], details: status };
			}
			if (status.cancelRequestedAt) {
				return { content: [{ type: "text" as const, text: `Cancellation is already pending for loop job ${status.jobId}.` }], details: status };
			}
			let signalled = false;
			if (status.processId) signalled = signalDetachedProcess(status.processId, "SIGTERM");
			else if (status.tmuxWindow && process.env.TMUX) {
				await execChecked(pi, "tmux", ["send-keys", "-t", status.tmuxWindow, "C-c"], { signal, timeout: 5000 });
				signalled = true;
			} else throw new Error(`Loop job ${status.jobId} has no cancellable process.`);
			const requestedAt = nowIso();
			const pending = { ...status, cancelRequestedAt: requestedAt, updatedAt: requestedAt, summary: "Cancellation requested; waiting for the process to exit." };
			if (params.killWindow && signalled) {
				if (status.processId) signalDetachedProcess(status.processId, "SIGKILL");
				else if (status.tmuxWindow) await execChecked(pi, "tmux", ["kill-window", "-t", status.tmuxWindow], { signal, timeout: 5000 });
			}
			const stopped = !signalled || params.killWindow;
			const updated = stopped
				? { ...pending, state: "cancelled" as const, completedAt: requestedAt, summary: "Cancelled by user." }
				: pending;
			await writeLoopStatus(updated);
			if (stopped) stopWatchingLoopJob(pi, status.cwd, status.jobId);
			return { content: [{ type: "text" as const, text: stopped ? `Cancelled loop job ${status.jobId}.` : `Cancellation requested for loop job ${status.jobId}.` }], details: updated };
		},
	});

	pi.registerTool({
		name: "agent_job_cancel",
		label: "Agent Job Cancel",
		description: "Cancel a running background agent process. Pass cwd when the job was started in another project.",
		parameters: Type.Object({
			jobId: Type.String({ description: "Job id returned by agent_job_start." }),
			cwd: Type.Optional(Type.String({ description: "Project root where the job was started. Defaults to current cwd." })),
			killWindow: Type.Optional(Type.Boolean({ description: "Force-kill the process after requesting cancellation. Retained for compatibility; default false.", default: false })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cwd = await trustedAgentRoot(ctx, params.cwd);
			const status = await finalizeIfDone(pi, cwd, params.jobId, false);
			if (status.state !== "running") {
				return { content: [{ type: "text" as const, text: `Job ${status.jobId} is already ${status.state}.` }], details: status };
			}
			if (status.cancelRequestedAt) {
				return { content: [{ type: "text" as const, text: `Cancellation is already pending for job ${status.jobId}.` }], details: status };
			}
			const signalled = await signalOwnedAgent(pi, status, "SIGTERM", signal);
			const requestedAt = nowIso();
			const pending = { ...status, cancelRequestedAt: requestedAt, updatedAt: requestedAt, summary: "Cancellation requested; waiting for the process to exit." };
			if (params.killWindow && signalled) {
				await signalOwnedAgent(pi, status, "SIGKILL", signal);
			}
			const stopped = !signalled || params.killWindow;
			const updated = stopped
				? { ...pending, state: "cancelled" as const, completedAt: requestedAt, summary: "Cancelled by user." }
				: pending;
			await writeStatus(updated);
			if (stopped) stopWatchingJob(pi, status.cwd, status.jobId);
			return { content: [{ type: "text" as const, text: stopped ? `Cancelled job ${status.jobId}.` : `Cancellation requested for job ${status.jobId}.` }], details: updated };
		},
	});
}
