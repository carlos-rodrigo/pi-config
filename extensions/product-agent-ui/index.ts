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
import { loadProductAgentPolicy, type ProductAgentPolicy } from "./services/policy-service.js";
import {
	reconcileRunStateWithTaskFiles,
	reconcileTaskListWithActiveFile,
	splitWarningText,
} from "./services/reconcile-service.js";
import {
	buildPreShipChecklist,
	loadProductReviewFiles,
	validateReviewFileAction,
	type ProductReviewData,
	type ProductReviewFileItem,
} from "./services/review-service.js";
import {
	buildImplementTaskCommand,
	continueRunLoop,
	pauseRunLoop,
	requestRunLoopChanges,
} from "./services/runloop-service.js";
import {
	TASK_GROUP_ORDER,
	loadProductTaskList,
	type ProductTaskItem,
	type ProductTaskListResult,
} from "./services/task-service.js";
import {
	PRODUCT_AGENT_STATE_ENTRY_TYPE,
	createWorkflowStateSnapshot,
	findLatestWorkflowFeatureName,
	restoreWorkflowStateFromEntriesWithWarnings,
} from "./services/state-service.js";
import { applyApprovalDecision, canTransition, getStageLabel } from "./services/workflow-service.js";
import {
	createDefaultProductShellState,
	type ProductApprovalDecision,
	type ProductRunControlAction,
	type ProductRunState,
	type ProductShellState,
	type ProductStageId,
	type ProductTaskView,
} from "./types.js";

export default function productAgentUiExtension(pi: ExtensionAPI) {
	const state = createDefaultProductShellState();
	let pendingPreparation:
		| {
				featureName: string;
				promise: Promise<PreparedProductState>;
		  }
		| undefined;

	const schedulePreparation = (ctx: ExtensionContext, featureName: string): Promise<PreparedProductState> => {
		if (pendingPreparation && pendingPreparation.featureName === featureName) {
			return pendingPreparation.promise;
		}

		const promise = prepareStateForFeature({
			ctx,
			state,
			featureName,
		});
		pendingPreparation = {
			featureName,
			promise,
		};
		void promise.finally(() => {
			if (pendingPreparation?.promise === promise) {
				pendingPreparation = undefined;
			}
		});

		return promise;
	};

	pi.on("session_start", (_event, ctx) => {
		const latestFeatureName = findLatestWorkflowFeatureName(ctx.sessionManager.getEntries());
		if (!latestFeatureName) {
			return;
		}

		void schedulePreparation(ctx, latestFeatureName)
			.then((preparation) => {
				notifyReconciliationWarnings(ctx, preparation.warnings);
				if (preparation.runStateUpdated) {
					pi.appendEntry(PRODUCT_AGENT_STATE_ENTRY_TYPE, createWorkflowStateSnapshot(state));
				}
			})
			.catch((error) => {
				ctx.ui.notify(`Could not prepare Product Agent state on session start: ${toErrorMessage(error)}`, "warning");
			});
	});

	const resolveFeaturePreparation = async (
		ctx: ExtensionContext,
		featureArg?: string,
	): Promise<FeaturePreparationContext | undefined> => {
		const requestedFeature = sanitizeFeatureName(featureArg);
		if (featureArg && !requestedFeature) {
			ctx.ui.notify("Invalid feature name. Use letters, numbers, dash, underscore, or dot.", "error");
			return undefined;
		}

		const targetFeatureName = resolveTargetFeatureName({
			ctx,
			state,
			requestedFeature,
		});

		const existingPreparation =
			pendingPreparation && pendingPreparation.featureName === targetFeatureName
				? pendingPreparation.promise
				: undefined;

		if (pendingPreparation && pendingPreparation.featureName !== targetFeatureName) {
			await pendingPreparation.promise.catch(() => undefined);
		}

		return {
			featureName: targetFeatureName,
			preparationPromise: existingPreparation ?? schedulePreparation(ctx, targetFeatureName),
		};
	};

	const openShell = async (ctx: ExtensionContext, featureArg?: string, options?: OpenShellOptions) => {
		if (!ctx.hasUI) {
			ctx.ui.notify("Product UI requires interactive mode", "error");
			return;
		}

		const preparedFeature = await resolveFeaturePreparation(ctx, featureArg);
		if (!preparedFeature) {
			return;
		}

		const { featureName: targetFeatureName, preparationPromise } = preparedFeature;
		const [policyResult, artifactResult, reviewFilesResult, preparation] = await Promise.all([
			loadProductAgentPolicy({ projectRoot: ctx.cwd }),
			loadProductArtifacts({
				projectRoot: ctx.cwd,
				featureName: targetFeatureName,
			}),
			loadProductReviewFiles({
				projectRoot: ctx.cwd,
			}),
			preparationPromise,
		]);

		const taskListResult = preparation.taskList;
		notifyReconciliationWarnings(ctx, preparation.warnings);

		let reviewResult: ProductReviewData = {
			files: reviewFilesResult.files,
			warning: reviewFilesResult.warning,
			checklist: buildPreShipChecklist({
				policy: policyResult.policy,
				approvals: state.approvals,
				taskList: taskListResult,
			}),
		};

		const refreshReviewChecklist = () => {
			reviewResult = {
				...reviewResult,
				checklist: buildPreShipChecklist({
					policy: policyResult.policy,
					approvals: state.approvals,
					taskList: taskListResult,
				}),
			};
		};

		const orderedTasks = getTaskSelectionOrder(taskListResult);
		const taskIndexById = buildTaskIndexById(orderedTasks);
		const reviewPathIndex = buildReviewPathIndex(reviewResult.files);

		const persistState = () => {
			pi.appendEntry(PRODUCT_AGENT_STATE_ENTRY_TYPE, createWorkflowStateSnapshot(state));
		};

		const stageOverrideApplied = applyInitialStageOverride(state, options?.initialStage);

		if (preparation.runStateUpdated || stageOverrideApplied) {
			persistState();
		}

		if (ensureTaskSelection(state, orderedTasks)) {
			persistState();
		}

		if (ensureReviewSelection(state, reviewResult.files)) {
			persistState();
		}

		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const shell = new ProductShellComponent(
				theme,
				() => state,
				() => policyResult,
				() => taskListResult,
				() => reviewResult,
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
						if (!isApprovalStage(state.currentStage)) {
							return false;
						}

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
						refreshReviewChecklist();
						persistState();
						return true;
					},
					onRunControl: (action) => {
						if (state.currentStage !== "implement") {
							return false;
						}

						return executeRunControlAction({
							action,
							pi,
							ctx,
							state,
							taskList: taskListResult,
							policy: policyResult.policy,
							persistState,
							onCommandDispatched: () => done(),
						});
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
					onReviewSelectionMove: (direction) => {
						if (state.currentStage !== "review") return false;
						const nextPath = getNextReviewSelectionPath(
							reviewResult.files,
							reviewPathIndex,
							state.selectedReviewPath,
							direction,
						);
						if (!nextPath || nextPath === state.selectedReviewPath) return false;
						state.selectedReviewPath = nextPath;
						return true;
					},
					onReviewFileAction: (mode) => {
						if (state.currentStage !== "review") return;
						const selectedFile = getSelectedReviewFile(reviewResult.files, state.selectedReviewPath);
						if (!selectedFile) {
							ctx.ui.notify("No review file selected to open.", "warning");
							return;
						}

						void (async () => {
							const validation = await validateReviewFileAction({
								projectRoot: ctx.cwd,
								path: selectedFile.path,
								expectedStatus: selectedFile.status,
								mode,
							});
							if (!validation.ok) {
								ctx.ui.notify(validation.reason, validation.stale ? "warning" : "error");
								return;
							}

							dispatchOpenFileAction({
								pi,
								ctx,
								mode,
								path: validation.path,
							});
							done();
						})();
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

	const runLoopFromCommand = async (ctx: ExtensionContext, featureArg?: string) => {
		const preparedFeature = await resolveFeaturePreparation(ctx, featureArg);
		if (!preparedFeature) {
			return;
		}

		const [policyResult, preparation] = await Promise.all([
			loadProductAgentPolicy({ projectRoot: ctx.cwd }),
			preparedFeature.preparationPromise,
		]);

		notifyReconciliationWarnings(ctx, preparation.warnings);

		const persistState = () => {
			pi.appendEntry(PRODUCT_AGENT_STATE_ENTRY_TYPE, createWorkflowStateSnapshot(state));
		};

		const stageOverrideApplied = applyInitialStageOverride(state, "implement");
		if (preparation.runStateUpdated || stageOverrideApplied) {
			persistState();
		}

		executeRunControlAction({
			action: "continue",
			pi,
			ctx,
			state,
			taskList: preparation.taskList,
			policy: policyResult.policy,
			persistState,
		});
	};

	pi.registerCommand("product", {
		description: "Open Product Agent UI shell (usage: /product [feature])",
		handler: async (args, ctx) => {
			await openShell(ctx, args);
		},
	});

	pi.registerCommand("product-run", {
		description: "Start or continue Product Agent run loop (usage: /product-run [feature])",
		handler: async (args, ctx) => {
			await runLoopFromCommand(ctx, args);
		},
	});

	pi.registerCommand("product-review", {
		description: "Open Product Agent UI in Review stage (usage: /product-review [feature])",
		handler: async (args, ctx) => {
			await openShell(ctx, args, { initialStage: "review" });
		},
	});

	pi.registerShortcut(Key.ctrlAlt("w"), {
		description: "Open Product Agent UI shell",
		handler: async (ctx) => {
			await openShell(ctx);
		},
	});
}

interface OpenShellOptions {
	initialStage?: ProductStageId;
}

interface FeaturePreparationContext {
	featureName: string;
	preparationPromise: Promise<PreparedProductState>;
}

interface PreparedProductState {
	taskList: ProductTaskListResult;
	warnings: string[];
	runStateUpdated: boolean;
}

function resolveTargetFeatureName(params: {
	ctx: ExtensionContext;
	state: ProductShellState;
	requestedFeature?: string;
}): string {
	if (params.requestedFeature) {
		return params.requestedFeature;
	}

	const restoredFeatureName = findLatestWorkflowFeatureName(params.ctx.sessionManager.getEntries());
	if (restoredFeatureName) {
		return restoredFeatureName;
	}

	return params.state.featureName;
}

async function prepareStateForFeature(params: {
	ctx: ExtensionContext;
	state: ProductShellState;
	featureName?: string;
}): Promise<PreparedProductState> {
	const { ctx, state } = params;
	const featureName = params.featureName ?? resolveTargetFeatureName({ ctx, state });
	const sessionEntries = ctx.sessionManager.getEntries();

	setState(state, createDefaultProductShellState(featureName));

	const rawTaskList = await loadProductTaskList({
		projectRoot: ctx.cwd,
		featureName,
	});
	const taskList = await reconcileTaskListWithActiveFile({
		projectRoot: ctx.cwd,
		featureName,
		taskList: rawTaskList,
	});

	const restoreResult = restoreWorkflowStateFromEntriesWithWarnings(sessionEntries, featureName);
	if (restoreResult.state) {
		setState(state, restoreResult.state);
	} else {
		state.featureName = featureName;
	}

	const runReconciliation = reconcileRunStateWithTaskFiles({
		runState: state.run,
		taskList,
	});
	const runStateUpdated = runReconciliation.runState !== state.run;
	state.run = runReconciliation.runState;

	return {
		taskList,
		warnings: [
			...restoreResult.warnings,
			...splitWarningText(taskList.warning),
			...runReconciliation.warnings,
		],
		runStateUpdated,
	};
}

function setState(target: ProductShellState, source: ProductShellState): void {
	target.featureName = source.featureName;
	target.currentStage = source.currentStage;
	target.approvals = {
		...source.approvals,
	};
	target.taskView = source.taskView;
	target.run = cloneRunState(source.run);

	if (source.selectedTaskId) {
		target.selectedTaskId = source.selectedTaskId;
	} else {
		delete target.selectedTaskId;
	}

	if (source.selectedReviewPath) {
		target.selectedReviewPath = source.selectedReviewPath;
	} else {
		delete target.selectedReviewPath;
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

function applyInitialStageOverride(state: ProductShellState, stage?: ProductStageId): boolean {
	if (!stage || state.currentStage === stage) {
		return false;
	}

	state.currentStage = stage;
	state.blockedStage = undefined;
	state.lastBlockedReason = undefined;
	return true;
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

function ensureReviewSelection(state: ProductShellState, reviewFiles: ProductReviewFileItem[]): boolean {
	if (reviewFiles.length === 0) {
		if (!state.selectedReviewPath) return false;
		delete state.selectedReviewPath;
		return true;
	}

	if (state.selectedReviewPath && reviewFiles.some((file) => file.path === state.selectedReviewPath)) {
		return false;
	}

	state.selectedReviewPath = reviewFiles[0].path;
	return true;
}

function buildReviewPathIndex(reviewFiles: ProductReviewFileItem[]): Map<string, number> {
	const index = new Map<string, number>();
	reviewFiles.forEach((file, position) => {
		index.set(file.path, position);
	});
	return index;
}

function getNextReviewSelectionPath(
	reviewFiles: ProductReviewFileItem[],
	reviewPathIndex: Map<string, number>,
	selectedPath: string | undefined,
	direction: -1 | 1,
): string | undefined {
	if (reviewFiles.length === 0) return undefined;

	if (!selectedPath) {
		return reviewFiles[0].path;
	}

	const currentIndex = reviewPathIndex.get(selectedPath);
	if (currentIndex === undefined) {
		return reviewFiles[0].path;
	}

	const nextIndex = clamp(currentIndex + direction, 0, reviewFiles.length - 1);
	return reviewFiles[nextIndex]?.path;
}

function getSelectedReviewFile(
	reviewFiles: ProductReviewFileItem[],
	selectedPath: string | undefined,
): ProductReviewFileItem | undefined {
	if (reviewFiles.length === 0) return undefined;
	if (!selectedPath) return reviewFiles[0];
	return reviewFiles.find((file) => file.path === selectedPath) ?? reviewFiles[0];
}

function executeRunControlAction(params: {
	action: ProductRunControlAction;
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	state: ProductShellState;
	taskList: ProductTaskListResult;
	policy: ProductAgentPolicy;
	persistState: () => void;
	onCommandDispatched?: () => void;
}): boolean {
	const { action, pi, ctx, state, taskList, policy, persistState, onCommandDispatched } = params;

	const preActionMetadata = reconcileRunStateWithTaskFiles({
		runState: state.run,
		taskList,
	});
	notifyReconciliationWarnings(ctx, preActionMetadata.warnings);
	if (preActionMetadata.runState !== state.run) {
		state.run = preActionMetadata.runState;
	}

	const actionResult = runRunControlAction({
		action,
		featureName: state.featureName,
		runState: state.run,
		taskList,
		policy,
		approvals: state.approvals,
	});

	const postActionMetadata = reconcileRunStateWithTaskFiles({
		runState: actionResult.runState,
		taskList,
	});
	notifyReconciliationWarnings(ctx, postActionMetadata.warnings);
	state.run = postActionMetadata.runState;
	persistState();
	ctx.ui.notify(actionResult.notification, actionResult.level);

	if (!actionResult.command) {
		return true;
	}

	const activeTask = state.run.activeTaskId
		? taskList.tasks.find((task) => task.id === state.run.activeTaskId)
		: undefined;
	if (!activeTask) {
		const runUpdate = requestRunLoopChanges({
			runState: state.run,
			reason: "Run loop dispatch blocked: active task metadata is missing.",
		});
		state.run = runUpdate.runState;
		persistState();
		ctx.ui.notify("Run loop dispatch blocked: active task metadata is missing.", "error");
		return true;
	}

	const validatedPath = validateTaskPathForDispatch({
		ctx,
		featureName: state.featureName,
		taskPath: activeTask.path,
	});
	if (!validatedPath.ok) {
		const runUpdate = requestRunLoopChanges({
			runState: state.run,
			reason: validatedPath.reason,
		});
		state.run = runUpdate.runState;
		persistState();
		ctx.ui.notify(validatedPath.reason, "error");
		return true;
	}

	dispatchWorkflowCommand(pi, ctx, buildImplementTaskCommand(state.featureName, validatedPath.path));
	onCommandDispatched?.();
	return true;
}

function runRunControlAction(params: {
	action: ProductRunControlAction;
	featureName: string;
	runState: ProductRunState;
	taskList: ProductTaskListResult;
	policy: ProductAgentPolicy;
	approvals: ProductShellState["approvals"];
}) {
	switch (params.action) {
		case "continue":
			return continueRunLoop({
				featureName: params.featureName,
				runState: params.runState,
				taskList: params.taskList,
				policy: params.policy,
				approvals: params.approvals,
			});
		case "pause":
			return pauseRunLoop({
				runState: params.runState,
			});
		case "request_changes":
			return requestRunLoopChanges({
				runState: params.runState,
			});
		default:
			return pauseRunLoop({
				runState: params.runState,
			});
	}
}

function dispatchWorkflowCommand(pi: ExtensionAPI, ctx: ExtensionContext, command: string): void {
	if (ctx.isIdle()) {
		pi.sendUserMessage(command);
		return;
	}
	pi.sendUserMessage(command, { deliverAs: "followUp" });
}

function notifyReconciliationWarnings(ctx: ExtensionContext, warnings: readonly string[]): void {
	const normalizedWarnings = new Set<string>();
	for (const warning of warnings) {
		const normalizedWarning = warning.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").trim();
		if (!normalizedWarning) continue;
		normalizedWarnings.add(normalizedWarning);
	}

	for (const warning of normalizedWarnings) {
		ctx.ui.notify(warning, "warning");
	}
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function isApprovalStage(stage: ProductStageId): boolean {
	return stage === "plan" || stage === "design" || stage === "tasks";
}

function clamp(value: number, min: number, max: number): number {
	if (value < min) return min;
	if (value > max) return max;
	return value;
}
