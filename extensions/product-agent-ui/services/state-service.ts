import {
	createDefaultProductShellState,
	type ProductApprovalDecision,
	type ProductApprovalRecord,
	type ProductApprovals,
	type ProductShellState,
	type ProductStageId,
	type ProductTaskView,
} from "../types.js";

export const PRODUCT_AGENT_STATE_ENTRY_TYPE = "product-agent-state";
export const PRODUCT_AGENT_STATE_VERSION = 1;

export interface ProductAgentStateSnapshot {
	version: 1;
	featureName: string;
	currentStage: ProductStageId;
	approvals: ProductApprovals;
	taskView: ProductTaskView;
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
		updatedAt,
	};

	if (state.blockedStage) {
		snapshot.blockedStage = state.blockedStage;
	}

	if (state.lastBlockedReason) {
		snapshot.lastBlockedReason = state.lastBlockedReason;
	}

	return snapshot;
}

export function restoreWorkflowStateFromEntries(
	entries: readonly SessionEntryLike[],
	featureName: string,
): ProductShellState | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isStateEntry(entry)) continue;

		const snapshot = parseSnapshot(entry.data);
		if (!snapshot || snapshot.featureName !== featureName) continue;

		const restored = createDefaultProductShellState(featureName);
		restored.currentStage = snapshot.currentStage;
		restored.approvals = cloneApprovals(snapshot.approvals);
		restored.taskView = snapshot.taskView;
		restored.blockedStage = snapshot.blockedStage;
		restored.lastBlockedReason = snapshot.lastBlockedReason;
		return restored;
	}

	return undefined;
}

function isStateEntry(entry: SessionEntryLike): boolean {
	return entry.type === "custom" && entry.customType === PRODUCT_AGENT_STATE_ENTRY_TYPE;
}

function parseSnapshot(data: unknown): ProductAgentStateSnapshot | undefined {
	if (!isRecord(data)) return undefined;
	if (data.version !== PRODUCT_AGENT_STATE_VERSION) return undefined;
	if (typeof data.featureName !== "string" || data.featureName.length === 0) return undefined;
	if (!isStageId(data.currentStage)) return undefined;
	if (typeof data.updatedAt !== "string") return undefined;

	const approvals = parseApprovals(data.approvals);
	if (!approvals) return undefined;

	const taskView = data.taskView === undefined ? "list" : data.taskView;
	if (!isTaskView(taskView)) return undefined;

	const snapshot: ProductAgentStateSnapshot = {
		version: PRODUCT_AGENT_STATE_VERSION,
		featureName: data.featureName,
		currentStage: data.currentStage,
		approvals,
		taskView,
		updatedAt: data.updatedAt,
	};

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
