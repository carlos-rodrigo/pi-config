import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import type { ProductAgentPolicy } from "../services/policy-service.js";
import { getStageStatus } from "../services/workflow-service.js";
import { PRODUCT_STAGES, type ProductShellState, type ProductStageId, type ProductStageStatus } from "../types.js";

export interface StageHeaderRenderParams {
	theme: Theme;
	width: number;
	state: ProductShellState;
	policy: ProductAgentPolicy;
}

export function renderStageHeader(params: StageHeaderRenderParams): string[] {
	const { theme, width, state, policy } = params;

	const stageLine = PRODUCT_STAGES.map((stage) => formatStageLabel(theme, state.currentStage, stage.id, stage.label)).join(
		theme.fg("borderMuted", "  |  "),
	);

	const statusLine = PRODUCT_STAGES.map((stage) => {
		const status = getStageStatus({
			stage: stage.id,
			state,
			policy,
		});
		return `${theme.fg("dim", `${stage.label}:`)} ${formatStatus(theme, status)}`;
	}).join(theme.fg("borderMuted", "  |  "));

	const currentStageStatus = getStageStatus({
		stage: state.currentStage,
		state,
		policy,
	});

	const lines = [
		truncateToWidth(stageLine, width),
		truncateToWidth(statusLine, width),
		truncateToWidth(
			theme.fg("muted", "Current gate:") + " " + formatStatus(theme, currentStageStatus),
			width,
		),
	];

	if (state.lastBlockedReason) {
		lines.push(truncateToWidth(theme.fg("warning", `Blocked: ${state.lastBlockedReason}`), width));
	}

	return lines;
}

function formatStageLabel(theme: Theme, currentStage: ProductStageId, stageId: ProductStageId, label: string): string {
	if (stageId === currentStage) {
		return theme.fg("accent", theme.bold(`[${label}]`));
	}
	return theme.fg("dim", label);
}

function formatStatus(theme: Theme, status: ProductStageStatus): string {
	switch (status) {
		case "Approved":
		case "Done":
			return theme.fg("success", status);
		case "Needs Approval":
			return theme.fg("warning", status);
		case "Blocked":
			return theme.fg("error", status);
		case "In Progress":
			return theme.fg("accent", status);
		case "Draft":
		default:
			return theme.fg("dim", status);
	}
}
