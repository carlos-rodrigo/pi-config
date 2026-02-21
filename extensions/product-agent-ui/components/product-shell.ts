import type { Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { renderArtifactPanel } from "./artifact-panel.js";
import { renderReviewPanel } from "./review-panel.js";
import { renderRunConsole } from "./run-console.js";
import { renderStageHeader } from "./stage-header.js";
import { renderTaskBoard } from "./task-board.js";
import { renderTaskList } from "./task-list.js";
import {
	getArtifactForStage,
	isArtifactStage,
	type ProductArtifactLoadResult,
} from "../services/artifact-service.js";
import type { PolicyLoadResult } from "../services/policy-service.js";
import type { ProductReviewData } from "../services/review-service.js";
import type { ProductTaskListResult } from "../services/task-service.js";
import {
	PRODUCT_STAGES,
	type ProductApprovalDecision,
	type ProductRunControlAction,
	type ProductShellState,
	type ProductStageId,
	type TaskFileActionMode,
} from "../types.js";

export interface ProductShellCallbacks {
	onClose: () => void;
	onStageChange: (stage: ProductStageId) => boolean;
	onApprovalAction: (decision: ProductApprovalDecision) => boolean;
	onRunControl: (action: ProductRunControlAction) => boolean;
	onTaskViewToggle: () => boolean;
	onTaskSelectionMove: (direction: -1 | 1) => boolean;
	onTaskFileAction: (mode: TaskFileActionMode) => void;
	onReviewSelectionMove: (direction: -1 | 1) => boolean;
	onReviewFileAction: (mode: TaskFileActionMode) => void;
	onArtifactCompose: () => void;
	onArtifactFileAction: (mode: TaskFileActionMode) => void;
}

export class ProductShellComponent {
	private readonly theme: Theme;
	private readonly getState: () => ProductShellState;
	private readonly getPolicy: () => PolicyLoadResult;
	private readonly getTaskList: () => ProductTaskListResult;
	private readonly getReview: () => ProductReviewData;
	private readonly getArtifacts: () => ProductArtifactLoadResult;
	private readonly callbacks: ProductShellCallbacks;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		theme: Theme,
		getState: () => ProductShellState,
		getPolicy: () => PolicyLoadResult,
		getTaskList: () => ProductTaskListResult,
		getReview: () => ProductReviewData,
		getArtifacts: () => ProductArtifactLoadResult,
		callbacks: ProductShellCallbacks,
	) {
		this.theme = theme;
		this.getState = getState;
		this.getPolicy = getPolicy;
		this.getTaskList = getTaskList;
		this.getReview = getReview;
		this.getArtifacts = getArtifacts;
		this.callbacks = callbacks;
	}

	handleInput(data: string): boolean {
		if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
			this.callbacks.onClose();
			return false;
		}

		const state = this.getState();
		const currentIndex = PRODUCT_STAGE_INDEX[state.currentStage];

		if ((matchesKey(data, Key.left) || matchesKey(data, "h")) && currentIndex > 0) {
			const previousStage = ORDERED_STAGE_IDS[currentIndex - 1];
			if (!previousStage) return false;
			const didChange = this.callbacks.onStageChange(previousStage);
			if (didChange) this.invalidate();
			return didChange;
		}

		if ((matchesKey(data, Key.right) || matchesKey(data, "l")) && currentIndex < ORDERED_STAGE_IDS.length - 1) {
			const nextStage = ORDERED_STAGE_IDS[currentIndex + 1];
			if (!nextStage) return false;
			const didChange = this.callbacks.onStageChange(nextStage);
			if (didChange) this.invalidate();
			return didChange;
		}

		if (isArtifactStage(state.currentStage) && matchesKey(data, "c")) {
			this.callbacks.onArtifactCompose();
			return false;
		}

		if (state.currentStage === "tasks") {
			if (matchesKey(data, "v")) {
				const didChange = this.callbacks.onTaskViewToggle();
				if (didChange) this.invalidate();
				return didChange;
			}

			if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
				const didChange = this.callbacks.onTaskSelectionMove(-1);
				if (didChange) this.invalidate();
				return didChange;
			}

			if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
				const didChange = this.callbacks.onTaskSelectionMove(1);
				if (didChange) this.invalidate();
				return didChange;
			}

			if (matchesKey(data, "o")) {
				this.callbacks.onTaskFileAction("view");
				return false;
			}

			if (matchesKey(data, "d")) {
				this.callbacks.onTaskFileAction("diff");
				return false;
			}

			if (matchesKey(data, "e")) {
				this.callbacks.onTaskFileAction("edit");
				return false;
			}

			if (matchesKey(data, Key.shift("o"))) {
				this.callbacks.onArtifactFileAction("view");
				return false;
			}

			if (matchesKey(data, Key.shift("d"))) {
				this.callbacks.onArtifactFileAction("diff");
				return false;
			}

			if (matchesKey(data, Key.shift("e"))) {
				this.callbacks.onArtifactFileAction("edit");
				return false;
			}
		} else if (state.currentStage === "plan" || state.currentStage === "design") {
			if (matchesKey(data, "o")) {
				this.callbacks.onArtifactFileAction("view");
				return false;
			}

			if (matchesKey(data, "d")) {
				this.callbacks.onArtifactFileAction("diff");
				return false;
			}

			if (matchesKey(data, "e")) {
				this.callbacks.onArtifactFileAction("edit");
				return false;
			}
		} else if (state.currentStage === "implement") {
			if (matchesKey(data, "c")) {
				const didChange = this.callbacks.onRunControl("continue");
				if (didChange) this.invalidate();
				return didChange;
			}

			if (matchesKey(data, "p")) {
				const didChange = this.callbacks.onRunControl("pause");
				if (didChange) this.invalidate();
				return didChange;
			}

			if (matchesKey(data, "r")) {
				const didChange = this.callbacks.onRunControl("request_changes");
				if (didChange) this.invalidate();
				return didChange;
			}
		} else if (state.currentStage === "review") {
			if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
				const didChange = this.callbacks.onReviewSelectionMove(-1);
				if (didChange) this.invalidate();
				return didChange;
			}

			if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
				const didChange = this.callbacks.onReviewSelectionMove(1);
				if (didChange) this.invalidate();
				return didChange;
			}

			if (matchesKey(data, "o")) {
				this.callbacks.onReviewFileAction("view");
				return false;
			}

			if (matchesKey(data, "d")) {
				this.callbacks.onReviewFileAction("diff");
				return false;
			}

			if (matchesKey(data, "e")) {
				this.callbacks.onReviewFileAction("edit");
				return false;
			}
		}

		if (isApprovalStage(state.currentStage) && matchesKey(data, "a")) {
			const didChange = this.callbacks.onApprovalAction("approved");
			if (didChange) this.invalidate();
			return didChange;
		}

		if (isApprovalStage(state.currentStage) && matchesKey(data, "r")) {
			const didChange = this.callbacks.onApprovalAction("rejected");
			if (didChange) this.invalidate();
			return didChange;
		}

		return false;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const state = this.getState();
		const policyResult = this.getPolicy();
		const taskListResult = this.getTaskList();
		const reviewResult = this.getReview();
		const artifactResult = this.getArtifacts();
		const th = this.theme;
		const lines: string[] = [];

		lines.push("");
		lines.push(truncateToWidth(th.fg("accent", th.bold("Product Agent UI")), width));
		lines.push(truncateToWidth(th.fg("muted", `Feature: ${state.featureName}`), width));
		lines.push(
			truncateToWidth(
				th.fg(
					"muted",
					`Policy: ${policyResult.policy.mode} (${policyResult.source === "project-file" ? "project config" : "built-in defaults"})`,
				),
				width,
			),
		);
		if (policyResult.warning) {
			lines.push(truncateToWidth(th.fg("muted", `⚠ ${policyResult.warning.message}`), width));
		}
		lines.push("");
		lines.push(...renderStageHeader({ theme: th, width, state, policy: policyResult.policy }));
		lines.push("");

		if (state.currentStage === "tasks") {
			if (state.taskView === "board") {
				lines.push(
					...renderTaskBoard({
						theme: th,
						width,
						result: taskListResult,
						selectedTaskId: state.selectedTaskId,
					}),
				);
			} else {
				lines.push(
					...renderTaskList({
						theme: th,
						width,
						result: taskListResult,
						selectedTaskId: state.selectedTaskId,
					}),
				);
			}
			lines.push("");
		}

		if (state.currentStage === "implement") {
			lines.push(
				...renderRunConsole({
					theme: th,
					width,
					runState: state.run,
					taskList: taskListResult,
				}),
			);
			lines.push("");
		}

		if (state.currentStage === "review") {
			lines.push(
				...renderReviewPanel({
					theme: th,
					width,
					result: reviewResult,
					selectedPath: state.selectedReviewPath,
				}),
			);
			lines.push("");
		}

		const stageArtifact = getArtifactForStage(artifactResult, state.currentStage);
		if (stageArtifact) {
			lines.push(
				...renderArtifactPanel({
					theme: th,
					width,
					artifact: stageArtifact,
					compact: state.currentStage === "tasks",
				}),
			);
			lines.push("");
		}

		lines.push(truncateToWidth(th.fg("dim", buildControlsLine(state.currentStage)), width));
		lines.push(
			truncateToWidth(
				th.fg("dim", "Approvals apply to Plan (PRD), Design, and Tasks stages."),
				width,
			),
		);
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

const ORDERED_STAGE_IDS: ProductStageId[] = PRODUCT_STAGES.map((stage) => stage.id);

const PRODUCT_STAGE_INDEX: Record<ProductStageId, number> = ORDERED_STAGE_IDS.reduce(
	(accumulator, stageId, index) => {
		accumulator[stageId] = index;
		return accumulator;
	},
	{} as Record<ProductStageId, number>,
);

function buildControlsLine(stage: ProductStageId): string {
	switch (stage) {
		case "plan":
		case "design":
			return "Use ←/→ (or h/l) to move stages · c compose/refine · o open · d diff · e edit · a approve · r reject · q/Esc close";
		case "tasks":
			return "Use ←/→ (or h/l) to move stages · ↑/↓ (or j/k) select · v list/board · o/d/e task · O/D/E artifact · c compose/refine · a approve · r reject · q/Esc close";
		case "implement":
			return "Use ←/→ (or h/l) to move stages · c continue · p pause · r request changes · q/Esc close";
		case "review":
			return "Use ←/→ (or h/l) to move stages · ↑/↓ (or j/k) select · o open · d diff · e edit · q/Esc close";
		default:
			return "Use ←/→ (or h/l) to move stages · q/Esc close";
	}
}

function isApprovalStage(stage: ProductStageId): boolean {
	return stage === "plan" || stage === "design" || stage === "tasks";
}
