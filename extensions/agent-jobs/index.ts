import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { Text } from "@mariozechner/pi-tui";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";

export type AgentJobMode = "standard" | "review";
export type AgentJobState = "running" | "completed" | "failed" | "cancelled";

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
	summary?: string;
	errorMessage?: string;
	usage?: UsageStats;
	followUp: boolean;
	followUpSent: boolean;
}

const JOBS_DIR = path.join(".pi", "agent-jobs");
const WATCH_INTERVAL_MS = 5000;
const MAX_RESULT_CHARS = 60_000;
const FOLLOW_UP_RESULT_CHARS = 12_000;
const STDERR_TAIL_CHARS = 8000;
const MAX_DIFF_CHARS = 18_000;
const MAX_UNTRACKED_FILES = 10;
const MAX_UNTRACKED_FILE_CHARS = 2000;
const MAX_UNTRACKED_TOTAL_CHARS = 8000;

const watchedJobs = new Map<string, NodeJS.Timeout>();

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const AgentJobModeSchema = StringEnum(["standard", "review"] as const, {
	description: 'Job prompt mode. Use "review" for oracle reviews so the launcher snapshots git diff context first.',
	default: "standard",
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
echo "You can close this window when done."
exit "$code"
`;
}

export function buildTmuxNewWindowArgs(windowName: string, cwd: string, runScriptPath: string): string[] {
	const command = [
		`bash ${shellQuote(runScriptPath)}`,
		"code=$?",
		"echo",
		"echo '--- pi agent job window ---'",
		"echo 'Job finished. Press Enter to close this tmux window.'",
		"read _",
		"exit $code",
	].join("; ");
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
	const status = await readStatus(cwd, jobId);
	if (status.state !== "running") return status;
	if (!fileExists(status.exitPath)) return status;

	const exit = await readJson<{ exitCode: number; finishedAt: string }>(status.exitPath);
	const events = fileExists(status.eventLogPath) ? await fs.promises.readFile(status.eventLogPath, "utf8") : "";
	const stderr = fileExists(status.stderrPath) ? await fs.promises.readFile(status.stderrPath, "utf8") : "";
	const parsed = parseAgentEvents(events);
	const hasModelError = parsed.stopReason === "error" || Boolean(parsed.errorMessage);
	const state: AgentJobState = exit.exitCode === 0 && !hasModelError ? "completed" : "failed";
	const fallbackOutput = state === "failed" && stderr.trim() ? `Agent failed.\n\n## stderr\n\n${truncateTail(stderr, STDERR_TAIL_CHARS)}` : "(no output)";
	const output = parsed.finalOutput || parsed.errorMessage || fallbackOutput;
	const resultText = truncateMiddle(output, MAX_RESULT_CHARS);

	await fs.promises.writeFile(status.resultPath, `${resultText.trim()}\n`, "utf8");

	const updated: AgentJobStatus = {
		...status,
		state,
		exitCode: exit.exitCode,
		completedAt: exit.finishedAt,
		updatedAt: nowIso(),
		summary: firstNonEmptyLine(resultText) || (state === "completed" ? "Completed with no output." : "Failed with no output."),
		errorMessage: state === "failed" ? parsed.errorMessage || (stderr.trim() ? firstNonEmptyLine(stderr) : `exit code ${exit.exitCode}`) : undefined,
		usage: parsed.usage,
	};

	await writeStatus(updated);

	if (sendFollowUp && updated.followUp && !updated.followUpSent) {
		const wasSent = await sendCompletionFollowUp(pi, updated, resultText);
		if (wasSent) {
			const sent = { ...updated, followUpSent: true, updatedAt: nowIso() };
			await writeStatus(sent);
			return sent;
		}
	}

	return updated;
}

async function sendCompletionFollowUp(pi: ExtensionAPI, status: AgentJobStatus, resultText: string): Promise<boolean> {
	const clipped = resultText.length > FOLLOW_UP_RESULT_CHARS
		? `${resultText.slice(0, FOLLOW_UP_RESULT_CHARS).trimEnd()}\n\n…[result truncated; full result: ${status.resultPath}]…`
		: resultText;
	const verdict = status.state === "completed" ? "finished" : "failed";
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
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");

	try {
		pi.sendUserMessage(message, { deliverAs: "followUp" });
		return true;
	} catch {
		try {
			pi.sendUserMessage(message);
			return true;
		} catch {
			return false;
		}
	}
}

function watchJob(pi: ExtensionAPI, cwd: string, jobId: string): void {
	const key = `${cwd}:${jobId}`;
	if (watchedJobs.has(key)) return;

	const interval = setInterval(() => {
		void finalizeIfDone(pi, cwd, jobId, true)
			.then((status) => {
				if (status.state !== "running") {
					clearInterval(interval);
					watchedJobs.delete(key);
				}
			})
			.catch(() => {
				clearInterval(interval);
				watchedJobs.delete(key);
			});
	}, WATCH_INTERVAL_MS);
	watchedJobs.set(key, interval);
}

async function resumeRunningJobs(pi: ExtensionAPI, cwd: string): Promise<void> {
	const root = jobsRoot(cwd);
	if (!fileExists(root)) return;
	const entries = await fs.promises.readdir(root, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			const status = await readStatus(cwd, entry.name);
			if (status.state === "running") watchJob(pi, cwd, entry.name);
		} catch {
			// Ignore malformed old job dirs.
		}
	}
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
		await pi.exec("tmux", buildTmuxNewWindowArgs(tmuxWindow, cwd, runScriptPath), { signal: ctx.signal, timeout: 10_000 });
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

export default function agentJobsExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		void resumeRunningJobs(pi, ctx.cwd);
	});

	pi.on("session_shutdown", () => {
		for (const interval of watchedJobs.values()) clearInterval(interval);
		watchedJobs.clear();
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
		renderResult(result, _options, theme) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			return new Text(result.isError ? theme.fg("error", text) : theme.fg("success", text), 0, 0);
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
			await pi.exec("tmux", ["send-keys", "-t", status.tmuxWindow, "C-c"], { signal, timeout: 5000 });
			if (params.killWindow) {
				await pi.exec("tmux", ["kill-window", "-t", status.tmuxWindow], { signal, timeout: 5000 }).catch(() => undefined);
			}
			const updated = { ...status, state: "cancelled" as const, updatedAt: nowIso(), completedAt: nowIso(), summary: "Cancelled by user." };
			await writeStatus(updated);
			return { content: [{ type: "text" as const, text: `Cancelled job ${status.jobId}.` }], details: updated };
		},
	});
}
