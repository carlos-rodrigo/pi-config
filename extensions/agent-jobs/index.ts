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
import { ForegroundRegistry, buildManagerSnapshot, boundedPreview, type ManagerPreview, type ManagerSnapshot } from "./manager-model.ts";
import { showAgentManager } from "./manager.ts";
import { withJobLock } from "./lifecycle-lock.ts";

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
type SessionIdentity = { id?: string; file?: string };
type PendingFollowUpAck = { cwd: string; kind: CompletionFollowUpKind; jobId: string; parentCwd: string; session: SessionIdentity; queuedAt: number; blocking: boolean; received: boolean; retryRequested?: boolean; token: string };
let followUpContext: Pick<ExtensionContext, "cwd" | "sessionManager" | "isIdle" | "hasPendingMessages"> | undefined;
// Plain receipts survive /reload in this process. Never retain SDK contexts, timers,
// or process-ownership evidence here; child processes cannot discover these tokens.
const receiptStoreKey = Symbol.for("pi-config.agent-jobs.follow-up-receipts.v1");
const receiptStore = globalThis as typeof globalThis & { [receiptStoreKey]?: Map<string, PendingFollowUpAck> };
const pendingFollowUpAcks = receiptStore[receiptStoreKey] ??= new Map<string, PendingFollowUpAck>();
const COMPLETION_FOLLOW_UP_MARKER = "pi-agent-jobs-follow-up";

function followUpKey(kind: CompletionFollowUpKind, jobId: string, cwd: string): string {
	return JSON.stringify([kind, cwd, jobId]);
}

function matchesDeliveryContext(pending: PendingFollowUpAck, ctx = followUpContext): boolean {
	const session = sessionIdentityFromContext(ctx ?? {});
	if (pending.session.id) return pending.session.id === session.id;
	if (pending.session.file) return pending.session.file === session.file;
	return pending.parentCwd === ctx?.cwd;
}

function completionFollowUpMarker(kind: CompletionFollowUpKind, jobId: string): string {
	return `<!-- ${COMPLETION_FOLLOW_UP_MARKER}:${kind}:${jobId} -->`;
}

function parseCompletionFollowUpMarkers(text: string): Array<{ kind: CompletionFollowUpKind; jobId: string; token: string }> {
	return [...text.matchAll(new RegExp(`<!-- ${COMPLETION_FOLLOW_UP_MARKER}:(agent|loop):([a-zA-Z0-9_.-]+):([a-f0-9]{32}) -->`, "g"))]
		.map(match => ({ kind: match[1] as CompletionFollowUpKind, jobId: match[2]!, token: match[3]! }));
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
	const tmp = `${filePath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
	try {
		await fs.promises.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
		await fs.promises.rename(tmp, filePath);
	} finally { await fs.promises.rm(tmp, { force: true }); }
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
printf '%s\\n' ${shellQuote(`pi background agent job: ${params.jobId}`)}
printf '%s\\n' ${shellQuote(`agent: ${params.agent.name}`)}
printf '%s\\n' ${shellQuote(`events: ${params.eventLogPath}`)}
printf '%s\\n' ${shellQuote(`stderr: ${params.stderrPath}`)}
printf '%s\\n' ${shellQuote(`result: ${params.resultPath}`)}
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
printf '%s\\n' ${shellQuote(`Result will be written by the parent pi extension: ${params.resultPath}`)}
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

async function trustedAgentRoot(ctx: { cwd: string; isProjectTrusted?(): boolean }, requested?: string, kind: CompletionFollowUpKind = "agent"): Promise<string> {
	const label = kind === "agent" ? "Agent" : "Loop";
	if (!ctx.isProjectTrusted?.()) throw new Error(`${label} jobs require a trusted Pi session.`);
	const root = await fs.promises.realpath(path.resolve(ctx.cwd, requested ?? "."));
	const sessionRoot = await fs.promises.realpath(ctx.cwd);
	const trust = new ProjectTrustStore(getAgentDir());
	const jobRoot = kind === "agent" ? jobsRoot(root) : loopJobsRoot(root);
	if ((root !== sessionRoot && (trust.get(root) !== true || trust.get(jobRoot) !== true)) || trust.get(jobRoot) === false) {
		throw new Error(`${label} job target is not trusted: ${root}`);
	}
	await assertArtifactPath(path.join(root, ".pi"), true);
	await assertArtifactPath(jobRoot, true);
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
	await assertArtifactPath(path.join(jobDir, ".cleanup-pending.json"));
	return { ...status, cwd: root, jobDir };
}

type ProcessJob = Pick<AgentJobStatus, "processId" | "pidPath" | "cwd" | "runScriptPath">;

async function inspectOwnedProcess(pi: ExtensionAPI, status: ProcessJob, abortSignal?: AbortSignal, checkPidFile = true): Promise<number | undefined> {
	const recordedPid = checkPidFile ? Number((await fs.promises.readFile(status.pidPath, "utf8")).trim()) : status.processId;
	const pid = status.processId ?? recordedPid;
	if (!Number.isInteger(pid) || !pid || pid <= 0) throw new Error("Cannot safely cancel this legacy job: no verifiable process identity.");
	if (checkPidFile && recordedPid !== pid) throw new Error("Agent process identity does not match its PID file.");
	const result = await pi.exec("ps", ["-p", String(pid), "-o", "pid=,pgid=,args="], { cwd: status.cwd, timeout: 5000, signal: abortSignal });
	if (result.code === 1 && !result.stdout.trim() && !result.stderr.trim()) return undefined;
	const match = result.stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
	if (result.code !== 0 || !match || Number(match[1]) !== pid || Number(match[2]) !== pid || !match[3]?.startsWith("bash ")) {
		throw new Error("Agent process identity could not be verified; no signal sent.");
	}
	const script = await fs.promises.realpath(match[3].slice(5)).catch(() => undefined);
	if (script !== status.runScriptPath) throw new Error("Agent process identity does not match the expected run script; no signal sent.");
	return pid;
}

async function signalOwnedAgent(pi: ExtensionAPI, status: ProcessJob, signal: NodeJS.Signals, abortSignal?: AbortSignal): Promise<boolean> {
	const pid = await inspectOwnedProcess(pi, status, abortSignal);
	return pid ? signalDetachedProcess(pid, signal) : false;
}

async function processGroupMembers(pi: ExtensionAPI, cwd: string, group: number): Promise<Map<number, string>> {
	const result = await pi.exec("ps", ["-axo", "pid=,pgid=,stat=,lstart="], { cwd, timeout: 5000 });
	if (result.code !== 0) throw new Error("Process-group inspection unavailable.");
	const members = new Map<number, string>();
	for (const line of result.stdout.split("\n")) {
		if (!line.trim()) continue;
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
		if (!match) throw new Error("Invalid process-group inspection output.");
		if (match && Number(match[2]) === group && !match[3]!.includes("Z")) members.set(Number(match[1]), match[4]!);
	}
	return members;
}

async function processIsMissing(pi: ExtensionAPI, status: ProcessJob): Promise<boolean> {
	try {
		if (await inspectOwnedProcess(pi, status)) return false;
		const pid = status.processId ?? Number((await fs.promises.readFile(status.pidPath, "utf8")).trim());
		return (await processGroupMembers(pi, status.cwd, pid)).size === 0;
	} catch { return false; } // Legacy, mismatched or unavailable inspection is uncertainty, not death.
}

const UNVERIFIED_CLEANUP = {
	launch: "Launch persistence failed; process cleanup could not be verified.",
	cancel: "Forced cancellation could not be verified.",
	foreground: "Foreground cleanup could not be verified.",
} as const;
type CleanupPurpose = keyof typeof UNVERIFIED_CLEANUP;
const knownGroups = new Map<string, { group: number; members: Map<number, string>; purpose: CleanupPurpose }>();
const cleanupJournal = (status: ProcessJob) => path.join(path.dirname(status.runScriptPath), ".cleanup-pending.json");
async function clearCleanupJournal(status: ProcessJob): Promise<void> {
	await fs.promises.rm(cleanupJournal(status), { force: true });
	knownGroups.delete(status.runScriptPath);
}

async function terminateOwnedGroup(pi: ExtensionAPI, status: ProcessJob, checkPidFile = true, graceMs = 1000, purpose: CleanupPurpose = "cancel"): Promise<boolean> {
	await assertArtifactPath(cleanupJournal(status));
	// Journal data blocks premature finalization; it never grants signalling authority.
	// Cleanup must still run if persistence is unavailable (for example, a full disk).
	await writeJson(cleanupJournal(status), { purpose }).catch(() => {});
	const pid = await inspectOwnedProcess(pi, status, undefined, checkPidFile);
	const group = pid ?? status.processId ?? Number((await fs.promises.readFile(status.pidPath, "utf8")).trim());
	const current = await processGroupMembers(pi, status.cwd, group);
	if (!current.size) { if (purpose !== "launch") await clearCleanupJournal(status); return false; }
	const prior = knownGroups.get(status.runScriptPath);
	const owned = pid && current.has(pid) ? current : prior?.group === group ? prior.members : undefined;
	if (!owned || ![...current].some(([member, started]) => owned.get(member) === started)) throw new Error("Cannot verify the surviving process group's ownership.");
	knownGroups.set(status.runScriptPath, { group, members: owned, purpose });
	if (!signalDetachedProcess(group, "SIGTERM")) {
		if ((await processGroupMembers(pi, status.cwd, group)).size) throw new Error("Process-group signal failed; cleanup remains uncertain.");
		if (purpose !== "launch") await clearCleanupJournal(status);
		return false;
	}
	const deadline = Date.now() + graceMs;
	let remaining = await processGroupMembers(pi, status.cwd, group);
	while (remaining.size && Date.now() < deadline) {
		await new Promise(resolve => setTimeout(resolve, 50));
		remaining = await processGroupMembers(pi, status.cwd, group);
	}
	if (!remaining.size) return true;
	// A surviving member's PID, start time and PGID retain ownership even if the wrapper exited.
	if (![...remaining].some(([member, started]) => owned.get(member) === started)) throw new Error("Cannot verify surviving descendants; cleanup remains uncertain.");
	signalDetachedProcess(group, "SIGKILL");
	const killDeadline = Date.now() + 1000;
	while ((await processGroupMembers(pi, status.cwd, group)).size) {
		if (Date.now() >= killDeadline) throw new Error("Process-group cleanup could not be confirmed.");
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	return true;
}

async function reconcileCleanup<T extends AgentJobStatus | LoopJobStatus>(pi: ExtensionAPI, status: T, save: (status: T) => Promise<void>): Promise<{ status: T; pending: boolean }> {
	let purpose = knownGroups.get(status.runScriptPath)?.purpose
		?? (Object.keys(UNVERIFIED_CLEANUP) as CleanupPurpose[]).find(key => status.summary === UNVERIFIED_CLEANUP[key]);
	if (fileExists(cleanupJournal(status))) {
		const journal = await readJson<{ purpose: CleanupPurpose }>(cleanupJournal(status));
		if (!journal || typeof journal.purpose !== "string" || !Object.hasOwn(UNVERIFIED_CLEANUP, journal.purpose)) throw new Error("Invalid cleanup journal.");
		purpose = journal.purpose;
	}
	if (!purpose) return { status, pending: false };
	let absent = false;
	try {
		const recorded = Number((await fs.promises.readFile(status.pidPath, "utf8")).trim());
		const group = status.processId ?? recorded;
		if (Number.isInteger(group) && group > 0 && group === recorded) absent = (await processGroupMembers(pi, status.cwd, group)).size === 0;
	} catch { /* Failed inspection is not proof of cleanup, even with an exit marker. */ }
	if (!absent) {
		if (status.state !== "running" || status.summary !== UNVERIFIED_CLEANUP[purpose] || !status.errorMessage) {
			status = { ...status, state: "running", completedAt: undefined, exitCode: undefined, summary: UNVERIFIED_CLEANUP[purpose], errorMessage: status.errorMessage || "Process-group cleanup remains unverified.", updatedAt: nowIso() };
			await save(status);
		}
		return { status, pending: true };
	}
	const reason = purpose === "launch" ? "Launch failed; process-group cleanup verified." : purpose === "foreground" ? "Foreground delegation cancelled." : "Cancelled by user; process-group cleanup verified.";
	const parsed = "eventLogPath" in status ? parseAgentEvents(await readTextIfExists(status.eventLogPath)) : undefined;
	const exit = fileExists(status.exitPath) ? await readJson<{ exitCode: number; finishedAt: string }>(status.exitPath).catch(() => undefined) : undefined;
	const updated = { ...status, ...(parsed ? { usage: parsed.usage } : {}), state: purpose === "launch" ? "failed" as const : "cancelled" as const,
		exitCode: exit?.exitCode, completedAt: exit?.finishedAt || nowIso(), updatedAt: nowIso(), summary: reason,
		errorMessage: purpose === "launch" ? status.errorMessage : undefined };
	await fs.promises.writeFile(status.resultPath, `${truncateMiddle([reason, parsed?.finalOutput, status.errorMessage].filter(Boolean).join("\n\n"), MAX_RESULT_CHARS)}\n`, "utf8");
	await save(updated);
	await clearCleanupJournal(status);
	return { status: updated, pending: false };
}

async function startJobProcess<T extends AgentJobStatus | LoopJobStatus>(pi: ExtensionAPI, status: T, save: (status: T) => Promise<void>, kind: CompletionFollowUpKind = "agent"): Promise<void> {
	return withJobLifecycle(status.cwd, status.jobId, kind, async () => {
		try {
			status.processId = await launchDetachedRunScript(status.cwd, status.runScriptPath, status.pidPath);
			status.updatedAt = nowIso();
			await save(status);
		} catch (error) {
			let cleanupError: unknown;
			if (status.processId) {
				try {
					await terminateOwnedGroup(pi, status, false, 1000, "launch");
				} catch (failure) { cleanupError = failure; }
			}
			const reason = error instanceof Error ? error.message : String(error);
			const failed = { ...status, state: cleanupError ? "running" as const : "failed" as const,
				updatedAt: nowIso(), completedAt: cleanupError ? undefined : nowIso(),
				summary: cleanupError ? UNVERIFIED_CLEANUP.launch : "Failed to launch detached background process.",
				errorMessage: cleanupError ? `${reason}; cleanup: ${String(cleanupError)}` : reason };
			try { await save(failed); if (!cleanupError) await clearCleanupJournal(status); }
			catch (persistenceError) { throw new AggregateError([error, ...(cleanupError ? [cleanupError] : []), persistenceError], "Launch failed; status could not be persisted."); }
			if (cleanupError) throw new AggregateError([error, cleanupError], "Launch failed; process cleanup could not be verified.");
			throw error;
		}
	});
}

async function writeStatus(status: AgentJobStatus): Promise<void> {
	await writeJson(path.join(status.jobDir, "status.json"), status);
}

async function withJobLifecycle<T>(cwd: string, jobId: string, kind: CompletionFollowUpKind, action: () => Promise<T>): Promise<T> {
	const status = kind === "agent" ? await readStatus(cwd, jobId) : await readLoopStatus(cwd, jobId);
	return withJobLock(status.jobDir, action);
}

async function finalizeIfDone(pi: ExtensionAPI, cwd: string, jobId: string, sendFollowUp: boolean, session: SessionIdentity = {}): Promise<AgentJobStatus> {
	return withJobLifecycle(cwd, jobId, "agent", () => finalizeAgentUnlocked(pi, cwd, jobId, sendFollowUp, session));
}

async function finalizeAgentUnlocked(pi: ExtensionAPI, cwd: string, jobId: string, sendFollowUp: boolean, session: SessionIdentity = {}): Promise<AgentJobStatus> {
	const cleanup = await reconcileCleanup(pi, await readStatus(cwd, jobId), writeStatus);
	let status = cleanup.status;
	if (cleanup.pending) return status;
	if (status.state === "running" && !fileExists(status.exitPath) && await processIsMissing(pi, status)) {
		// Recheck after the process probe: normal completion may have raced with it.
		if (!fileExists(status.exitPath)) {
			const reason = "Process exited without an exit marker.";
			status = { ...status, state: status.cancelRequestedAt ? "cancelled" : "failed", completedAt: nowIso(), updatedAt: nowIso(), summary: reason, errorMessage: reason };
			await fs.promises.writeFile(status.resultPath, `${reason}\n`, "utf8");
			await writeStatus(status);
		}
	}
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
	return queueCompletionFollowUp(pi, "agent", status, message);
}

function queueCompletionFollowUp(pi: ExtensionAPI, kind: CompletionFollowUpKind, status: AgentJobStatus | LoopJobStatus, message: string): boolean {
	const key = followUpKey(kind, status.jobId, status.cwd);
	const existing = pendingFollowUpAcks.get(key);
	if (existing?.received) { void acknowledgeCompletionFollowUp(key, existing); return true; }
	if (existing && !existing.retryRequested) return true;
	if (followUpContext?.isIdle?.() && !followUpContext.hasPendingMessages?.()) {
		for (const pending of pendingFollowUpAcks.values()) {
			// Keep the acknowledgement and suppress retries of editor-owned messages.
			// Release only the serialization gate after an idle, empty-queue grace period.
			if (matchesDeliveryContext(pending) && Date.now() - pending.queuedAt >= WATCH_INTERVAL_MS) pending.blocking = false;
		}
	}
	if ([...pendingFollowUpAcks.values()].some(pending => pending.blocking && matchesDeliveryContext(pending))) return false;
	const token = existing?.token ?? randomBytes(16).toString("hex");
	pendingFollowUpAcks.set(key, { cwd: status.cwd, kind, jobId: status.jobId, parentCwd: followUpContext?.cwd ?? status.cwd, session: sessionIdentityFromContext(followUpContext ?? {}), queuedAt: Date.now(), blocking: true, received: false, token });
	const marker = completionFollowUpMarker(kind, status.jobId);
	const index = message.lastIndexOf(marker);
	const authenticated = `<!-- ${COMPLETION_FOLLOW_UP_MARKER}:${kind}:${status.jobId}:${token} -->`;
	message = message.slice(0, index) + authenticated + message.slice(index + marker.length);
	try { pi.sendUserMessage(message, { deliverAs: "followUp" }); return true; }
	catch { pendingFollowUpAcks.delete(key); return false; }
}

function stopWatchingJob(cwd: string, jobId: string): void {
	const key = `${cwd}:${jobId}`;
	const watch = watchedJobs.get(key);
	if (!watch) return;
	clearInterval(watch.interval);
	watchedJobs.delete(key);
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
				if (status.state !== "running" && (!needsCompletionFollowUp(status) || !isOriginSession(status, session))) stopWatchingJob(cwd, jobId);
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
	poll();
}

async function resumeRunningJobs(pi: ExtensionAPI, cwd: string, session: SessionIdentity): Promise<void> {
	const root = jobsRoot(cwd);
	if (!fileExists(root)) return;
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
}

async function enumerateAgentStatuses(cwd: string, signal?: AbortSignal): Promise<{ jobs: AgentJobStatus[]; warnings: string[] }> {
	const root = jobsRoot(cwd);
	const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	const jobs: AgentJobStatus[] = [];
	const warnings: string[] = [];
	for (const entry of entries) {
		signal?.throwIfAborted();
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		try {
			jobs.push(await readStatus(cwd, entry.name));
		} catch (error) {
			warnings.push(`${entry.name}: skipped invalid or unavailable job (${String(error)}).`);
		}
	}
	return { jobs, warnings };
}

async function listStatuses(cwd: string): Promise<AgentJobStatus[]> {
	const { jobs } = await enumerateAgentStatuses(cwd);
	return jobs.sort((a, b) => {
		const left = typeof a.createdAt === "string" ? a.createdAt : "";
		const right = typeof b.createdAt === "string" ? b.createdAt : "";
		return right.localeCompare(left) || a.jobId.localeCompare(b.jobId);
	});
}

export async function loadAgentManagerSnapshot(
	ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted" | "sessionManager">,
	registry: ForegroundRegistry, signal?: AbortSignal,
): Promise<ManagerSnapshot> {
	const cwd = await trustedAgentRoot(ctx);
	const { jobs, warnings } = await enumerateAgentStatuses(cwd, signal);
	const records = jobs.map((job) => ({ ...job, exitRecorded: job.state === "running" && fileExists(job.exitPath) }));
	const foreground = await Promise.all(registry.entries().map(async (entry) => ({
		...entry, cwd: await fs.promises.realpath(entry.cwd).catch(() => entry.cwd),
	})));
	signal?.throwIfAborted();
	return buildManagerSnapshot(cwd, records, foreground, sessionIdentityFromContext(ctx).id, warnings);
}

async function readManagerTail(file: string, signal?: AbortSignal): Promise<{ text: string; truncated: boolean }> {
	signal?.throwIfAborted();
	await assertArtifactPath(file);
	const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (!handle) return { text: "", truncated: false };
	try {
		const size = (await handle.stat()).size;
		const start = Math.max(0, size - 64 * 1024);
		const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
		signal?.throwIfAborted();
		return { text: buffer.toString("utf8", 0, bytesRead), truncated: start > 0 };
	} finally { await handle.close(); }
}

export async function readAgentManagerPreview(
	ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">, cwd: string, jobId: string, signal?: AbortSignal,
): Promise<ManagerPreview> {
	const root = await trustedAgentRoot(ctx, cwd);
	const job = await readStatus(root, jobId);
	const [events, result, stderr] = await Promise.all([
		readManagerTail(job.eventLogPath, signal), readManagerTail(job.resultPath, signal), readManagerTail(job.stderrPath, signal),
	]);
	const newline = events.text.indexOf("\n");
	const tail = events.truncated ? (newline < 0 ? "" : events.text.slice(newline + 1)) : events.text;
	const parsed = parseAgentEvents(tail);
	const output = result.text || parsed.finalOutput || (job.state === "running" ? "Waiting for assistant output…" : "No output recorded.");
	const activity = `${parsed.toolCalls} tool calls in recent event log`;
	return {
		output: boundedPreview(`${activity}\n\n${output}`, result.text ? result.truncated : events.truncated),
		errors: boundedPreview([typeof job.errorMessage === "string" ? job.errorMessage : "", stderr.text].filter(Boolean).join("\n\n"), stderr.truncated),
	};
}

export async function requestAgentCancellation(
	pi: ExtensionAPI, ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
	params: { jobId: string; cwd?: string; killWindow?: boolean }, signal?: AbortSignal,
): Promise<{ text: string; status: AgentJobStatus }> {
	const cwd = await trustedAgentRoot(ctx, params.cwd);
	return withJobLifecycle(cwd, params.jobId, "agent", async () => {
		const status = await finalizeAgentUnlocked(pi, cwd, params.jobId, false);
		if (status.state !== "running") return { text: `Job ${status.jobId} is already ${status.state}.`, status };
		if (status.cancelRequestedAt && !params.killWindow) return { text: `Cancellation is already pending for job ${status.jobId}.`, status };
		let signalled: boolean;
		try { signalled = params.killWindow ? await terminateOwnedGroup(pi, status, true, 0) : await signalOwnedAgent(pi, status, "SIGTERM", signal); }
		catch (error) {
			if (params.killWindow) await writeStatus({ ...status, cancelRequestedAt: status.cancelRequestedAt ?? nowIso(), updatedAt: nowIso(), summary: UNVERIFIED_CLEANUP.cancel, errorMessage: String(error) });
			throw error;
		}
		if (!signalled) {
			const finished = await finalizeAgentUnlocked(pi, cwd, params.jobId, false);
			if (finished.state !== "running") return { text: `Job ${finished.jobId} is already ${finished.state}.`, status: finished };
			throw new Error("Supervisor missing but process-group exit is unverified; no cancellation recorded.");
		}
		const requestedAt = nowIso();
		const pending = { ...status, cancelRequestedAt: requestedAt, updatedAt: requestedAt, summary: "Cancellation requested; waiting for the process to exit." };
		const stopped = params.killWindow;
		await writeStatus(pending);
		let updated: AgentJobStatus = pending;
		if (stopped) {
			updated = await finalizeAgentUnlocked(pi, cwd, params.jobId, false);
			if (updated.state === "running") {
				updated = { ...updated, state: "cancelled", completedAt: requestedAt, summary: "Cancelled by user." };
				await fs.promises.writeFile(updated.resultPath, "Cancelled by user.\n", "utf8");
				await writeStatus(updated);
			}
		}
		if (stopped && !needsCompletionFollowUp(updated)) stopWatchingJob(status.cwd, status.jobId);
		return { text: stopped ? `Cancelled job ${status.jobId}.` : `Cancellation requested for job ${status.jobId}.`, status: updated };
	});
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
	onDurableIdentity?: (job: AgentJobStatus) => void,
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
	// Synchronous internal registry handoff: no UI or I/O in this callback.
	onDurableIdentity?.(status);

	await startJobProcess(pi, status, writeStatus);
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
printf '%s\\n' ${shellQuote(`pi background loop job: ${params.jobId}`)}
printf '%s\\n' ${shellQuote(`stdout: ${params.stdoutPath}`)}
printf '%s\\n' ${shellQuote(`stderr: ${params.stderrPath}`)}
printf '%s\\n' ${shellQuote(`result: ${params.resultPath}`)}
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
printf '%s\\n' ${shellQuote(`Result will be written by the parent pi extension: ${params.resultPath}`)}
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

async function assertLoopArtifactDirectories(root: string, feature: string): Promise<string> {
	if (!feature || feature === "." || feature === ".." || /[/\\\\\0]/.test(feature)) throw new Error("Invalid loop feature.");
	const featureRoot = path.join(root, ".features", feature);
	for (const dir of [path.join(root, ".features"), featureRoot, path.join(featureRoot, "tasks"), path.join(featureRoot, "artifacts"), path.join(featureRoot, "artifacts", "loop")]) {
		await assertArtifactPath(dir, true);
	}
	return path.join(featureRoot, "artifacts", "loop");
}

async function readLoopStatus(cwd: string, jobId: string): Promise<LoopJobStatus> {
	const root = await fs.promises.realpath(cwd);
	const jobDir = loopJobDirFor(root, jobId);
	for (const dir of [path.join(root, ".pi"), loopJobsRoot(root), jobDir]) await assertArtifactPath(dir, true);
	await assertArtifactPath(path.join(jobDir, "status.json"));
	const status = await readJson<LoopJobStatus>(path.join(jobDir, "status.json"));
	if (!status || status.jobId !== jobId || typeof status.cwd !== "string" || typeof status.jobDir !== "string"
		|| typeof status.feature !== "string" || typeof status.createdAt !== "string" || !AGENT_JOB_STATES.includes(status.state)
		|| typeof status.followUp !== "boolean" || typeof status.followUpSent !== "boolean") throw new Error("Invalid loop job metadata.");
	if (await fs.promises.realpath(status.cwd) !== root || await fs.promises.realpath(status.jobDir) !== jobDir) throw new Error("Invalid loop job cwd or jobDir.");
	const artifacts = await assertLoopArtifactDirectories(root, status.feature);
	const files = { runScriptPath: "run.sh", stdoutPath: "stdout.log", stderrPath: "stderr.log", resultPath: "result.md", exitPath: "exit.json", pidPath: "pid" } as const;
	const featureFiles = { loopLogPath: "loop.log", loopSummaryPath: "latest-iteration.md", loopProgressPath: "progress.txt" } as const;
	for (const [key, name] of Object.entries({ ...files, ...featureFiles }) as Array<[keyof typeof files | keyof typeof featureFiles, string]>) {
		const featureArtifact = key in featureFiles;
		const expected = path.join(featureArtifact ? artifacts : jobDir, name);
		const supplied = status[key];
		let selected = expected;
		if (supplied !== undefined) {
			if (typeof supplied !== "string") throw new Error(`Invalid loop job ${key}.`);
			const parent = await fs.promises.realpath(path.dirname(supplied)).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
				return path.dirname(path.resolve(root, path.relative(status.cwd, supplied)));
			});
			selected = path.join(parent, path.basename(supplied));
			if (selected !== expected && !(featureArtifact && selected === path.join(jobDir, name))) throw new Error(`Invalid loop job ${key}: outside permitted artifacts.`);
		}
		await assertArtifactPath(selected);
		status[key] = selected;
	}
	await assertArtifactPath(path.join(jobDir, ".cleanup-pending.json"));
	return { ...status, cwd: root, jobDir };
}

async function writeLoopStatus(status: LoopJobStatus): Promise<void> {
	await writeJson(path.join(status.jobDir, "status.json"), status);
}

async function acknowledgeCompletionFollowUp(key: string, pending: PendingFollowUpAck): Promise<void> {
	const { kind, jobId } = pending;
	try {
		await withJobLifecycle(pending.cwd, jobId, kind, async () => {
			if (kind === "agent") {
				const status = await readStatus(pending.cwd, jobId);
				if (needsCompletionFollowUp(status) && isOriginSession(status, pending.session)) {
					await writeStatus({ ...status, followUpSent: true, updatedAt: nowIso() });
				}
				stopWatchingJob(pending.cwd, jobId);
			} else {
				const status = await readLoopStatus(pending.cwd, jobId);
				if (needsCompletionFollowUp(status) && isOriginSession(status, pending.session)) {
					await writeLoopStatus({ ...status, followUpSent: true, updatedAt: nowIso() });
				}
				stopWatchingLoopJob(pending.cwd, jobId);
			}
		});
		pendingFollowUpAcks.delete(key);
		setTimeout(pollWaitingFollowUps, 0);
	} catch {
		// Receipt already happened: retry persistence, never send the message again.
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
	return withJobLifecycle(cwd, jobId, "loop", () => finalizeLoopUnlocked(pi, cwd, jobId, sendFollowUp, session));
}

async function finalizeLoopUnlocked(pi: ExtensionAPI, cwd: string, jobId: string, sendFollowUp: boolean, session: SessionIdentity = {}): Promise<LoopJobStatus> {
	const cleanup = await reconcileCleanup(pi, await readLoopStatus(cwd, jobId), writeLoopStatus);
	let status = cleanup.status;
	if (cleanup.pending) return status;
	if (status.state === "running" && !fileExists(status.exitPath) && await processIsMissing(pi, status)) {
		if (!fileExists(status.exitPath)) {
			const reason = "Process exited without an exit marker.";
			status = { ...status, state: status.cancelRequestedAt ? "cancelled" : "failed", completedAt: nowIso(), updatedAt: nowIso(), summary: reason, errorMessage: reason };
			await fs.promises.writeFile(status.resultPath, `${reason}\n`, "utf8");
			await writeLoopStatus(status);
		}
	}
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
	return queueCompletionFollowUp(pi, "loop", status, message);
}

function stopWatchingLoopJob(cwd: string, jobId: string): void {
	const key = `${cwd}:${jobId}`;
	const watch = watchedLoopJobs.get(key);
	if (!watch) return;
	clearInterval(watch.interval);
	watchedLoopJobs.delete(key);
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
				if (status.state !== "running" && (!needsCompletionFollowUp(status) || !isOriginSession(status, session))) stopWatchingLoopJob(cwd, jobId);
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
	poll();
}

async function resumeRunningLoopJobs(pi: ExtensionAPI, cwd: string, session: SessionIdentity): Promise<void> {
	const root = loopJobsRoot(cwd);
	if (!fileExists(root)) return;
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
	const cwd = await trustedAgentRoot(ctx, params.cwd, "loop");
	const feature = await resolveLoopFeature(cwd, params.feature, params.task);
	await assertLoopArtifactDirectories(cwd, feature);

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
	for (const file of [loopLogPath, loopSummaryPath, loopProgressPath]) await assertArtifactPath(file);
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

	await startJobProcess(pi, status, writeLoopStatus, "loop");
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
	await withJobLifecycle(job.cwd, job.jobId, "agent", async () => {
		let status = await finalizeAgentUnlocked(pi, job.cwd, job.jobId, false);
		if (status.state !== "running") return;
		let signalled: boolean;
		try {
			signalled = await terminateOwnedGroup(pi, status, true, 1000, "foreground");
		} catch (error) {
			await writeStatus({ ...status, cancelRequestedAt: nowIso(), updatedAt: nowIso(), errorMessage: String(error), summary: UNVERIFIED_CLEANUP.foreground });
			throw error;
		}
		if (!signalled) {
			status = await finalizeAgentUnlocked(pi, job.cwd, job.jobId, false);
			if (status.state !== "running") return;
		}
		status = { ...status, cancelRequestedAt: nowIso(), updatedAt: nowIso() };
		await writeStatus(status);
		if (fileExists(status.exitPath)) {
			await finalizeAgentUnlocked(pi, status.cwd, status.jobId, false);
			return;
		}
		const completedAt = nowIso();
		await fs.promises.writeFile(status.resultPath, "Foreground delegation cancelled. No exit marker was available.\n", "utf8");
		await writeStatus({ ...status, state: "cancelled", completedAt, updatedAt: completedAt, summary: "Foreground delegation cancelled." });
	});
}

async function runForegroundAgents(
	pi: ExtensionAPI, ctx: LaunchContext, tasks: ForegroundTask[],
	options: { agentScope?: AgentScope; confirmProjectAgents?: boolean },
	signal: AbortSignal, update: (results: ForegroundResult[]) => void,
	lifecycle: { launching(index: number): void; durable(index: number, job: AgentJobStatus): void },
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
				lifecycle.launching(index);
				try {
					const job = await launchAgentJob(pi, { ...ctx, signal }, { ...options, ...task, followUp: false }, false,
						(job) => lifecycle.durable(index, job));
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
	const registry = new ForegroundRegistry();
	const managerControllers = new Set<AbortController>();
	pi.registerCommand("agents", {
		description: "Monitor current-project agents, inspect output, and safely request cancellation",
		async handler(_args, ctx) {
			const controller = new AbortController();
			managerControllers.add(controller);
			try {
				await showAgentManager(ctx, {
					load: (signal) => loadAgentManagerSnapshot(ctx, registry, signal),
					preview: (cwd, jobId, signal) => readAgentManagerPreview(ctx, cwd, jobId, signal),
					cancel: async (cwd, jobId) => (await requestAgentCancellation(pi, ctx, { cwd, jobId })).text,
				}, controller.signal);
			} catch (error) {
				if (!controller.signal.aborted) ctx.ui.notify(String(error), "error");
			} finally { managerControllers.delete(controller); }
		},
	});
	const foregroundRuns = new Map<AbortController, Promise<ForegroundResult[]>>();
	pi.on("session_shutdown", async () => {
		for (const controller of managerControllers) controller.abort();
		for (const controller of foregroundRuns.keys()) controller.abort();
		await Promise.allSettled(foregroundRuns.values());
		registry.clear();
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
			const trackedTasks = tasks.map((task) => ({ ...task, cwd: path.resolve(ctx.cwd, task.cwd ?? ".") }));
			const runId = registry.begin(trackedTasks);
			const controller = new AbortController();
			const abort = () => controller.abort();
			if (signal?.aborted) abort();
			signal?.addEventListener("abort", abort, { once: true });
			const run = runForegroundAgents(pi, ctx, tasks, params, controller.signal, (results) => {
				registry.update(runId, results);
				onUpdate?.({ content: [{ type: "text", text: foregroundText(results) }], details: { results } });
			}, {
				launching: (index) => registry.launching(runId, index),
				durable: (index, job) => registry.bind(runId, index, job.jobId),
			});
			foregroundRuns.set(controller, run);
			try {
				const results = await run;
				const text = foregroundText(results);
				if (single && results[0]?.state !== "completed") throw new Error(text);
				return { content: [{ type: "text" as const, text }], details: { results } };
			} finally {
				foregroundRuns.delete(controller);
				registry.finish(runId);
				signal?.removeEventListener("abort", abort);
			}
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		followUpContext = ctx;
		const session = sessionIdentityFromContext(ctx);
		try {
			const root = await trustedAgentRoot(ctx);
			await resumeRunningJobs(pi, root, session);
		} catch { /* Untrusted or invalid agent job directories must not auto-resume. */ }
		try {
			const root = await trustedAgentRoot(ctx, undefined, "loop");
			await resumeRunningLoopJobs(pi, root, session);
		} catch { /* Untrusted or malformed loop metadata must not auto-resume. */ }
	});
	pi.on("agent_end", (_event, ctx) => {
		followUpContext = ctx;
		pollWaitingFollowUps();
	});

	pi.on("message_start", async (event, ctx) => {
		if (event.message.role !== "user") return;
		const markers = parseCompletionFollowUpMarkers(textFromMessageContent(event.message.content));
		for (const marker of markers) {
			for (const [key, pending] of pendingFollowUpAcks) {
				if (pending.kind === marker.kind && pending.jobId === marker.jobId && pending.token === marker.token && matchesDeliveryContext(pending, ctx)) {
					pending.received = true;
					pending.blocking = false;
					await acknowledgeCompletionFollowUp(key, pending);
				}
			}
		}
	});

	pi.on("session_shutdown", (event = { type: "session_shutdown", reason: "quit" }, ctx) => {
		// Session replacement destroys the old queue; reload preserves it and editor ownership.
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			for (const pending of pendingFollowUpAcks.values()) {
				if (!pending.received && matchesDeliveryContext(pending, ctx)) {
					pending.retryRequested = true;
					pending.blocking = false;
				}
			}
		}
		for (const watch of watchedJobs.values()) clearInterval(watch.interval);
		for (const watch of watchedLoopJobs.values()) clearInterval(watch.interval);
		watchedJobs.clear();
		watchedLoopJobs.clear();
		followUpContext = undefined;
		knownGroups.clear();
	});

	pi.registerCommand("agent-notification-retry", {
		description: "Explicitly retry an unreceived completion notification (not the job): agent|loop job-id",
		handler: async (args, ctx) => {
			const [kind, jobId, extra] = args.trim().split(/\s+/);
			if ((kind !== "agent" && kind !== "loop") || !jobId || extra) throw new Error("Usage: /agent-notification-retry agent|loop <job-id>");
			const cwd = await trustedAgentRoot(ctx, undefined, kind);
			const session = sessionIdentityFromContext(ctx);
			const status = kind === "agent" ? await readStatus(cwd, jobId) : await readLoopStatus(cwd, jobId);
			if (!isOriginSession(status, session)) throw new Error("Notification retry is restricted to the originating conversation.");
			if (!needsCompletionFollowUp(status)) throw new Error("This job has no pending completion notification.");
			if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Wait until Pi is idle and its message queue is empty before retrying.");
			const key = followUpKey(kind, jobId, cwd);
			const pending = pendingFollowUpAcks.get(key);
			if (pending?.received) { await acknowledgeCompletionFollowUp(key, pending); return; }
			if (!ctx.hasUI) throw new Error("Notification retry requires interactive confirmation.");
			if (pending && ctx.ui.getEditorText().includes(pending.token)) throw new Error("The original notification is still in the editor; submit or discard it first.");
			if (!await ctx.ui.confirm("Retry completion notification?", "Pi cannot confirm the earlier dispatch. Retrying may duplicate a notification. This does not restart the job.")) return;
			if (!ctx.isIdle() || ctx.hasPendingMessages() || (pending && ctx.ui.getEditorText().includes(pending.token))) throw new Error("Delivery ownership changed during confirmation; retry was not reset.");
			if (pending) { pending.retryRequested = true; pending.blocking = false; }
			followUpContext = ctx;
			if (kind === "agent") { await finalizeIfDone(pi, cwd, jobId, true, session); watchJob(pi, cwd, jobId, session); }
			else { await finalizeLoopIfDone(pi, cwd, jobId, true, session); watchLoopJob(pi, cwd, jobId, session); }
		},
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
				const cwd = await trustedAgentRoot(ctx, parsed.cwd, "loop");
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
			const status = await launchLoopJob(pi, { ...ctx, signal }, {
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
			const cwd = await trustedAgentRoot(ctx, params.cwd, "loop");
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
			const cwd = await trustedAgentRoot(ctx, params.cwd, "loop");
			return withJobLifecycle(cwd, params.jobId, "loop", async () => {
				const status = await finalizeLoopUnlocked(pi, cwd, params.jobId, false);
				if (status.state !== "running") {
					return { content: [{ type: "text" as const, text: `Loop job ${status.jobId} is already ${status.state}.` }], details: status };
				}
				if (status.cancelRequestedAt && !params.killWindow) {
					return { content: [{ type: "text" as const, text: `Cancellation is already pending for loop job ${status.jobId}.` }], details: status };
				}
				let signalled: boolean;
				try { signalled = params.killWindow ? await terminateOwnedGroup(pi, status, true, 0) : await signalOwnedAgent(pi, status, "SIGTERM", signal); }
				catch (error) {
					if (params.killWindow) await writeLoopStatus({ ...status, cancelRequestedAt: status.cancelRequestedAt ?? nowIso(), updatedAt: nowIso(), summary: UNVERIFIED_CLEANUP.cancel, errorMessage: String(error) });
					throw error;
				}
				if (!signalled) {
					const finished = await finalizeLoopUnlocked(pi, cwd, params.jobId, false);
					if (finished.state !== "running") return { content: [{ type: "text" as const, text: `Loop job ${finished.jobId} is already ${finished.state}.` }], details: finished };
					throw new Error("Supervisor missing but process-group exit is unverified; no cancellation recorded.");
				}
				const requestedAt = nowIso();
				const pending = { ...status, cancelRequestedAt: requestedAt, updatedAt: requestedAt, summary: "Cancellation requested; waiting for the process to exit." };
				const stopped = params.killWindow;
				await writeLoopStatus(pending);
				let updated: LoopJobStatus = pending;
				if (stopped) {
					updated = await finalizeLoopUnlocked(pi, cwd, params.jobId, false);
					if (updated.state === "running") {
						updated = { ...updated, state: "cancelled", completedAt: requestedAt, summary: "Cancelled by user." };
						await fs.promises.writeFile(updated.resultPath, "Cancelled by user.\n", "utf8");
						await writeLoopStatus(updated);
					}
				}
				if (stopped && !needsCompletionFollowUp(updated)) stopWatchingLoopJob(status.cwd, status.jobId);
				return { content: [{ type: "text" as const, text: stopped ? `Cancelled loop job ${status.jobId}.` : `Cancellation requested for loop job ${status.jobId}.` }], details: updated };
			});
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
			const result = await requestAgentCancellation(pi, ctx, params, signal);
			return { content: [{ type: "text" as const, text: result.text }], details: result.status };
		},
	});
}
