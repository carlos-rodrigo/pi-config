import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export const CHECKPOINT_SCHEMA_VERSION = 1;
export const CHECKPOINT_ROOT = ".pi/self-improvement/checkpoints";
export const CHECKPOINT_INDEX_FILE = "checkpoints.jsonl";

const CHECKPOINT_ACTIONS = ["create", "list", "preview", "rollback"] as const;

type CheckpointAction = (typeof CHECKPOINT_ACTIONS)[number] | "help";
type OperationStatus = "created" | "listed" | "preview" | "rolled-back" | "refused";

type ExecResult = {
	code: number;
	stdout: string;
	stderr: string;
};

export type ExecRunner = {
	exec(command: string, args: string[]): Promise<ExecResult>;
};

export interface ParsedCheckpointArgs {
	action: CheckpointAction;
	id?: string;
	label?: string;
	confirm: boolean;
	force: boolean;
	error?: string;
}

export interface CheckpointRecord {
	schemaVersion: 1;
	id: string;
	label?: string;
	createdAt: string;
	repoRoot: string;
	headSha: string;
	branch?: string;
	statusShort: string[];
	dirtySummary: string;
	patchFile: string;
	patchBytes: number;
	untrackedFiles: string[];
}

export interface CheckpointOperationResult {
	status: OperationStatus;
	report: string;
	checkpoint?: CheckpointRecord;
	checkpoints?: CheckpointRecord[];
}

function splitLines(output: string): string[] {
	return output
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
}

function trimOutput(output: string): string {
	return output.trim();
}

function gitFailureMessage(result: ExecResult, fallback: string): string {
	return trimOutput(result.stderr) || trimOutput(result.stdout) || fallback;
}

async function runGit(runner: ExecRunner, cwd: string, args: string[], fallback: string): Promise<string> {
	const result = await runner.exec("git", ["-C", cwd, ...args]);
	if (result.code !== 0) throw new Error(gitFailureMessage(result, fallback));
	return result.stdout;
}

async function resolveRepoRoot(runner: ExecRunner, cwd: string): Promise<string> {
	const result = await runner.exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
	if (result.code !== 0) throw new Error("Not inside a git repository");
	return trimOutput(result.stdout);
}

async function readCurrentHead(runner: ExecRunner, repoRoot: string): Promise<string> {
	return trimOutput(await runGit(runner, repoRoot, ["rev-parse", "--verify", "HEAD"], "Repository has no HEAD commit"));
}

async function readCurrentBranch(runner: ExecRunner, repoRoot: string): Promise<string | undefined> {
	const result = await runner.exec("git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"]);
	if (result.code !== 0) return undefined;
	const branch = trimOutput(result.stdout);
	return branch.length > 0 ? branch : undefined;
}

async function readStatusShort(runner: ExecRunner, repoRoot: string): Promise<string[]> {
	return splitLines(await runGit(runner, repoRoot, ["status", "--short"], "Failed to read git status"));
}

function isInternalCheckpointPath(file: string): boolean {
	const normalized = file.replace(/\\/g, "/");
	return normalized === CHECKPOINT_ROOT || normalized.startsWith(`${CHECKPOINT_ROOT}/`);
}

async function readUntrackedFiles(runner: ExecRunner, repoRoot: string): Promise<string[]> {
	const output = await runGit(runner, repoRoot, ["ls-files", "--others", "--exclude-standard"], "Failed to list untracked files");
	return splitLines(output).filter((file) => !isInternalCheckpointPath(file));
}

async function readDirtyPatch(runner: ExecRunner, repoRoot: string): Promise<string> {
	return await runGit(runner, repoRoot, ["diff", "--binary", "HEAD", "--"], "Failed to read git diff");
}

async function readDirtySummary(runner: ExecRunner, repoRoot: string, untrackedFiles: string[]): Promise<string> {
	const trackedSummary = trimOutput(await runGit(runner, repoRoot, ["diff", "--stat", "HEAD", "--"], "Failed to read git diff summary"));
	const lines: string[] = [];
	if (trackedSummary) lines.push(trackedSummary);
	if (untrackedFiles.length > 0) {
		lines.push(`Untracked files (${untrackedFiles.length}, names only; contents not captured):`);
		lines.push(...untrackedFiles.map((file) => `  ${file}`));
	}
	return lines.length > 0 ? lines.join("\n") : "clean";
}

function checkpointDir(repoRoot: string): string {
	return join(repoRoot, CHECKPOINT_ROOT);
}

function checkpointIndexPath(repoRoot: string): string {
	return join(checkpointDir(repoRoot), CHECKPOINT_INDEX_FILE);
}

function checkpointPatchFile(id: string): string {
	return join(CHECKPOINT_ROOT, `${id}.patch`);
}

function createCheckpointId(): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return `checkpoint-${timestamp}-${randomUUID().slice(0, 8)}`;
}

function appendCheckpointRecord(repoRoot: string, record: CheckpointRecord, patch: string): void {
	const root = checkpointDir(repoRoot);
	mkdirSync(root, { recursive: true });
	writeFileSync(join(repoRoot, record.patchFile), patch, "utf8");
	appendFileSync(checkpointIndexPath(repoRoot), `${JSON.stringify(record)}\n`, "utf8");
}

function isCheckpointRecord(value: unknown): value is CheckpointRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<CheckpointRecord>;
	return (
		record.schemaVersion === CHECKPOINT_SCHEMA_VERSION &&
		typeof record.id === "string" &&
		typeof record.createdAt === "string" &&
		typeof record.repoRoot === "string" &&
		typeof record.headSha === "string" &&
		typeof record.dirtySummary === "string" &&
		typeof record.patchFile === "string" &&
		typeof record.patchBytes === "number" &&
		Array.isArray(record.statusShort) &&
		Array.isArray(record.untrackedFiles)
	);
}

export function readCheckpointRecords(repoRoot: string): CheckpointRecord[] {
	const indexPath = checkpointIndexPath(repoRoot);
	if (!existsSync(indexPath)) return [];
	const records: CheckpointRecord[] = [];
	for (const line of readFileSync(indexPath, "utf8").split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as unknown;
			if (isCheckpointRecord(parsed)) records.push(parsed);
		} catch {
			// Ignore malformed local checkpoint rows; later valid checkpoints remain usable.
		}
	}
	return records;
}

export function parseCheckpointArgs(input: string): ParsedCheckpointArgs {
	const rawTokens = input.trim().length > 0 ? input.trim().split(/\s+/) : [];
	let confirm = false;
	let force = false;
	const tokens: string[] = [];

	for (const token of rawTokens) {
		if (token === "--confirm") {
			confirm = true;
			continue;
		}
		if (token === "--force") {
			force = true;
			continue;
		}
		tokens.push(token);
	}

	const actionToken = tokens.shift() ?? "help";
	if (actionToken === "help" || actionToken === "--help") return { action: "help", confirm, force };
	if (actionToken === "create") {
		const label = tokens.join(" ").trim();
		return label ? { action: "create", label, confirm, force } : { action: "create", confirm, force };
	}
	if (actionToken === "list") {
		return tokens.length > 0 ? { action: "list", confirm, force, error: `Unsupported list argument: ${tokens[0]}` } : { action: "list", confirm, force };
	}
	if (actionToken === "preview" || actionToken === "rollback") {
		if (tokens.length > 1) return { action: actionToken, confirm, force, error: `Unsupported ${actionToken} argument: ${tokens[1]}` };
		const id = tokens[0] ?? "last";
		return { action: actionToken, id, confirm, force };
	}
	return { action: "help", confirm, force, error: `Unsupported checkpoint action: ${actionToken}` };
}

export function selectCheckpoint(records: CheckpointRecord[], id = "last"): { checkpoint?: CheckpointRecord; error?: string } {
	if (records.length === 0) return { error: "No checkpoints found" };
	if (id === "last") return { checkpoint: records[records.length - 1] };

	const exact = records.find((record) => record.id === id);
	if (exact) return { checkpoint: exact };

	const matches = records.filter((record) => record.id.startsWith(id));
	if (matches.length === 1) return { checkpoint: matches[0] };
	if (matches.length > 1) return { error: `Ambiguous checkpoint id '${id}': ${matches.map((record) => record.id).join(", ")}` };
	return { error: `Checkpoint not found: ${id}` };
}

function firstSummaryLine(record: CheckpointRecord): string {
	return record.dirtySummary.split(/\r?\n/)[0] ?? "clean";
}

export function formatCheckpointList(records: CheckpointRecord[]): string {
	if (records.length === 0) return "No checkpoints found.";
	return [
		"Checkpoints:",
		...records.map((record) => {
			const label = record.label ? ` — ${record.label}` : "";
			const branch = record.branch ? ` on ${record.branch}` : "";
			return `- ${record.id}${label}\n  ${record.createdAt}${branch} @ ${record.headSha.slice(0, 12)}\n  dirty: ${firstSummaryLine(record)}\n  patch: ${record.patchFile} (${record.patchBytes} bytes)`;
		}),
	].join("\n");
}

function formatCreatedCheckpoint(record: CheckpointRecord): string {
	return [
		`Checkpoint created: ${record.id}`,
		record.label ? `Label: ${record.label}` : undefined,
		`HEAD: ${record.headSha}`,
		record.branch ? `Branch: ${record.branch}` : undefined,
		`Patch: ${record.patchFile} (${record.patchBytes} bytes)`,
		"Dirty summary:",
		record.dirtySummary,
		"",
		`Preview rollback: /checkpoint rollback ${record.id}`,
		`Confirm rollback: /checkpoint rollback ${record.id} --confirm`,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

function checkpointUntrackedSet(record: CheckpointRecord): Set<string> {
	return new Set(record.untrackedFiles);
}

function newUntrackedFiles(record: CheckpointRecord, currentUntracked: string[]): string[] {
	const checkpointFiles = checkpointUntrackedSet(record);
	return currentUntracked.filter((file) => !checkpointFiles.has(file));
}

function formatRollbackReport(input: {
	checkpoint: CheckpointRecord;
	currentHead: string;
	currentUntracked: string[];
	newUntracked: string[];
	confirm: boolean;
	force: boolean;
	unsafeReasons: string[];
	completed?: boolean;
}): string {
	const { checkpoint, currentHead, currentUntracked, newUntracked, confirm, force, unsafeReasons, completed } = input;
	const lines = [
		completed ? `Rollback complete: ${checkpoint.id}` : `Rollback preview: ${checkpoint.id}`,
		checkpoint.label ? `Label: ${checkpoint.label}` : undefined,
		`Checkpoint HEAD: ${checkpoint.headSha}`,
		`Current HEAD: ${currentHead}`,
		`Patch: ${checkpoint.patchFile} (${checkpoint.patchBytes} bytes)`,
		"Checkpoint dirty summary:",
		checkpoint.dirtySummary,
		"",
		"Planned tracked-file operation:",
		"- restore tracked index/worktree to HEAD with git restore",
		"- reapply the checkpoint patch with git apply",
	] as Array<string | undefined>;

	if (currentUntracked.length > 0) {
		lines.push("", `Current untracked files (${currentUntracked.length}):`, ...currentUntracked.map((file) => `- ${file}`));
	}
	if (newUntracked.length > 0) {
		lines.push("", force ? "New untracked files to remove because --force is set:" : "New untracked files require --force before rollback:", ...newUntracked.map((file) => `- ${file}`));
	}
	if (unsafeReasons.length > 0) {
		lines.push("", "Refusal reasons:", ...unsafeReasons.map((reason) => `- ${reason}`));
	}
	if (!confirm && !completed) {
		lines.push("", "No changes made; rollback requires --confirm.");
	}
	if (confirm && unsafeReasons.length > 0 && !completed) {
		lines.push("", "No changes made; rollback refused.");
	}
	return lines.filter((line): line is string => line !== undefined).join("\n");
}

function assertSafeRelativePath(repoRoot: string, file: string): string {
	const resolved = resolve(repoRoot, file);
	const rootWithSeparator = repoRoot.endsWith(sep) ? repoRoot : `${repoRoot}${sep}`;
	if (resolved !== repoRoot && !resolved.startsWith(rootWithSeparator)) throw new Error(`Refusing to remove path outside repository: ${file}`);
	return resolved;
}

function removeUntrackedFiles(repoRoot: string, files: string[]): void {
	for (const file of files) {
		rmSync(assertSafeRelativePath(repoRoot, file), { recursive: true, force: true });
	}
}

export async function createCheckpoint(runner: ExecRunner, cwd: string, label?: string): Promise<CheckpointOperationResult & { status: "created"; checkpoint: CheckpointRecord }> {
	const repoRoot = await resolveRepoRoot(runner, cwd);
	const headSha = await readCurrentHead(runner, repoRoot);
	const branch = await readCurrentBranch(runner, repoRoot);
	const untrackedFiles = await readUntrackedFiles(runner, repoRoot);
	const [statusShort, dirtySummary, patch] = await Promise.all([
		readStatusShort(runner, repoRoot),
		readDirtySummary(runner, repoRoot, untrackedFiles),
		readDirtyPatch(runner, repoRoot),
	]);
	const id = createCheckpointId();
	const patchFile = checkpointPatchFile(id);
	const record: CheckpointRecord = {
		schemaVersion: CHECKPOINT_SCHEMA_VERSION,
		id,
		label: label?.trim() || undefined,
		createdAt: new Date().toISOString(),
		repoRoot,
		headSha,
		branch,
		statusShort,
		dirtySummary,
		patchFile,
		patchBytes: Buffer.byteLength(patch, "utf8"),
		untrackedFiles,
	};
	appendCheckpointRecord(repoRoot, record, patch);
	return { status: "created", checkpoint: record, report: formatCreatedCheckpoint(record) };
}

export async function listCheckpoints(runner: ExecRunner, cwd: string): Promise<CheckpointOperationResult & { status: "listed"; checkpoints: CheckpointRecord[] }> {
	const repoRoot = await resolveRepoRoot(runner, cwd);
	const checkpoints = readCheckpointRecords(repoRoot);
	return { status: "listed", checkpoints, report: formatCheckpointList(checkpoints) };
}

export async function rollbackCheckpoint(
	runner: ExecRunner,
	cwd: string,
	options: { id?: string; confirm?: boolean; force?: boolean },
): Promise<CheckpointOperationResult & { status: "preview" | "rolled-back" | "refused" }> {
	const repoRoot = await resolveRepoRoot(runner, cwd);
	const selected = selectCheckpoint(readCheckpointRecords(repoRoot), options.id ?? "last");
	if (!selected.checkpoint) throw new Error(selected.error ?? "Checkpoint not found");

	const checkpoint = selected.checkpoint;
	const currentHead = await readCurrentHead(runner, repoRoot);
	const currentUntracked = await readUntrackedFiles(runner, repoRoot);
	const untrackedToRemove = newUntrackedFiles(checkpoint, currentUntracked);
	const confirm = Boolean(options.confirm);
	const force = Boolean(options.force);
	const unsafeReasons: string[] = [];

	if (currentHead !== checkpoint.headSha && !force) {
		unsafeReasons.push("Current HEAD differs from the checkpoint HEAD; rerun with --force only after reviewing the preview.");
	}
	if (untrackedToRemove.length > 0 && !force) {
		unsafeReasons.push("Rollback would remove newly-created untracked files; rerun with --force to remove only the listed files.");
	}

	const preview = formatRollbackReport({ checkpoint, currentHead, currentUntracked, newUntracked: untrackedToRemove, confirm, force, unsafeReasons });
	if (!confirm) return { status: "preview", checkpoint, report: preview };
	if (unsafeReasons.length > 0) return { status: "refused", checkpoint, report: preview };

	if (untrackedToRemove.length > 0) removeUntrackedFiles(repoRoot, untrackedToRemove);
	await runGit(runner, repoRoot, ["restore", "--source=HEAD", "--staged", "--worktree", "."], "Failed to restore tracked files before rollback");
	if (checkpoint.patchBytes > 0) {
		await runGit(runner, repoRoot, ["apply", "--whitespace=nowarn", join(repoRoot, checkpoint.patchFile)], "Failed to apply checkpoint patch");
	}

	const report = formatRollbackReport({
		checkpoint,
		currentHead,
		currentUntracked,
		newUntracked: untrackedToRemove,
		confirm,
		force,
		unsafeReasons: [],
		completed: true,
	});
	return { status: "rolled-back", checkpoint, report };
}

function usageText(): string {
	return [
		"Usage:",
		"  /checkpoint create [label]",
		"  /checkpoint list",
		"  /checkpoint preview [id|last]",
		"  /checkpoint rollback [id|last] [--confirm] [--force]",
		"",
		"Rollback previews by default. It changes files only when --confirm is present.",
		"Newly-created untracked files are removed only when --force is also present.",
	].join("\n");
}

async function executeAction(runner: ExecRunner, cwd: string, parsed: ParsedCheckpointArgs): Promise<CheckpointOperationResult> {
	if (parsed.error) return { status: "refused", report: `${parsed.error}\n\n${usageText()}` };
	switch (parsed.action) {
		case "create":
			return await createCheckpoint(runner, cwd, parsed.label);
		case "list":
			return await listCheckpoints(runner, cwd);
		case "preview":
			return await rollbackCheckpoint(runner, cwd, { id: parsed.id, confirm: false, force: parsed.force });
		case "rollback":
			return await rollbackCheckpoint(runner, cwd, { id: parsed.id, confirm: parsed.confirm, force: parsed.force });
		case "help":
		default:
			return { status: "listed", report: usageText() };
	}
}

type CheckpointCommandContext = {
	cwd: string;
	hasUI?: boolean;
	waitForIdle?: () => Promise<void>;
	ui: {
		notify(message: string, level: "info" | "warning" | "error"): void;
		setEditorText(text: string): void;
	};
};

function notifyForResult(ctx: CheckpointCommandContext, result: CheckpointOperationResult): void {
	if (result.status === "created") ctx.ui.notify("Checkpoint created", "info");
	else if (result.status === "rolled-back") ctx.ui.notify("Rollback complete", "info");
	else if (result.status === "refused") ctx.ui.notify("Checkpoint action refused", "warning");
	else if (result.status === "preview") ctx.ui.notify("Rollback preview only", "warning");
	else ctx.ui.notify("Checkpoint list updated", "info");
}

export default function checkpointRollbackExtension(pi: ExtensionAPI) {
	pi.registerCommand("checkpoint", {
		description: "Create, list, preview, and explicitly roll back git checkpoints",
		handler: async (args: string, ctx: CheckpointCommandContext) => {
			try {
				await ctx.waitForIdle?.();
				const result = await executeAction(pi, ctx.cwd, parseCheckpointArgs(args ?? ""));
				ctx.ui.setEditorText(result.report);
				notifyForResult(ctx, result);
			} catch (error) {
				ctx.ui.setEditorText(error instanceof Error ? error.message : String(error));
				ctx.ui.notify("Checkpoint action failed", "error");
			}
		},
	});

	pi.registerTool({
		name: "checkpoint_rollback",
		label: "Checkpoint Rollback",
		description: "Create/list human-controlled git checkpoints and preview or confirm rollback. Rollback changes files only when confirm is true.",
		parameters: Type.Object({
			action: StringEnum(CHECKPOINT_ACTIONS, { description: "Checkpoint action: create, list, preview, or rollback." }),
			id: Type.Optional(Type.String({ description: "Checkpoint id or prefix. Defaults to last for preview/rollback." })),
			label: Type.Optional(Type.String({ description: "Optional checkpoint label for action=create." })),
			confirm: Type.Optional(Type.Boolean({ description: "Required true for action=rollback to modify files." })),
			force: Type.Optional(Type.Boolean({ description: "Allow rollback across HEAD mismatch or remove newly-created untracked files after confirmation." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const parsed: ParsedCheckpointArgs = {
				action: params.action as CheckpointAction,
				id: typeof params.id === "string" ? params.id : undefined,
				label: typeof params.label === "string" ? params.label : undefined,
				confirm: Boolean(params.confirm),
				force: Boolean(params.force),
			};
			const result = await executeAction(pi, ctx.cwd, parsed);
			return {
				content: [{ type: "text" as const, text: result.report }],
				details: result,
			};
		},
	});
}
