import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { renderStageHeader } from "./components/stage-header.js";
import { renderTaskList } from "./components/task-list.js";
import { loadProductAgentPolicy, type PolicyLoadResult } from "./services/policy-service.js";
import { loadProductTaskList, type ProductTaskListResult } from "./services/task-service.js";
import {
	PRODUCT_AGENT_STATE_ENTRY_TYPE,
	createWorkflowStateSnapshot,
	restoreWorkflowStateFromEntries,
} from "./services/state-service.js";
import { applyApprovalDecision, canTransition, getStageLabel } from "./services/workflow-service.js";
import {
	PRODUCT_STAGES,
	createDefaultProductShellState,
	type ProductApprovalDecision,
	type ProductShellState,
	type ProductStageId,
} from "./types.js";

class ProductShellComponent {
	private readonly theme: Theme;
	private readonly onClose: () => void;
	private readonly onStageChange: (stage: ProductStageId) => boolean;
	private readonly onApprovalAction: (decision: ProductApprovalDecision) => boolean;
	private readonly getState: () => ProductShellState;
	private readonly getPolicy: () => PolicyLoadResult;
	private readonly getTaskList: () => ProductTaskListResult;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		theme: Theme,
		getState: () => ProductShellState,
		getPolicy: () => PolicyLoadResult,
		getTaskList: () => ProductTaskListResult,
		onStageChange: (stage: ProductStageId) => boolean,
		onApprovalAction: (decision: ProductApprovalDecision) => boolean,
		onClose: () => void,
	) {
		this.theme = theme;
		this.getState = getState;
		this.getPolicy = getPolicy;
		this.getTaskList = getTaskList;
		this.onStageChange = onStageChange;
		this.onApprovalAction = onApprovalAction;
		this.onClose = onClose;
	}

	handleInput(data: string): boolean {
		if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
			this.onClose();
			return false;
		}

		const state = this.getState();
		const currentIndex = PRODUCT_STAGE_INDEX[state.currentStage];

		if ((matchesKey(data, Key.left) || matchesKey(data, "h")) && currentIndex > 0) {
			const nextStage = ORDERED_STAGE_IDS[currentIndex - 1];
			if (!nextStage) return false;
			const didChange = this.onStageChange(nextStage);
			if (didChange) this.invalidate();
			return didChange;
		}

		if ((matchesKey(data, Key.right) || matchesKey(data, "l")) && currentIndex < ORDERED_STAGE_IDS.length - 1) {
			const nextStage = ORDERED_STAGE_IDS[currentIndex + 1];
			if (!nextStage) return false;
			const didChange = this.onStageChange(nextStage);
			if (didChange) this.invalidate();
			return didChange;
		}

		if (matchesKey(data, "a")) {
			const didChange = this.onApprovalAction("approved");
			if (didChange) this.invalidate();
			return didChange;
		}

		if (matchesKey(data, "r")) {
			const didChange = this.onApprovalAction("rejected");
			if (didChange) this.invalidate();
			return didChange;
		}

		return false;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const state = this.getState();
		const policyResult = this.getPolicy();
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
			lines.push(...renderTaskList({
				theme: th,
				width,
				result: this.getTaskList(),
			}));
			lines.push("");
		}

		lines.push(
			truncateToWidth(
				th.fg("dim", "Use ←/→ (or h/l) to move stages · a approve · r reject · q/Esc to close"),
				width,
			),
		);
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

export default function productAgentUiExtension(pi: ExtensionAPI) {
	const state = createDefaultProductShellState();

	pi.on("session_start", (_event, ctx) => {
		restoreStateFromSession(ctx, state.featureName, state);
	});

	const openShell = async (ctx: ExtensionContext, featureArg?: string) => {
		if (!ctx.hasUI) {
			ctx.ui.notify("Product UI requires interactive mode", "error");
			return;
		}

		const requestedFeature = sanitizeFeatureName(featureArg);
		if (featureArg && !requestedFeature) {
			ctx.ui.notify("Invalid feature name. Use letters, numbers, dash, underscore, or dot.", "error");
			return;
		}

		if (requestedFeature && requestedFeature !== state.featureName) {
			setState(state, createDefaultProductShellState(requestedFeature));
		}

		restoreStateFromSession(ctx, state.featureName, state);
		const [policyResult, taskListResult] = await Promise.all([
			loadProductAgentPolicy({ projectRoot: ctx.cwd }),
			loadProductTaskList({
				projectRoot: ctx.cwd,
				featureName: state.featureName,
			}),
		]);

		const persistState = () => {
			pi.appendEntry(PRODUCT_AGENT_STATE_ENTRY_TYPE, createWorkflowStateSnapshot(state));
		};

		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const shell = new ProductShellComponent(
				theme,
				() => state,
				() => policyResult,
				() => taskListResult,
				(nextStage) => {
					if (nextStage === state.currentStage) return false;

					const transition = canTransition({
						currentStage: state.currentStage,
						nextStage,
						policy: policyResult.policy,
						approvals: state.approvals,
					});

					if (!transition.allowed) {
						state.blockedStage = transition.blockedStage ?? nextStage;
						state.lastBlockedReason =
							transition.reason ?? `Cannot move to ${getStageLabel(nextStage)} until required approvals are complete.`;
						persistState();
						return true;
					}

					state.currentStage = nextStage;
					state.blockedStage = undefined;
					state.lastBlockedReason = undefined;
					persistState();
					return true;
				},
				(decision) => {
					const actor = resolveActor();
					const note = buildApprovalNote(decision, state.currentStage);
					const update = applyApprovalDecision({
						state,
						stage: state.currentStage,
						decision,
						note,
						actor,
					});

					if (!update.updated) {
						state.blockedStage = state.currentStage;
						state.lastBlockedReason = update.reason ?? "This stage cannot be approved.";
						persistState();
						return true;
					}

					setState(state, update.state);
					persistState();
					return true;
				},
				() => done(),
			);

			return {
				render: (width: number) => shell.render(width),
				invalidate: () => shell.invalidate(),
				handleInput: (data: string) => {
					if (shell.handleInput(data)) {
						tui.requestRender();
					}
				},
			};
		});
	};

	pi.registerCommand("product", {
		description: "Open Product Agent UI shell (usage: /product [feature])",
		handler: async (args, ctx) => {
			await openShell(ctx, args);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("w"), {
		description: "Open Product Agent UI shell",
		handler: async (ctx) => {
			await openShell(ctx);
		},
	});
}

function restoreStateFromSession(ctx: ExtensionContext, featureName: string, state: ProductShellState): boolean {
	const restored = restoreWorkflowStateFromEntries(ctx.sessionManager.getEntries(), featureName);
	if (!restored) return false;
	setState(state, restored);
	return true;
}

function setState(target: ProductShellState, source: ProductShellState): void {
	target.featureName = source.featureName;
	target.currentStage = source.currentStage;
	target.approvals = {
		...source.approvals,
	};

	if (source.blockedStage) {
		target.blockedStage = source.blockedStage;
	} else {
		delete target.blockedStage;
	}

	if (source.lastBlockedReason) {
		target.lastBlockedReason = source.lastBlockedReason;
	} else {
		delete target.lastBlockedReason;
	}
}

function sanitizeFeatureName(raw?: string): string | undefined {
	if (!raw) return undefined;
	const sanitized = raw.replace(/[\u0000-\u001F\u007F]+/g, " ").trim();
	if (!sanitized) return undefined;
	if (sanitized.includes("/") || sanitized.includes("\\") || sanitized.includes("..")) {
		return undefined;
	}
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(sanitized)) {
		return undefined;
	}
	return sanitized;
}

function resolveActor(): string {
	return process.env.USER ?? process.env.USERNAME ?? "unknown";
}

function buildApprovalNote(decision: ProductApprovalDecision, stage: ProductStageId): string {
	if (decision === "approved") {
		return `Approved in Product Agent UI for ${getStageLabel(stage)}.`;
	}
	return `Rejected in Product Agent UI for ${getStageLabel(stage)}. Changes requested before proceeding.`;
}
