export type ManagerState = "queued" | "launching" | "running" | "completed" | "failed" | "cancelled";
export interface ForegroundEntry {
	key: string;
	agent: string;
	task: string;
	cwd: string;
	state: ManagerState;
	createdAt: number;
	completedAt?: number;
	jobId?: string;
	output?: string;
}

// Owned by the foreground executor, never by an overlay instance.
export class ForegroundRegistry {
	private nextRun = 0;
	private readonly runs = new Map<string, ForegroundEntry[]>();
	private recent: ForegroundEntry[] = [];

	begin(tasks: Array<{ agent: string; task: string; cwd: string }>): string {
		const run = String(++this.nextRun);
		this.runs.set(run, tasks.map((task, index) => ({ ...task, key: `foreground:${run}:${index}`, state: "queued", createdAt: Date.now() })));
		return run;
	}
	launching(run: string, index: number): void {
		const entry = this.runs.get(run)?.[index];
		if (entry) entry.state = "launching";
	}
	bind(run: string, index: number, jobId: string): void {
		const entry = this.runs.get(run)?.[index];
		if (entry) entry.jobId = jobId;
	}
	update(run: string, results: Array<{ state: ManagerState; output?: string }>): void {
		results.forEach((result, index) => {
			const entry = this.runs.get(run)?.[index];
			if (!entry) return;
			if (result.state !== "queued") entry.state = result.state;
			entry.output = result.output;
			if (!isActive(entry.state)) entry.completedAt ??= Date.now();
		});
	}
	finish(run: string): void {
		const entries = this.runs.get(run) ?? [];
		for (const entry of entries) {
			if (entry.jobId) continue;
			if (isActive(entry.state)) {
				entry.state = "cancelled";
				entry.output = "Foreground run ended before this task launched.";
				entry.completedAt = Date.now();
			}
			this.recent.push(entry);
		}
		this.recent = this.recent.slice(-20);
		this.runs.delete(run);
	}
	entries(): ForegroundEntry[] {
		return [...this.runs.values()].flat().concat(this.recent).map(entry => ({ ...entry }));
	}
	clear(): void { this.runs.clear(); this.recent = []; }
}

export interface ManagerRow {
	key: string;
	jobId?: string;
	agent: string;
	task: string;
	state: ManagerState;
	origin: "current" | "other" | "unknown";
	createdAt?: number;
	completedAt?: number;
	model: string;
	followUp?: boolean;
	cancellationPending: boolean;
	exitRecorded: boolean;
	output?: string;
	resultPath?: string;
	eventLogPath?: string;
	stderrPath?: string;
}
export interface ManagerSnapshot {
	cwd: string;
	loadedAt: number;
	rows: ManagerRow[];
	running: number;
	queued: number;
	warnings: string[];
}
export interface ManagerPreview { output: string; errors: string }

export function isActive(state: ManagerState): boolean {
	return state === "queued" || state === "launching" || state === "running";
}

export function sanitizeDisplay(value: unknown, label = false): string {
	const text = typeof value === "string" ? value : "";
	const clean = text
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b[ -/]*[@-~]/g, "")
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
	return label ? clean.replace(/\s+/g, " ").trim() : clean.replace(/\t/g, "    ");
}

export function boundedPreview(text: string, byteTruncated = false): string {
	const lines = sanitizeDisplay(text).split("\n");
	return lines.length > 200 || byteTruncated
		? ["[Truncated preview; inspect the artifact for full output.]", ...lines.slice(-199)].join("\n")
		: lines.join("\n");
}

function timestamp(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}
function label(value: unknown, fallback: string): string { return sanitizeDisplay(value, true) || fallback; }

export function buildManagerSnapshot(
	cwd: string, jobs: readonly object[], foreground: readonly ForegroundEntry[], sessionId?: string,
	warnings: string[] = [], now = Date.now(),
): ManagerSnapshot {
	const issues = [...warnings];
	const rows: ManagerRow[] = [];
	const durableIds = new Set<string>();
	const bindings = new Map(foreground.filter(entry => entry.cwd === cwd && entry.jobId).map(entry => [entry.jobId, entry.key]));
	for (const record of jobs) {
		const job = record as Record<string, unknown>;
		if (typeof job.jobId !== "string" || typeof job.state !== "string" || !["running", "completed", "failed", "cancelled"].includes(job.state)) {
			issues.push("Skipped invalid agent job display metadata.");
			continue;
		}
		const createdAt = timestamp(job.createdAt);
		if (createdAt === undefined || typeof job.agent !== "string" || typeof job.task !== "string") {
			issues.push(`${sanitizeDisplay(job.jobId, true)}: some display metadata is unavailable.`);
		}
		durableIds.add(job.jobId);
		rows.push({
			key: bindings.get(job.jobId) ?? `job:${job.jobId}`, jobId: job.jobId, agent: label(job.agent, "unknown agent"), task: label(job.task, "Task unavailable"),
			state: job.state as ManagerState, createdAt, completedAt: timestamp(job.completedAt),
			origin: typeof job.originSessionId !== "string" || !sessionId ? "unknown" : job.originSessionId === sessionId ? "current" : "other",
			model: label(job.model, "unknown"), followUp: typeof job.followUp === "boolean" ? job.followUp : undefined,
			cancellationPending: typeof job.cancelRequestedAt === "string", exitRecorded: job.exitRecorded === true,
			output: sanitizeDisplay(job.errorMessage),
			resultPath: typeof job.resultPath === "string" ? job.resultPath : undefined,
			eventLogPath: typeof job.eventLogPath === "string" ? job.eventLogPath : undefined,
			stderrPath: typeof job.stderrPath === "string" ? job.stderrPath : undefined,
		});
	}
	for (const entry of foreground) {
		if (entry.cwd !== cwd || (entry.jobId && durableIds.has(entry.jobId))) continue;
		rows.push({
			key: entry.key, jobId: entry.jobId,
			agent: label(entry.agent, "unknown agent"), task: label(entry.task, "Task unavailable"), state: entry.state,
			createdAt: entry.createdAt, completedAt: entry.completedAt, origin: "current", model: "unknown", followUp: false,
			cancellationPending: false, exitRecorded: false, output: sanitizeDisplay(entry.output),
		});
	}
	const sort = (a: ManagerRow, b: ManagerRow) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.key.localeCompare(b.key);
	const active = rows.filter(row => isActive(row.state)).sort(sort);
	const recent = rows.filter(row => !isActive(row.state)).sort((a, b) =>
		(b.completedAt ?? b.createdAt ?? 0) - (a.completedAt ?? a.createdAt ?? 0) || a.key.localeCompare(b.key),
	).slice(0, 20);
	return {
		cwd, loadedAt: now, rows: [...active, ...recent],
		running: active.filter(row => row.state === "running").length,
		queued: active.filter(row => row.state === "queued" || row.state === "launching").length,
		warnings: issues.map(issue => sanitizeDisplay(issue, true)),
	};
}

export function elapsed(start: number | undefined, end: number | undefined, now: number): string {
	if (start === undefined) return "unknown";
	const seconds = Math.max(0, Math.floor(((end ?? now) - start) / 1000));
	return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
}
