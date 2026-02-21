import {
	createDefaultProductRunState,
	createDefaultProductShellState,
	type ProductApprovalDecision,
	type ProductApprovalRecord,
	type ProductApprovals,
	type ProductRunCheckpoint,
	type ProductRunEvent,
	type ProductRunEventType,
	type ProductRunState,
	type ProductRunStatus,
	type ProductShellState,
	type ProductStageId,
	type ProductTaskView,
} from "../types.js";

export const PRODUCT_AGENT_STATE_ENTRY_TYPE = "product-agent-state";
export const PRODUCT_AGENT_STATE_VERSION = 1;

const MAX_RESTORED_TIMELINE_EVENTS = 160;

export interface ProductAgentStateSnapshot {
	version: 1;
	featureName: string;
	currentStage: ProductStageId;
	approvals: ProductApprovals;
	taskView: ProductTaskView;
	selectedReviewPath?: string;
	runState: ProductRunState;
	blockedStage?: ProductStageId;
	lastBlockedReason?: string;
	updatedAt: string;
}

interface SessionEntryLike {
	type: string;
	customType?: unknown;
	data?: unknown;
}

export function createWorkflowStateSnapshot(
	state: ProductShellState,
	updatedAt = new Date().toISOString(),
): ProductAgentStateSnapshot {
	const snapshot: ProductAgentStateSnapshot = {
		version: PRODUCT_AGENT_STATE_VERSION,
		featureName: state.featureName,
		currentStage: state.currentStage,
		approvals: cloneApprovals(state.approvals),
		taskView: state.taskView,
		runState: cloneRunState(state.run),
		updatedAt,
	};

	if (state.selectedReviewPath) {
		snapshot.selectedReviewPath = state.selectedReviewPath;
	}

	if (state.blockedStage) {
		snapshot.blockedStage = state.blockedStage;
	}

	if (state.lastBlockedReason) {
		snapshot.lastBlockedReason = state.lastBlockedReason;
	}

	return snapshot;
}

export interface RestoreWorkflowStateResult {
	state?: ProductShellState;
	featureName?: string;
	warnings: string[];
}

export function restoreWorkflowStateFromEntries(
	entries: readonly SessionEntryLike[],
	featureName?: string,
): ProductShellState | undefined {
	return restoreWorkflowStateFromEntriesWithWarnings(entries, featureName).state;
}

export function restoreWorkflowStateFromEntriesWithWarnings(
	entries: readonly SessionEntryLike[],
	featureName?: string,
): RestoreWorkflowStateResult {
	const warnings: string[] = [];
	const targetFeatureName = featureName ?? findLatestWorkflowFeatureName(entries);
	if (!targetFeatureName) {
		return { warnings };
	}

	if (!isValidFeatureName(targetFeatureName)) {
		warnings.push(`Ignoring invalid feature name in restore request: ${sanitizeDisplayText(targetFeatureName)}.`);
		return {
			featureName: targetFeatureName,
			warnings,
		};
	}

	const restored = createDefaultProductShellState(targetFeatureName);
	let matchedSnapshot = false;

	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (!isStateEntry(entry)) continue;

		const snapshot = parseSnapshot(entry.data);
		if (!snapshot) {
			warnings.push(`Ignored malformed ${PRODUCT_AGENT_STATE_ENTRY_TYPE} entry at index ${index}.`);
			continue;
		}
		if (snapshot.featureName !== targetFeatureName) continue;

		matchedSnapshot = true;
		applySnapshotOverlay(restored, snapshot);
	}

	if (!matchedSnapshot) {
		return {
			featureName: targetFeatureName,
			warnings,
		};
	}

	if (restored.run.timeline.length > MAX_RESTORED_TIMELINE_EVENTS) {
		restored.run.timeline = restored.run.timeline.slice(-MAX_RESTORED_TIMELINE_EVENTS);
	}

	return {
		state: restored,
		featureName: targetFeatureName,
		warnings,
	};
}

function applySnapshotOverlay(
	restored: ProductShellState,
	snapshot: ProductAgentStateSnapshot,
): void {
	restored.currentStage = snapshot.currentStage;
	restored.approvals = cloneApprovals(snapshot.approvals);
	restored.taskView = snapshot.taskView;

	if (snapshot.selectedReviewPath) {
		restored.selectedReviewPath = snapshot.selectedReviewPath;
	} else {
		delete restored.selectedReviewPath;
	}

	if (snapshot.blockedStage) {
		restored.blockedStage = snapshot.blockedStage;
	} else {
		delete restored.blockedStage;
	}

	if (snapshot.lastBlockedReason) {
		restored.lastBlockedReason = snapshot.lastBlockedReason;
	} else {
		delete restored.lastBlockedReason;
	}

	const runState = cloneRunState(snapshot.runState);
	const timeline = [...restored.run.timeline];
	const eventIndexById = new Map<string, number>();
	for (let index = 0; index < timeline.length; index += 1) {
		eventIndexById.set(timeline[index].id, index);
	}

	for (const event of runState.timeline) {
		const existingIndex = eventIndexById.get(event.id);
		if (existingIndex === undefined) {
			eventIndexById.set(event.id, timeline.length);
			timeline.push(event);
			continue;
		}

		timeline[existingIndex] = event;
	}

	restored.run = {
		status: runState.status,
		timeline,
	};

	if (runState.activeTaskId) {
		restored.run.activeTaskId = runState.activeTaskId;
	}

	if (runState.blockedReason) {
		restored.run.blockedReason = runState.blockedReason;
	}

	if (runState.pendingCheckpoint) {
		restored.run.pendingCheckpoint = runState.pendingCheckpoint;
	}
}

export function findLatestWorkflowFeatureName(entries: readonly SessionEntryLike[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isStateEntry(entry)) continue;

		const snapshot = parseSnapshot(entry.data);
		if (!snapshot) continue;
		return snapshot.featureName;
	}

	return undefined;
}

function isStateEntry(entry: SessionEntryLike): boolean {
	return entry.type === "custom" && entry.customType === PRODUCT_AGENT_STATE_ENTRY_TYPE;
}

function parseSnapshot(data: unknown): ProductAgentStateSnapshot | undefined {
	if (!isRecord(data)) return undefined;
	if (data.version !== PRODUCT_AGENT_STATE_VERSION) return undefined;
	if (typeof data.featureName !== "string" || !isValidFeatureName(data.featureName)) return undefined;
	if (!isStageId(data.currentStage)) return undefined;
	if (typeof data.updatedAt !== "string") return undefined;

	const approvals = parseApprovals(data.approvals);
	if (!approvals) return undefined;

	const taskView = data.taskView === undefined ? "list" : data.taskView;
	if (!isTaskView(taskView)) return undefined;

	const runState = data.runState === undefined ? createDefaultProductRunState() : parseRunState(data.runState);
	if (!runState) return undefined;

	const snapshot: ProductAgentStateSnapshot = {
		version: PRODUCT_AGENT_STATE_VERSION,
		featureName: data.featureName,
		currentStage: data.currentStage,
		approvals,
		taskView,
		runState,
		updatedAt: data.updatedAt,
	};

	if (data.selectedReviewPath !== undefined) {
		if (typeof data.selectedReviewPath !== "string") return undefined;
		snapshot.selectedReviewPath = data.selectedReviewPath;
	}

	if (data.blockedStage !== undefined) {
		if (!isStageId(data.blockedStage)) return undefined;
		snapshot.blockedStage = data.blockedStage;
	}

	if (data.lastBlockedReason !== undefined) {
		if (typeof data.lastBlockedReason !== "string") return undefined;
		snapshot.lastBlockedReason = data.lastBlockedReason;
	}

	return snapshot;
}

function parseApprovals(value: unknown): ProductApprovals | undefined {
	if (!isRecord(value)) return undefined;

	const approvals: ProductApprovals = {};
	for (const key of ["prd", "design", "tasks"] as const) {
		const rawRecord = value[key];
		if (rawRecord === undefined) continue;

		const parsed = parseApprovalRecord(rawRecord);
		if (!parsed) return undefined;

		approvals[key] = parsed;
	}

	return approvals;
}

function parseApprovalRecord(value: unknown): ProductApprovalRecord | undefined {
	if (!isRecord(value)) return undefined;
	if (!isApprovalDecision(value.status)) return undefined;
	if (typeof value.note !== "string") return undefined;
	if (typeof value.by !== "string") return undefined;
	if (typeof value.at !== "string") return undefined;

	return {
		status: value.status,
		note: value.note,
		by: value.by,
		at: value.at,
	};
}

function parseRunState(value: unknown): ProductRunState | undefined {
	if (!isRecord(value)) return undefined;
	if (!isRunStatus(value.status)) return undefined;
	if (!Array.isArray(value.timeline)) return undefined;

	const timeline: ProductRunEvent[] = [];
	for (const rawEvent of value.timeline) {
		const parsedEvent = parseRunEvent(rawEvent);
		if (!parsedEvent) return undefined;
		timeline.push(parsedEvent);
	}

	const runState: ProductRunState = {
		status: value.status,
		timeline,
	};

	if (value.activeTaskId !== undefined) {
		if (typeof value.activeTaskId !== "string") return undefined;
		runState.activeTaskId = value.activeTaskId;
	}

	if (value.blockedReason !== undefined) {
		if (typeof value.blockedReason !== "string") return undefined;
		runState.blockedReason = value.blockedReason;
	}

	if (value.pendingCheckpoint !== undefined) {
		const checkpoint = parseRunCheckpoint(value.pendingCheckpoint);
		if (!checkpoint) return undefined;
		runState.pendingCheckpoint = checkpoint;
	}

	return runState;
}

function parseRunEvent(value: unknown): ProductRunEvent | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.id !== "string" || value.id.length === 0) return undefined;
	if (typeof value.at !== "string" || value.at.length === 0) return undefined;
	if (!isRunEventType(value.type)) return undefined;
	if (typeof value.message !== "string") return undefined;
	if (value.taskId !== undefined && typeof value.taskId !== "string") return undefined;

	return {
		id: value.id,
		at: value.at,
		type: value.type,
		message: value.message,
		taskId: value.taskId,
	};
}

function parseRunCheckpoint(value: unknown): ProductRunCheckpoint | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.id !== "string" || value.id.length === 0) return undefined;
	if (typeof value.at !== "string" || value.at.length === 0) return undefined;
	if (typeof value.message !== "string") return undefined;
	if (value.taskId !== undefined && typeof value.taskId !== "string") return undefined;

	return {
		id: value.id,
		at: value.at,
		message: value.message,
		taskId: value.taskId,
	};
}

function cloneApprovals(approvals: ProductApprovals): ProductApprovals {
	const cloned: ProductApprovals = {};
	for (const key of ["prd", "design", "tasks"] as const) {
		const record = approvals[key];
		if (!record) continue;
		cloned[key] = {
			status: record.status,
			note: record.note,
			by: record.by,
			at: record.at,
		};
	}
	return cloned;
}

function cloneRunState(runState: ProductRunState): ProductRunState {
	const cloned: ProductRunState = {
		status: runState.status,
		timeline: runState.timeline.map((event) => ({
			id: event.id,
			at: event.at,
			type: event.type,
			message: event.message,
			taskId: event.taskId,
		})),
	};

	if (runState.activeTaskId) {
		cloned.activeTaskId = runState.activeTaskId;
	}

	if (runState.blockedReason) {
		cloned.blockedReason = runState.blockedReason;
	}

	if (runState.pendingCheckpoint) {
		cloned.pendingCheckpoint = {
			id: runState.pendingCheckpoint.id,
			at: runState.pendingCheckpoint.at,
			message: runState.pendingCheckpoint.message,
			taskId: runState.pendingCheckpoint.taskId,
		};
	}

	return cloned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isApprovalDecision(value: unknown): value is ProductApprovalDecision {
	return value === "approved" || value === "rejected";
}

function isStageId(value: unknown): value is ProductStageId {
	return value === "plan" || value === "design" || value === "tasks" || value === "implement" || value === "review";
}

function isTaskView(value: unknown): value is ProductTaskView {
	return value === "list" || value === "board";
}

function isRunStatus(value: unknown): value is ProductRunStatus {
	return value === "idle" || value === "running" || value === "paused" || value === "blocked";
}

function isRunEventType(value: unknown): value is ProductRunEventType {
	return value === "task_start" || value === "task_done" || value === "task_blocked" || value === "checkpoint" || value === "info";
}

function isValidFeatureName(featureName: string): boolean {
	if (!featureName) return false;
	if (featureName.includes("/") || featureName.includes("\\") || featureName.includes("..")) {
		return false;
	}
	return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(featureName);
}

function sanitizeDisplayText(value: string): string {
	return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").trim();
}
