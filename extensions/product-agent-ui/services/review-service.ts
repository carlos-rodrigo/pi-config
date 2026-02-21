import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import type { ProductApprovalRecord, ProductApprovals, TaskFileActionMode } from "../types.js";
import type { ProductAgentPolicy } from "./policy-service.js";
import type { ProductTaskListResult } from "./task-service.js";

const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;

export type ReviewFileStatus = "A" | "M" | "D";

export interface ProductReviewFileItem {
	path: string;
	status: ReviewFileStatus;
}

export type ReviewChecklistStatus = "pass" | "warn" | "fail" | "manual";

export interface ProductReviewChecklistItem {
	id: string;
	label: string;
	status: ReviewChecklistStatus;
	detail: string;
}

export interface ProductReviewFileLoadResult {
	files: ProductReviewFileItem[];
	warning?: string;
}

export interface ProductReviewData {
	files: ProductReviewFileItem[];
	checklist: ProductReviewChecklistItem[];
	warning?: string;
}

export type ReviewFileActionValidationResult =
	| {
			ok: true;
			path: string;
	  }
	| {
			ok: false;
			reason: string;
			stale: boolean;
	  };

const REVIEW_FILE_ORDER: ReviewFileStatus[] = ["A", "M", "D"];
const REVIEW_FILE_ORDER_INDEX: Record<ReviewFileStatus, number> = REVIEW_FILE_ORDER.reduce(
	(accumulator, status, index) => {
		accumulator[status] = index;
		return accumulator;
	},
	{} as Record<ReviewFileStatus, number>,
);

export async function loadProductReviewFiles(options: {
	projectRoot: string;
}): Promise<ProductReviewFileLoadResult> {
	return loadReviewChangeSet(options.projectRoot);
}

export async function loadProductReviewData(options: {
	projectRoot: string;
	policy: ProductAgentPolicy;
	approvals: ProductApprovals;
	taskList: ProductTaskListResult;
}): Promise<ProductReviewData> {
	const filesResult = await loadProductReviewFiles({
		projectRoot: options.projectRoot,
	});
	return {
		files: filesResult.files,
		warning: filesResult.warning,
		checklist: buildPreShipChecklist({
			policy: options.policy,
			approvals: options.approvals,
			taskList: options.taskList,
		}),
	};
}

export function buildPreShipChecklist(options: {
	policy: ProductAgentPolicy;
	approvals: ProductApprovals;
	taskList: ProductTaskListResult;
}): ProductReviewChecklistItem[] {
	const { policy, approvals, taskList } = options;
	const checklist: ProductReviewChecklistItem[] = [];

	checklist.push(
		createApprovalChecklistItem({
			id: "plan-approval",
			label: "Plan approval",
			required: policy.gates.planApprovalRequired,
			approval: approvals.prd,
		}),
	);
	checklist.push(
		createApprovalChecklistItem({
			id: "design-approval",
			label: "Design approval",
			required: policy.gates.designApprovalRequired,
			approval: approvals.design,
		}),
	);
	checklist.push(
		createApprovalChecklistItem({
			id: "tasks-approval",
			label: "Tasks approval",
			required: policy.gates.tasksApprovalRequired,
			approval: approvals.tasks,
		}),
	);

	const remainingTasks = taskList.tasks.filter((task) => task.rawStatus !== "done").length;
	checklist.push({
		id: "task-completion",
		label: "All feature tasks complete",
		status: remainingTasks === 0 ? "pass" : "warn",
		detail:
			remainingTasks === 0
				? `${taskList.tasks.length} tasks are marked done.`
				: `${remainingTasks} task${remainingTasks === 1 ? " is" : "s are"} not done yet.`,
	});

	if (taskList.warning) {
		checklist.push({
			id: "task-list-health",
			label: "Task metadata health",
			status: "warn",
			detail: "Task list warnings are present. Review warnings before shipping.",
		});
	}

	checklist.push({
		id: "typecheck",
		label: "Typecheck",
		status: "manual",
		detail: "Run `npm run typecheck` before shipping.",
	});

	return checklist;
}

export async function validateReviewFileAction(options: {
	projectRoot: string;
	path: string;
	expectedStatus: ReviewFileStatus;
	mode: TaskFileActionMode;
}): Promise<ReviewFileActionValidationResult> {
	const normalizedPath = sanitizeDisplayText(options.path);
	if (!normalizedPath || normalizedPath !== options.path) {
		return {
			ok: false,
			stale: false,
			reason: "Selected review path contains unsupported characters.",
		};
	}

	if (!isSafeRelativePath(normalizedPath)) {
		return {
			ok: false,
			stale: false,
			reason: "Selected review path is outside the project or includes unsupported characters.",
		};
	}

	const latest = await loadReviewChangeSet(options.projectRoot);
	const latestFile = latest.files.find((file) => file.path === normalizedPath);
	if (!latestFile) {
		return {
			ok: false,
			stale: true,
			reason: "Selected file is no longer in git changes. Refresh the review panel.",
		};
	}

	if (latestFile.status !== options.expectedStatus) {
		return {
			ok: false,
			stale: true,
			reason: `Selected file status changed from ${options.expectedStatus} to ${latestFile.status}. Refresh the review panel.`,
		};
	}

	if (latestFile.status === "D") {
		return {
			ok: false,
			stale: true,
			reason: `Selected file is marked deleted and cannot be opened in ${options.mode} mode. Refresh the review panel.`,
		};
	}

	const absoluteProjectRoot = path.resolve(options.projectRoot);
	const absoluteCandidate = path.resolve(absoluteProjectRoot, normalizedPath);
	if (!isPathWithinRoot(absoluteProjectRoot, absoluteCandidate)) {
		return {
			ok: false,
			stale: false,
			reason: "Selected review file resolves outside the project root.",
		};
	}

	let projectRootRealPath: string;
	let candidateRealPath: string;
	try {
		projectRootRealPath = await realpath(absoluteProjectRoot);
		candidateRealPath = await realpath(absoluteCandidate);
	} catch (error) {
		return {
			ok: false,
			stale: true,
			reason: `Selected file no longer exists on disk. Refresh the review panel. (${toErrorMessage(error)})`,
		};
	}

	if (!isPathWithinRoot(projectRootRealPath, candidateRealPath)) {
		return {
			ok: false,
			stale: false,
			reason: "Selected review file resolved outside the project root.",
		};
	}

	try {
		await access(candidateRealPath, constants.R_OK);
	} catch (error) {
		return {
			ok: false,
			stale: true,
			reason: `Selected file cannot be read. Refresh the review panel. (${toErrorMessage(error)})`,
		};
	}

	return {
		ok: true,
		path: normalizedPath,
	};
}

async function loadReviewChangeSet(projectRoot: string): Promise<{
	files: ProductReviewFileItem[];
	warning?: string;
}> {
	const warnings: string[] = [];
	const absoluteProjectRoot = path.resolve(projectRoot);
	let projectRootRealPath: string;
	try {
		projectRootRealPath = await realpath(absoluteProjectRoot);
	} catch (error) {
		return {
			files: [],
			warning: `Could not resolve project root for review panel: ${toErrorMessage(error)}`,
		};
	}

	const gitRootResult = await runGitCommand(absoluteProjectRoot, ["rev-parse", "--show-toplevel"]);
	if (!gitRootResult.ok) {
		return {
			files: [],
			warning: `Could not determine git root for review panel: ${gitRootResult.error}`,
		};
	}

	const gitRootPath = gitRootResult.stdout.trim();
	if (!gitRootPath) {
		return {
			files: [],
			warning: "Could not determine git root for review panel.",
		};
	}

	let gitRootRealPath: string;
	try {
		gitRootRealPath = await realpath(gitRootPath);
	} catch (error) {
		return {
			files: [],
			warning: `Could not resolve git root for review panel: ${toErrorMessage(error)}`,
		};
	}

	if (!isPathWithinRoot(gitRootRealPath, projectRootRealPath)) {
		warnings.push("Project root is outside the detected git repository root.");
	}

	const statusByPath = new Map<string, ReviewFileStatus>();

	const [cachedDiffResult, workingDiffResult, untrackedResult] = await Promise.all([
		runGitCommand(gitRootRealPath, ["diff", "--name-status", "--diff-filter=AMD", "--cached", "--", "."]),
		runGitCommand(gitRootRealPath, ["diff", "--name-status", "--diff-filter=AMD", "--", "."]),
		runGitCommand(gitRootRealPath, ["ls-files", "--others", "--exclude-standard", "--", "."]),
	]);

	if (cachedDiffResult.ok) {
		mergeNameStatusOutput({
			output: cachedDiffResult.stdout,
			statusByPath,
			gitRootRealPath,
			projectRootRealPath,
			warnings,
		});
	} else {
		warnings.push(`Could not read staged git changes: ${cachedDiffResult.error}`);
	}

	if (workingDiffResult.ok) {
		mergeNameStatusOutput({
			output: workingDiffResult.stdout,
			statusByPath,
			gitRootRealPath,
			projectRootRealPath,
			warnings,
		});
	} else {
		warnings.push(`Could not read working-tree git changes: ${workingDiffResult.error}`);
	}

	if (untrackedResult.ok) {
		mergeUntrackedOutput({
			output: untrackedResult.stdout,
			statusByPath,
			gitRootRealPath,
			projectRootRealPath,
			warnings,
		});
	} else {
		warnings.push(`Could not read untracked git changes: ${untrackedResult.error}`);
	}

	const files = Array.from(statusByPath.entries())
		.map(([filePath, status]) => ({ path: filePath, status }))
		.sort(compareReviewFiles);

	return {
		files,
		warning: warnings.length > 0 ? warnings.join(" | ") : undefined,
	};
}

function mergeNameStatusOutput(options: {
	output: string;
	statusByPath: Map<string, ReviewFileStatus>;
	gitRootRealPath: string;
	projectRootRealPath: string;
	warnings: string[];
}): void {
	const { output, statusByPath, gitRootRealPath, projectRootRealPath, warnings } = options;

	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;

		const parts = line.split("\t");
		if (parts.length < 2) {
			warnings.push(`Could not parse git name-status line: ${line}`);
			continue;
		}

		const status = parseReviewStatus(parts[0]);
		if (!status) {
			continue;
		}

		const rawPath = parts[parts.length - 1];
		if (!rawPath || rawPath.trim().length === 0) {
			warnings.push(`Missing file path in git name-status line: ${line}`);
			continue;
		}

		const projectRelativePath = toProjectRelativePath({
			projectRootRealPath,
			gitRootRealPath,
			rawPath,
		});
		if (!projectRelativePath) {
			continue;
		}

		if (!isSafeRelativePath(projectRelativePath)) {
			warnings.push(`Skipping changed file with unsupported path for dispatch: ${projectRelativePath}`);
			continue;
		}

		statusByPath.set(projectRelativePath, mergeStatus(statusByPath.get(projectRelativePath), status));
	}
}

function mergeUntrackedOutput(options: {
	output: string;
	statusByPath: Map<string, ReviewFileStatus>;
	gitRootRealPath: string;
	projectRootRealPath: string;
	warnings: string[];
}): void {
	const { output, statusByPath, gitRootRealPath, projectRootRealPath, warnings } = options;
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;

		const projectRelativePath = toProjectRelativePath({
			projectRootRealPath,
			gitRootRealPath,
			rawPath: line,
		});
		if (!projectRelativePath) {
			continue;
		}

		if (!isSafeRelativePath(projectRelativePath)) {
			warnings.push(`Skipping untracked file with unsupported path for dispatch: ${projectRelativePath}`);
			continue;
		}

		statusByPath.set(projectRelativePath, mergeStatus(statusByPath.get(projectRelativePath), "A"));
	}
}

function parseReviewStatus(token: string): ReviewFileStatus | undefined {
	if (!token) return undefined;
	const normalized = token.trim().toUpperCase();
	if (normalized.startsWith("A")) return "A";
	if (normalized.startsWith("M")) return "M";
	if (normalized.startsWith("D")) return "D";
	return undefined;
}

function toProjectRelativePath(options: {
	projectRootRealPath: string;
	gitRootRealPath: string;
	rawPath: string;
}): string | undefined {
	const absolutePath = path.resolve(options.gitRootRealPath, options.rawPath);
	if (!isPathWithinRoot(options.projectRootRealPath, absolutePath)) {
		return undefined;
	}
	const relativePath = toPosixPath(path.relative(options.projectRootRealPath, absolutePath));
	return relativePath.length > 0 ? relativePath : undefined;
}

function createApprovalChecklistItem(options: {
	id: string;
	label: string;
	required: boolean;
	approval: ProductApprovalRecord | undefined;
}): ProductReviewChecklistItem {
	const { id, label, required, approval } = options;
	if (required) {
		if (approval?.status === "approved") {
			return {
				id,
				label,
				status: "pass",
				detail: `Approved by ${approval.by} at ${formatTimestamp(approval.at)}.`,
			};
		}

		if (approval?.status === "rejected") {
			return {
				id,
				label,
				status: "fail",
				detail: `Rejected by ${approval.by} at ${formatTimestamp(approval.at)}.`,
			};
		}

		return {
			id,
			label,
			status: "fail",
			detail: "Required approval is missing.",
		};
	}

	if (approval?.status === "approved") {
		return {
			id,
			label,
			status: "pass",
			detail: `Optional approval recorded by ${approval.by}.`,
		};
	}

	if (approval?.status === "rejected") {
		return {
			id,
			label,
			status: "warn",
			detail: `Optional approval was rejected by ${approval.by}.`,
		};
	}

	return {
		id,
		label,
		status: "manual",
		detail: "Not required by current policy.",
	};
}

function mergeStatus(existing: ReviewFileStatus | undefined, incoming: ReviewFileStatus): ReviewFileStatus {
	if (!existing) return incoming;
	const rank = { M: 1, A: 2, D: 3 } satisfies Record<ReviewFileStatus, number>;
	return rank[incoming] > rank[existing] ? incoming : existing;
}

function compareReviewFiles(left: ProductReviewFileItem, right: ProductReviewFileItem): number {
	const statusComparison = REVIEW_FILE_ORDER_INDEX[left.status] - REVIEW_FILE_ORDER_INDEX[right.status];
	if (statusComparison !== 0) {
		return statusComparison;
	}
	return left.path.localeCompare(right.path);
}

async function runGitCommand(cwd: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
	return new Promise((resolve) => {
		execFile(
			"git",
			args,
			{
				cwd,
				encoding: "utf8",
				maxBuffer: MAX_GIT_OUTPUT_BYTES,
			},
			(error, stdout, stderr) => {
				if (error) {
					const failureOutput = typeof stderr === "string" && stderr.trim().length > 0 ? stderr : error.message;
					resolve({ ok: false, error: failureOutput.trim() });
					return;
				}

				resolve({
					ok: true,
					stdout: typeof stdout === "string" ? stdout : String(stdout ?? ""),
				});
			},
		);
	});
}

function formatTimestamp(value: string): string {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		return value;
	}
	return parsed.toISOString().replace("T", " ").slice(0, 16);
}

function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
	const relativePath = path.relative(rootPath, candidatePath);
	if (relativePath.length === 0) return true;
	return !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function sanitizeDisplayText(value: string): string {
	return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
}

function isSafeRelativePath(value: string): boolean {
	if (!value) return false;
	if (value.startsWith("/") || value.startsWith("\\") || value.includes("..")) {
		return false;
	}
	if (value.includes("--")) {
		return false;
	}
	return /^[a-zA-Z0-9._/-]+$/.test(value);
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function toPosixPath(value: string): string {
	return value.split(path.sep).join("/");
}
