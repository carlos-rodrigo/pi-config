import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { ProductShellComponent } from "./components/product-shell.js";
import {
	getArtifactForStage,
	isArtifactStage,
	loadProductArtifacts,
} from "./services/artifact-service.js";
import {
	dispatchArtifactComposeAction,
	dispatchOpenFileAction,
	validateArtifactPathForDispatch,
	validateTaskPathForDispatch,
} from "./services/dispatch-service.js";
import { loadProductAgentPolicy } from "./services/policy-service.js";
import {
	TASK_GROUP_ORDER,
	loadProductTaskList,
	type ProductTaskItem,
	type ProductTaskListResult,
} from "./services/task-service.js";
import {
	PRODUCT_AGENT_STATE_ENTRY_TYPE,
	createWorkflowStateSnapshot,
	restoreWorkflowStateFromEntries,
} from "./services/state-service.js";
import { applyApprovalDecision, canTransition, getStageLabel } from "./services/workflow-service.js";
import {
	createDefaultProductShellState,
	type ProductApprovalDecision,
	type ProductShellState,
	type ProductStageId,
	type ProductTaskView,
} from "./types.js";

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
		const [policyResult, taskListResult, artifactResult] = await Promise.all([
			loadProductAgentPolicy({ projectRoot: ctx.cwd }),
			loadProductTaskList({
				projectRoot: ctx.cwd,
				featureName: state.featureName,
			}),
			loadProductArtifacts({
				projectRoot: ctx.cwd,
				featureName: state.featureName,
			}),
		]);
		const orderedTasks = getTaskSelectionOrder(taskListResult);
		const taskIndexById = buildTaskIndexById(orderedTasks);

		const persistState = () => {
			pi.appendEntry(PRODUCT_AGENT_STATE_ENTRY_TYPE, createWorkflowStateSnapshot(state));
		};

		if (ensureTaskSelection(state, orderedTasks)) {
			persistState();
		}

		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const shell = new ProductShellComponent(
				theme,
				() => state,
				() => policyResult,
				() => taskListResult,
				() => artifactResult,
				{
					onClose: () => done(),
					onStageChange: (nextStage) => {
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
								transition.reason ??
								`Cannot move to ${getStageLabel(nextStage)} until required approvals are complete.`;
							persistState();
							return true;
						}

						state.currentStage = nextStage;
						state.blockedStage = undefined;
						state.lastBlockedReason = undefined;
						persistState();
						return true;
					},
					onApprovalAction: (decision) => {
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
					onTaskViewToggle: () => {
						if (state.currentStage !== "tasks") return false;
						const nextView: ProductTaskView = state.taskView === "list" ? "board" : "list";
						if (nextView === state.taskView) return false;
						state.taskView = nextView;
						persistState();
						return true;
					},
					onTaskSelectionMove: (direction) => {
						if (state.currentStage !== "tasks") return false;
						const nextTaskId = getNextTaskSelectionId(
							orderedTasks,
							taskIndexById,
							state.selectedTaskId,
							direction,
						);
						if (!nextTaskId || nextTaskId === state.selectedTaskId) return false;
						state.selectedTaskId = nextTaskId;
						return true;
					},
					onTaskFileAction: (mode) => {
						if (state.currentStage !== "tasks") return;
						const selectedTask = getSelectedTask(orderedTasks, state.selectedTaskId);
						if (!selectedTask) {
							ctx.ui.notify("No task selected to open.", "warning");
							return;
						}

						const validatedPath = validateTaskPathForDispatch({
							ctx,
							featureName: state.featureName,
							taskPath: selectedTask.path,
						});
						if (!validatedPath.ok) {
							ctx.ui.notify(validatedPath.reason, "error");
							return;
						}

						dispatchOpenFileAction({
							pi,
							ctx,
							mode,
							path: validatedPath.path,
						});
						done();
					},
					onArtifactCompose: () => {
						if (!isArtifactStage(state.currentStage)) {
							ctx.ui.notify("Compose/refine is available in Plan, Design, and Tasks stages.", "warning");
							return;
						}

						const dispatchResult = dispatchArtifactComposeAction({
							pi,
							ctx,
							featureName: state.featureName,
							stage: state.currentStage,
						});
						if (!dispatchResult.ok) {
							ctx.ui.notify(dispatchResult.reason, "error");
							return;
						}
						done();
					},
					onArtifactFileAction: (mode) => {
						const stageArtifact = getArtifactForStage(artifactResult, state.currentStage);
						if (!stageArtifact) {
							ctx.ui.notify("No artifact file is mapped for this stage.", "warning");
							return;
						}

						if (!stageArtifact.exists) {
							ctx.ui.notify(`Artifact file is missing: ${stageArtifact.path}. Use c to compose first.`, "warning");
							return;
						}

						const validatedPath = validateArtifactPathForDispatch({
							ctx,
							featureName: state.featureName,
							artifactPath: stageArtifact.path,
						});
						if (!validatedPath.ok) {
							ctx.ui.notify(validatedPath.reason, "error");
							return;
						}

						dispatchOpenFileAction({
							pi,
							ctx,
							mode,
							path: validatedPath.path,
						});
						done();
					},
				},
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
	target.taskView = source.taskView;

	if (source.selectedTaskId) {
		target.selectedTaskId = source.selectedTaskId;
	} else {
		delete target.selectedTaskId;
	}

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

function ensureTaskSelection(state: ProductShellState, orderedTasks: ProductTaskItem[]): boolean {
	if (orderedTasks.length === 0) {
		if (!state.selectedTaskId) return false;
		delete state.selectedTaskId;
		return true;
	}

	if (state.selectedTaskId && orderedTasks.some((task) => task.id === state.selectedTaskId)) {
		return false;
	}

	state.selectedTaskId = orderedTasks[0].id;
	return true;
}

function getTaskSelectionOrder(taskListResult: ProductTaskListResult): ProductTaskItem[] {
	const ordered: ProductTaskItem[] = [];
	for (const group of TASK_GROUP_ORDER) {
		ordered.push(...taskListResult.sections[group]);
	}
	return ordered.length > 0 ? ordered : taskListResult.tasks;
}

function buildTaskIndexById(tasks: ProductTaskItem[]): Map<string, number> {
	const index = new Map<string, number>();
	tasks.forEach((task, position) => {
		index.set(task.id, position);
	});
	return index;
}

function getNextTaskSelectionId(
	tasks: ProductTaskItem[],
	taskIndexById: Map<string, number>,
	selectedTaskId: string | undefined,
	direction: -1 | 1,
): string | undefined {
	if (tasks.length === 0) return undefined;

	if (!selectedTaskId) {
		return tasks[0].id;
	}

	const currentIndex = taskIndexById.get(selectedTaskId);
	if (currentIndex === undefined) {
		return tasks[0].id;
	}

	const nextIndex = clamp(currentIndex + direction, 0, tasks.length - 1);
	return tasks[nextIndex]?.id;
}

function getSelectedTask(tasks: ProductTaskItem[], selectedTaskId: string | undefined): ProductTaskItem | undefined {
	if (tasks.length === 0) return undefined;
	if (!selectedTaskId) return tasks[0];
	return tasks.find((task) => task.id === selectedTaskId) ?? tasks[0];
}

function clamp(value: number, min: number, max: number): number {
	if (value < min) return min;
	if (value > max) return max;
	return value;
}
