export const PRODUCT_STAGES = [
	{ id: "plan", label: "Plan" },
	{ id: "design", label: "Design" },
	{ id: "tasks", label: "Tasks" },
	{ id: "implement", label: "Implement" },
	{ id: "review", label: "Review" },
] as const;

export type ProductStageId = (typeof PRODUCT_STAGES)[number]["id"];

export type ProductApprovalTarget = "prd" | "design" | "tasks";

export type ProductApprovalDecision = "approved" | "rejected";

export interface ProductApprovalRecord {
	status: ProductApprovalDecision;
	note: string;
	by: string;
	at: string;
}

export type ProductApprovals = Partial<Record<ProductApprovalTarget, ProductApprovalRecord>>;

export type ProductStageStatus = "Draft" | "Needs Approval" | "Approved" | "In Progress" | "Blocked" | "Done";

export type ProductTaskView = "list" | "board";

export type TaskFileActionMode = "view" | "diff" | "edit";

export type ProductRunStatus = "idle" | "running" | "paused" | "blocked";

export type ProductRunControlAction = "continue" | "pause" | "request_changes";

export type ProductRunEventType = "task_start" | "task_done" | "task_blocked" | "checkpoint" | "info";

export interface ProductRunEvent {
	id: string;
	at: string;
	type: ProductRunEventType;
	message: string;
	taskId?: string;
}

export interface ProductRunCheckpoint {
	id: string;
	at: string;
	message: string;
	taskId?: string;
}

export interface ProductRunState {
	status: ProductRunStatus;
	timeline: ProductRunEvent[];
	activeTaskId?: string;
	blockedReason?: string;
	pendingCheckpoint?: ProductRunCheckpoint;
}

export interface ProductShellState {
	featureName: string;
	currentStage: ProductStageId;
	approvals: ProductApprovals;
	taskView: ProductTaskView;
	run: ProductRunState;
	selectedTaskId?: string;
	selectedReviewPath?: string;
	blockedStage?: ProductStageId;
	lastBlockedReason?: string;
}

export const DEFAULT_STAGE_ID: ProductStageId = PRODUCT_STAGES[0].id;

export const DEFAULT_FEATURE_NAME = "product-agent-ui";

export function createDefaultProductRunState(): ProductRunState {
	return {
		status: "idle",
		timeline: [],
	};
}

export function createDefaultProductShellState(featureName = DEFAULT_FEATURE_NAME): ProductShellState {
	return {
		featureName,
		currentStage: DEFAULT_STAGE_ID,
		approvals: {},
		taskView: "list",
		run: createDefaultProductRunState(),
	};
}
