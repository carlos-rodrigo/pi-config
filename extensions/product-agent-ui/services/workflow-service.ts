import {
	PRODUCT_STAGES,
	type ProductApprovalDecision,
	type ProductApprovalRecord,
	type ProductApprovalTarget,
	type ProductApprovals,
	type ProductShellState,
	type ProductStageId,
	type ProductStageStatus,
} from "../types.js";
import type { ProductAgentPolicy } from "./policy-service.js";

const APPROVAL_TARGET_BY_STAGE: Partial<Record<ProductStageId, ProductApprovalTarget>> = {
	plan: "prd",
	design: "design",
	tasks: "tasks",
};

interface TransitionGate {
	enteringStage: ProductStageId;
	requiredApproval: ProductApprovalTarget;
	isRequired: (policy: ProductAgentPolicy) => boolean;
	label: string;
}

const TRANSITION_GATES: TransitionGate[] = [
	{
		enteringStage: "design",
		requiredApproval: "prd",
		isRequired: (policy) => policy.gates.planApprovalRequired,
		label: "PRD approval",
	},
	{
		enteringStage: "tasks",
		requiredApproval: "design",
		isRequired: (policy) => policy.gates.designApprovalRequired,
		label: "Design approval",
	},
	{
		enteringStage: "implement",
		requiredApproval: "tasks",
		isRequired: (policy) => policy.gates.tasksApprovalRequired,
		label: "Tasks approval",
	},
];

export interface StageTransitionResult {
	allowed: boolean;
	reason?: string;
	blockedStage?: ProductStageId;
}

export interface ApprovalUpdateResult {
	updated: boolean;
	state: ProductShellState;
	reason?: string;
	target?: ProductApprovalTarget;
}

export function canTransition(params: {
	currentStage: ProductStageId;
	nextStage: ProductStageId;
	policy: ProductAgentPolicy;
	approvals: ProductApprovals;
}): StageTransitionResult {
	const { currentStage, nextStage, policy, approvals } = params;
	const currentIndex = getStageIndex(currentStage);
	const nextIndex = getStageIndex(nextStage);

	if (nextIndex <= currentIndex) {
		return { allowed: true };
	}

	for (const gate of TRANSITION_GATES) {
		if (!gate.isRequired(policy)) continue;

		const gateIndex = getStageIndex(gate.enteringStage);
		if (currentIndex < gateIndex && nextIndex >= gateIndex) {
			const approval = approvals[gate.requiredApproval];
			if (approval?.status !== "approved") {
				return {
					allowed: false,
					blockedStage: gate.enteringStage,
					reason: `${gate.label} is required before moving to ${getStageLabel(gate.enteringStage)}.`,
				};
			}
		}
	}

	return { allowed: true };
}

export function applyApprovalDecision(params: {
	state: ProductShellState;
	stage: ProductStageId;
	decision: ProductApprovalDecision;
	note: string;
	actor: string;
	at?: string;
}): ApprovalUpdateResult {
	const { state, stage, decision, note, actor } = params;
	const target = getApprovalTargetForStage(stage);
	if (!target) {
		return {
			updated: false,
			state,
			reason: `${getStageLabel(stage)} does not require explicit approval.`,
		};
	}

	const approvalRecord = createApprovalRecord({
		decision,
		note,
		actor,
		at: params.at,
	});

	return {
		updated: true,
		target,
		state: {
			...state,
			approvals: {
				...state.approvals,
				[target]: approvalRecord,
			},
			blockedStage: undefined,
			lastBlockedReason: undefined,
		},
	};
}

export function getApprovalTargetForStage(stage: ProductStageId): ProductApprovalTarget | undefined {
	return APPROVAL_TARGET_BY_STAGE[stage];
}

export function getStageStatus(params: {
	stage: ProductStageId;
	state: ProductShellState;
	policy: ProductAgentPolicy;
}): ProductStageStatus {
	const { stage, state, policy } = params;

	if (state.blockedStage === stage) {
		return "Blocked";
	}

	const stageIndex = getStageIndex(stage);
	const currentIndex = getStageIndex(state.currentStage);
	const approvalTarget = getApprovalTargetForStage(stage);
	const approvalRecord = approvalTarget ? state.approvals[approvalTarget] : undefined;
	const approvalRequired = approvalTarget ? isApprovalRequiredForStage(stage, policy) : false;

	if (currentIndex < stageIndex) {
		return "Draft";
	}

	if (currentIndex > stageIndex) {
		if (approvalTarget && approvalRequired && approvalRecord?.status !== "approved") {
			return "Blocked";
		}
		return "Done";
	}

	if (approvalTarget) {
		if (approvalRecord?.status === "approved") {
			return "Approved";
		}
		if (approvalRequired) {
			return "Needs Approval";
		}
	}

	return "In Progress";
}

export function getStageLabel(stageId: ProductStageId): string {
	return PRODUCT_STAGES.find((stage) => stage.id === stageId)?.label ?? stageId;
}

function createApprovalRecord(params: {
	decision: ProductApprovalDecision;
	note: string;
	actor: string;
	at?: string;
}): ProductApprovalRecord {
	return {
		status: params.decision,
		note: params.note,
		by: params.actor,
		at: params.at ?? new Date().toISOString(),
	};
}

function isApprovalRequiredForStage(stage: ProductStageId, policy: ProductAgentPolicy): boolean {
	switch (stage) {
		case "plan":
			return policy.gates.planApprovalRequired;
		case "design":
			return policy.gates.designApprovalRequired;
		case "tasks":
			return policy.gates.tasksApprovalRequired;
		default:
			return false;
	}
}

function getStageIndex(stageId: ProductStageId): number {
	const index = PRODUCT_STAGES.findIndex((stage) => stage.id === stageId);
	if (index >= 0) {
		return index;
	}
	return 0;
}
