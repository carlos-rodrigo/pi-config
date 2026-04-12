import {
	convertToLlm,
	serializeConversation,
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {Type} from "@sinclair/typebox";

import {HANDOFF_SESSION_STARTED_EVENT, type HandoffSessionStartedEvent} from "../handoff/events.ts";
import {
	extractSection,
	refreshBrief,
	truncateText,
	type RefreshBriefResult,
} from "./brief-engine.ts";
import {
	buildExplorationKey,
	buildRecommendationKey,
	buildRecommendationNotice,
	buildSuggestedHandoffCommand,
	computeStaleReasons,
	formatStaleReasonLabel,
	noteExplorationKey,
	noteHotPathChange,
	shouldRecommendFreshSession,
	type StaleReason,
} from "./drift-monitor.ts";
import {
	attachHandoffPromptText,
	createLatestHandoffState,
	matchesHandoffSession,
	renderLatestHandoffSource,
	type LatestHandoffState,
} from "./handoff-link.ts";
import {
	findBriefByTopicOrAlias,
	formatBriefList,
	formatBriefView,
	loadBriefs,
	normalizeTopic,
	type BriefRecord,
} from "./brief-store.ts";

type FocusedContextState = {
	activeTopic?: string;
	pinnedTopic?: string;
	latestHandoff?: LatestHandoffState;
};

type FocusedContextDriftState = {
	turnsSinceRefresh: number;
	recentExplorationKeys: string[];
	changedHotPaths: string[];
	topicTransitionCount: number;
	lastRecommendationKey?: string;
};

export type EnsureRefreshPolicy = "always" | "if_stale" | "never";

type EnsureAction = "created" | "refreshed" | "reused";

export type FocusedContextDeps = {
	refreshBriefForTopic?: (params: {
		ctx: ExtensionContext;
		topic: string;
		brief?: BriefRecord;
		latestHandoffText?: string;
	}) => Promise<RefreshBriefResult>;
};

const STATE_ENTRY_TYPE = "focused-context";
const ENSURE_MAX_TOTAL_CHARS = 2_000;
const ENSURE_SECTION_MAX_LINES = 4;
const ENSURE_SECTION_MAX_CHARS = 320;
const COMPACTION_BRIEF_MAX_CHARS = 1_400;
const COMPACTION_PREVIOUS_SUMMARY_MAX_CHARS = 2_000;
const COMPACTION_RECENT_DELTA_MAX_CHARS = 3_000;
const COMPACTION_HANDOFF_MAX_CHARS = 1_000;
const COMPACTION_CUSTOM_INSTRUCTIONS_MAX_CHARS = 240;
const TOPIC_STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"build",
	"change",
	"create",
	"feature",
	"fix",
	"for",
	"implement",
	"in",
	"investigate",
	"new",
	"on",
	"the",
	"to",
	"update",
	"with",
	"work",
]);

function restoreState(ctx: ExtensionContext): FocusedContextState {
	const entries = ctx.sessionManager.getEntries() as Array<{
		type?: string;
		customType?: string;
		data?: FocusedContextState;
	}>;

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
		return {
			activeTopic: entry.data?.activeTopic,
			pinnedTopic: entry.data?.pinnedTopic,
			latestHandoff: entry.data?.latestHandoff,
		};
	}

	return {};
}

function createEmptyDriftState(): FocusedContextDriftState {
	return {
		turnsSinceRefresh: 0,
		recentExplorationKeys: [],
		changedHotPaths: [],
		topicTransitionCount: 0,
		lastRecommendationKey: undefined,
	};
}

function normalizeState(state: FocusedContextState): FocusedContextState {
	return {
		activeTopic: state.activeTopic,
		pinnedTopic: state.pinnedTopic,
		...(state.latestHandoff ? {latestHandoff: state.latestHandoff} : {}),
	};
}

function stateFingerprint(state: FocusedContextState): string {
	return JSON.stringify(normalizeState(state));
}

function getSessionIdentity(ctx: ExtensionContext): {sessionId?: string; sessionFile?: string} {
	const sessionManager = ctx.sessionManager as ExtensionContext["sessionManager"] & {
		getSessionId?: () => string;
		getSessionFile?: () => string | undefined;
	};
	return {
		sessionId: sessionManager.getSessionId?.(),
		sessionFile: sessionManager.getSessionFile?.(),
	};
}

function getFreshnessLabel(brief: BriefRecord | undefined): "fresh" | "stale" {
	return brief?.updatedAt ? "fresh" : "stale";
}

function getDriftReasons(driftState: FocusedContextDriftState): StaleReason[] {
	return computeStaleReasons({
		turnsSinceRefresh: driftState.turnsSinceRefresh,
		changedHotPaths: driftState.changedHotPaths,
		recentExplorationKeys: driftState.recentExplorationKeys,
		topicTransitionCount: driftState.topicTransitionCount,
	});
}

function formatStatus(
	ctx: ExtensionContext,
	brief: BriefRecord | undefined,
	reasons: StaleReason[] = [],
): string | undefined {
	if (!brief) return undefined;
	let text = `brief:${brief.topic} · ${reasons.length > 0 ? formatStaleReasonLabel(reasons) : getFreshnessLabel(brief)}`;
	if (shouldRecommendFreshSession(reasons)) text += " · new-session?";
	return ctx.ui.theme.fg("accent", text);
}

export function normalizeRefreshPolicy(value: string | undefined): EnsureRefreshPolicy | undefined {
	if (!value) return "if_stale";
	if (value === "always" || value === "if_stale" || value === "never") return value;
	return undefined;
}

export function shouldRefreshBrief(brief: BriefRecord | undefined, policy: EnsureRefreshPolicy): boolean {
	if (!brief) return true;
	if (policy === "always") return true;
	if (policy === "never") return false;
	return getFreshnessLabel(brief) === "stale";
}

function tokenizeTask(task: string): string[] {
	return task
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.split(/\s+/)
		.map((part) => part.trim())
		.filter((part) => part.length > 1 && !TOPIC_STOPWORDS.has(part));
}

function deriveTopicFromTask(task: string): string | undefined {
	const tokens = tokenizeTask(task).slice(0, 3);
	if (tokens.length === 0) return undefined;
	return normalizeTopic(tokens.join("-"));
}

function scoreBriefMatch(brief: BriefRecord, task: string): number {
	const lowerTask = task.toLowerCase();
	let score = 0;

	if (lowerTask.includes(brief.topic)) score += 100;
	for (const alias of brief.aliases) {
		if (lowerTask.includes(alias)) score += 80;
	}

	const tokens = tokenizeTask(task);
	for (const token of brief.topic.split(/[-_\s]+/)) {
		if (tokens.includes(token)) score += 10;
	}
	for (const alias of brief.aliases) {
		for (const token of alias.split(/[-_\s]+/)) {
			if (tokens.includes(token)) score += 6;
		}
	}

	return score;
}

export function inferTopicFromTask(task: string, briefs: BriefRecord[]): string | undefined {
	const scored = briefs
		.map((brief) => ({topic: brief.topic, score: scoreBriefMatch(brief, task)}))
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score);

	if (scored.length > 0) {
		if (scored.length === 1 || scored[0].score > scored[1].score) return scored[0].topic;
		return undefined;
	}

	return deriveTopicFromTask(task);
}

export function resolveEnsureTopic(params: {
	requestedTopic?: string;
	task: string;
	briefs: BriefRecord[];
	state: FocusedContextState;
}): string | undefined {
	if (params.requestedTopic?.trim()) return normalizeTopic(params.requestedTopic);
	if (params.state.pinnedTopic) return params.state.pinnedTopic;
	if (params.state.activeTopic) return params.state.activeTopic;
	return inferTopicFromTask(params.task, params.briefs);
}

export function resolveAutoTopicForInput(params: {
	inputText: string;
	briefs: BriefRecord[];
	state: FocusedContextState;
}): string | undefined {
	if (params.state.pinnedTopic) return params.state.pinnedTopic;
	const inferred = inferTopicFromTask(params.inputText, params.briefs);
	if (!inferred) return undefined;
	return params.briefs.some((brief) => brief.topic === inferred) ? inferred : undefined;
}

function limitSectionContent(content: string | undefined): string | undefined {
	if (!content?.trim()) return undefined;
	const lines = content
		.trim()
		.split("\n")
		.map((line) => line.trimEnd())
		.filter(Boolean)
		.slice(0, ENSURE_SECTION_MAX_LINES)
		.join("\n");
	return truncateText(lines, ENSURE_SECTION_MAX_CHARS);
}

export function renderBriefEnsureText(params: {
	brief: BriefRecord;
	action: EnsureAction;
	freshness: "fresh" | "stale";
	maxChars?: number;
}): {text: string; truncated: boolean} {
	const sections: Array<[string, string | undefined]> = [
		[
			"Topic",
			[
				`- selected: ${params.brief.topic}`,
				`- freshness: ${params.freshness}`,
				`- action: ${params.action}`,
			].join("\n"),
		],
		["Objective", limitSectionContent(extractSection(params.brief.body, "Objective"))],
		["Stable Facts", limitSectionContent(extractSection(params.brief.body, "Stable Facts"))],
		["Hot Files", limitSectionContent(extractSection(params.brief.body, "Hot Files"))],
		["Common Commands", limitSectionContent(extractSection(params.brief.body, "Common Commands"))],
		["Gotchas", limitSectionContent(extractSection(params.brief.body, "Gotchas"))],
		["Next Slice", limitSectionContent(extractSection(params.brief.body, "Next Slice"))],
	];

	const text = sections
		.filter(([, content]) => Boolean(content))
		.map(([heading, content]) => `## ${heading}\n${content}`)
		.join("\n\n");
	const maxChars = params.maxChars ?? ENSURE_MAX_TOTAL_CHARS;
	const finalText = truncateText(text, maxChars);
	return {text: finalText, truncated: finalText.length < text.length};
}

export function serializeCompactionMessages(messages: unknown[]): string {
	if (messages.length === 0) return "";
	try {
		return serializeConversation(convertToLlm(messages as any));
	} catch {
		return "";
	}
}

export function buildFocusedCompactionSummary(params: {
	brief: BriefRecord;
	reasons: StaleReason[];
	recentMessages: unknown[];
	previousSummary?: string;
	customInstructions?: string;
	latestHandoffText?: string;
}): string {
	const durableContext = renderBriefEnsureText({
		brief: params.brief,
		action: "reused",
		freshness: params.reasons.length > 0 ? "stale" : getFreshnessLabel(params.brief),
		maxChars: COMPACTION_BRIEF_MAX_CHARS,
	}).text;
	const recentDelta = truncateText(
		serializeCompactionMessages(params.recentMessages) || "No recent delta was captured before compaction.",
		COMPACTION_RECENT_DELTA_MAX_CHARS,
	);
	const sections = [
		"## Goal",
		`Continue work on topic \`${params.brief.topic}\` after compaction without rediscovering durable context.`,
		"",
		"## Constraints & Preferences",
		"- Treat the focused-context brief below as durable topic context.",
		"- Prefer the recent delta below over re-reading the whole work area.",
		"- Refresh the brief only if the recent delta materially changed the durable facts.",
		params.customInstructions?.trim()
			? `- Compaction note: ${truncateText(params.customInstructions, COMPACTION_CUSTOM_INSTRUCTIONS_MAX_CHARS)}`
			: undefined,
		"",
		"## Progress",
		"### Done",
		`- Active brief identity preserved for \`${params.brief.topic}\`.`,
		"",
		"### In Progress",
		`- Resume the current \`${params.brief.topic}\` slice using the recent delta below.`,
		"",
		"### Blocked",
		"- None recorded by focused-context compaction.",
		"",
		"## Key Decisions",
		"- **Durable context is externalized**: keep the topic brief and summarize only the recent delta.",
		"",
		"## Next Steps",
		`1. Use the durable topic context for \`${params.brief.topic}\` as the baseline.`,
		"2. Continue from the recent delta summary instead of rediscovering the area.",
		"3. If the delta conflicts with the brief, run `brief_ensure` or `/brief-refresh`.",
		"",
		"## Critical Context",
		"### Durable Topic Context",
		durableContext,
		params.previousSummary?.trim()
			? `\n### Previous Compaction Summary\n${truncateText(params.previousSummary, COMPACTION_PREVIOUS_SUMMARY_MAX_CHARS)}`
			: undefined,
		params.latestHandoffText?.trim()
			? `\n### Latest Handoff Context\n${truncateText(params.latestHandoffText, COMPACTION_HANDOFF_MAX_CHARS)}`
			: undefined,
		"\n### Recent Delta",
		recentDelta,
	];

	return sections.filter(Boolean).join("\n").trim();
}

export function buildFocusedCompactionDetails(params: {
	brief: BriefRecord;
	reasons: StaleReason[];
	latestHandoffText?: string;
}): {
	activeTopic: string;
	staleReasons: StaleReason[];
	latestHandoffAvailable: boolean;
} {
	return {
		activeTopic: params.brief.topic,
		staleReasons: [...params.reasons],
		latestHandoffAvailable: Boolean(params.latestHandoffText?.trim()),
	};
}

export function createFocusedContextExtension(deps: FocusedContextDeps = {}) {
	const runRefresh =
		deps.refreshBriefForTopic ??
		((params: {ctx: ExtensionContext; topic: string; brief?: BriefRecord; latestHandoffText?: string}) =>
			refreshBrief(params));

	return function focusedContextExtension(pi: ExtensionAPI) {
		let currentState: FocusedContextState = {};
		let driftState = createEmptyDriftState();
		let currentCtx: ExtensionContext | undefined;
		let carryoverSnapshot: {state: FocusedContextState; reasons: StaleReason[]} = {state: {}, reasons: []};
		let pendingHandoffState: LatestHandoffState | undefined;
		let awaitingHandoffPromptCapture = false;
		let pendingRawInput: string | undefined;
		let currentTurnBriefText: string | undefined;

		function clearTurnInjection(): void {
			pendingRawInput = undefined;
			currentTurnBriefText = undefined;
		}

		function resetDriftState(): void {
			driftState = createEmptyDriftState();
		}

		function rememberCarryoverSnapshot(): void {
			carryoverSnapshot = {
				state: normalizeState({
					activeTopic: currentState.activeTopic,
					pinnedTopic: currentState.pinnedTopic,
					latestHandoff: currentState.latestHandoff,
				}),
				reasons: getDriftReasons(driftState),
			};
		}

		async function applyPendingHandoffState(ctx: ExtensionContext): Promise<void> {
			if (!pendingHandoffState) return;
			if (!matchesHandoffSession(pendingHandoffState, getSessionIdentity(ctx))) return;

			const nextState: FocusedContextState = {
				activeTopic: pendingHandoffState.activeTopic ?? currentState.activeTopic,
				pinnedTopic: pendingHandoffState.pinnedTopic ?? currentState.pinnedTopic,
				latestHandoff: pendingHandoffState,
			};
			persistState(nextState);
		}

		function noteTopicSelection(topic: string, options?: {markTransition?: boolean; resetWindow?: boolean}): void {
			const previousTopic = currentState.activeTopic;
			if (options?.markTransition && previousTopic && previousTopic !== topic) {
				driftState.topicTransitionCount += 1;
				driftState.recentExplorationKeys = [];
				driftState.changedHotPaths = [];
				driftState.turnsSinceRefresh = 0;
				driftState.lastRecommendationKey = undefined;
			}
			if (options?.resetWindow) {
				driftState.turnsSinceRefresh = 0;
				driftState.recentExplorationKeys = [];
				driftState.changedHotPaths = [];
				driftState.lastRecommendationKey = undefined;
			}
		}

		async function loadAvailableBriefs(ctx: ExtensionContext): Promise<BriefRecord[]> {
			return loadBriefs(ctx.cwd);
		}

		async function resolveActiveBrief(ctx: ExtensionContext): Promise<BriefRecord | undefined> {
			const briefs = await loadAvailableBriefs(ctx);
			return findBriefByTopicOrAlias(briefs, currentState.pinnedTopic ?? currentState.activeTopic);
		}

		async function resolveStatusSnapshot(
			ctx: ExtensionContext,
		): Promise<{brief: BriefRecord | undefined; reasons: StaleReason[]}> {
			const brief = await resolveActiveBrief(ctx);
			if (!brief) return {brief: undefined, reasons: []};
			return {brief, reasons: getDriftReasons(driftState)};
		}

		async function updateStatus(ctx: ExtensionContext, briefOverride?: BriefRecord): Promise<void> {
			const snapshot = briefOverride
				? {brief: briefOverride, reasons: getDriftReasons(driftState)}
				: await resolveStatusSnapshot(ctx);
			ctx.ui.setStatus("focused-context", formatStatus(ctx, snapshot.brief, snapshot.reasons));
		}

		async function maybeRecommendFreshSession(ctx: ExtensionContext): Promise<void> {
			const snapshot = await resolveStatusSnapshot(ctx);
			if (!snapshot.brief || !shouldRecommendFreshSession(snapshot.reasons)) return;
			const recommendationKey = buildRecommendationKey({
				topic: snapshot.brief.topic,
				reasons: snapshot.reasons,
				changedHotPaths: driftState.changedHotPaths,
			});
			if (!recommendationKey || driftState.lastRecommendationKey === recommendationKey) return;
			driftState.lastRecommendationKey = recommendationKey;

			const command = buildSuggestedHandoffCommand({
				brief: snapshot.brief,
				reasons: snapshot.reasons,
				changedHotPaths: driftState.changedHotPaths,
			});
			const notice = buildRecommendationNotice({
				brief: snapshot.brief,
				reasons: snapshot.reasons,
				changedHotPaths: driftState.changedHotPaths,
			});

			setTimeout(() => {
				if (!ctx.hasUI) return;
				ctx.ui.setEditorText(command);
				ctx.ui.notify(notice, "info");
			}, 0);
		}

		function persistState(state: FocusedContextState): void {
			const normalized = normalizeState(state);
			const changed = stateFingerprint(normalized) !== stateFingerprint(currentState);
			currentState = normalized;
			rememberCarryoverSnapshot();
			if (changed) pi.appendEntry(STATE_ENTRY_TYPE, normalized);
		}

		async function listBriefs(ctx: ExtensionContext): Promise<void> {
			const briefs = await loadAvailableBriefs(ctx);
			const text = formatBriefList(briefs, currentState);
			if (ctx.hasUI) ctx.ui.setEditorText(text);
			ctx.ui.notify(
				briefs.length > 0 ? `Listed ${briefs.length} brief topic(s)` : "No focused-context briefs found",
				briefs.length > 0 ? "info" : "warning",
			);
		}

		async function showBrief(ctx: ExtensionContext): Promise<void> {
			const brief = await resolveActiveBrief(ctx);
			if (!brief) {
				ctx.ui.notify("No active brief. Use /brief-list and /brief-pin <topic> first.", "warning");
				return;
			}

			if (ctx.hasUI) ctx.ui.setEditorText(formatBriefView(brief));
			ctx.ui.notify(`Loaded brief for ${brief.topic}`, "info");
		}

		async function pinBrief(rawTopic: string, ctx: ExtensionContext): Promise<void> {
			const topic = rawTopic.trim();
			if (!topic) {
				ctx.ui.notify("Usage: /brief-pin <topic>", "warning");
				return;
			}

			const briefs = await loadAvailableBriefs(ctx);
			const brief = findBriefByTopicOrAlias(briefs, topic);
			if (!brief) {
				if (ctx.hasUI) ctx.ui.setEditorText(formatBriefList(briefs, currentState));
				ctx.ui.notify(`Unknown brief topic: ${topic}`, "warning");
				return;
			}

			if (currentState.activeTopic !== brief.topic) {
				noteTopicSelection(brief.topic, {resetWindow: true});
			}
			persistState({
				activeTopic: brief.topic,
				pinnedTopic: brief.topic,
				latestHandoff: currentState.latestHandoff,
			});
			await updateStatus(ctx);
			ctx.ui.notify(`Pinned brief topic: ${brief.topic}`, "info");
		}

		async function refreshTopic(rawTopic: string, ctx: ExtensionContext): Promise<void> {
			const requested = rawTopic.trim();
			const briefs = await loadAvailableBriefs(ctx);
			const existing = findBriefByTopicOrAlias(briefs, requested || currentState.activeTopic || currentState.pinnedTopic);
			const topic = existing?.topic ?? (requested ? normalizeTopic(requested) : undefined);

			if (!topic) {
				ctx.ui.notify("No active brief to refresh. Use /brief-refresh <topic> or pin a topic first.", "warning");
				return;
			}

			const result = await runRefresh({
				ctx,
				topic,
				brief: existing,
				latestHandoffText: renderLatestHandoffSource(currentState.latestHandoff),
			});
			if (!result.ok) {
				ctx.ui.notify(`Focused Context refresh failed: ${result.error}`, "warning");
				return;
			}

			noteTopicSelection(result.brief.topic, {resetWindow: true});
			persistState({
				activeTopic: result.brief.topic,
				pinnedTopic: currentState.pinnedTopic,
				latestHandoff: currentState.latestHandoff,
			});
			if (ctx.hasUI) ctx.ui.setEditorText(formatBriefView(result.brief));
			await updateStatus(ctx, result.brief);
			ctx.ui.notify(
				`${result.created ? "Created" : "Refreshed"} brief for ${result.brief.topic} using ${result.usedModel}`,
				"info",
			);
		}

		async function ensureBriefForTask(params: {
			ctx: ExtensionContext;
			task: string;
			requestedTopic?: string;
			policy: EnsureRefreshPolicy;
		}): Promise<
			| {ok: true; brief: BriefRecord; action: EnsureAction; usedModel?: string; modelSource?: "helper" | "active"; freshness: "fresh" | "stale"}
			| {ok: false; error: string}
		> {
			const briefs = await loadAvailableBriefs(params.ctx);
			const topic = resolveEnsureTopic({
				requestedTopic: params.requestedTopic,
				task: params.task,
				briefs,
				state: currentState,
			});
			if (!topic) {
				return {ok: false, error: "Unable to resolve a topic. Pass `topic` explicitly or pin a brief first."};
			}

			const existing = findBriefByTopicOrAlias(briefs, topic);
			if (!shouldRefreshBrief(existing, params.policy)) {
				return {ok: true, brief: existing!, action: "reused", freshness: getFreshnessLabel(existing)};
			}

			const refreshed = await runRefresh({
				ctx: params.ctx,
				topic,
				brief: existing,
				latestHandoffText: renderLatestHandoffSource(currentState.latestHandoff),
			});
			if (!refreshed.ok) return refreshed;
			return {
				ok: true,
				brief: refreshed.brief,
				action: refreshed.created ? "created" : "refreshed",
				freshness: getFreshnessLabel(refreshed.brief),
				usedModel: refreshed.usedModel,
				modelSource: refreshed.modelSource,
			};
		}

		async function autoPrepareBriefForInput(ctx: ExtensionContext, inputText: string): Promise<void> {
			const raw = inputText.trim();
			if (!raw) {
				currentTurnBriefText = undefined;
				return;
			}

			const briefs = await loadAvailableBriefs(ctx);
			const topic = resolveAutoTopicForInput({
				inputText: raw,
				briefs,
				state: currentState,
			});
			if (!topic) {
				currentTurnBriefText = undefined;
				return;
			}

			const ensured = await ensureBriefForTask({
				ctx,
				task: raw,
				requestedTopic: topic,
				policy: "if_stale",
			});
			if (!ensured.ok) {
				currentTurnBriefText = undefined;
				return;
			}

			noteTopicSelection(ensured.brief.topic, {
				markTransition: true,
				resetWindow: ensured.action === "created" || ensured.action === "refreshed",
			});
			persistState({
				activeTopic: ensured.brief.topic,
				pinnedTopic: currentState.pinnedTopic,
				latestHandoff: currentState.latestHandoff,
			});
			currentTurnBriefText = renderBriefEnsureText({
				brief: ensured.brief,
				action: ensured.action,
				freshness: ensured.freshness,
			}).text;
			await updateStatus(ctx, ensured.brief);
		}

		async function restoreAndSync(ctx: ExtensionContext): Promise<void> {
			rememberCarryoverSnapshot();
			currentCtx = ctx;
			clearTurnInjection();
			resetDriftState();
			currentState = normalizeState(restoreState(ctx));
			await applyPendingHandoffState(ctx);
			await updateStatus(ctx);
		}

		pi.registerCommand("brief-list", {
			description: "List available focused-context brief topics",
			handler: async (_args, ctx) => {
				await listBriefs(ctx);
			},
		});

		pi.registerCommand("brief-pin", {
			description: "Pin the active focused-context brief topic (usage: /brief-pin <topic>)",
			handler: async (args, ctx) => {
				await pinBrief(args, ctx);
			},
		});

		pi.registerCommand("brief-refresh", {
			description: "Refresh the active focused-context brief or create one for a topic (usage: /brief-refresh [topic])",
			handler: async (args, ctx) => {
				await refreshTopic(args, ctx);
			},
		});

		pi.registerCommand("brief", {
			description: "Show the active focused-context brief",
			handler: async (_args, ctx) => {
				await showBrief(ctx);
			},
		});

		pi.registerTool({
			name: "brief_ensure",
			label: "Brief Ensure",
			description:
				"Ensure a usable focused-context brief exists for a task. " +
				"Selects or infers a topic, creates or refreshes the brief when needed, and returns a compact task-relevant slice.",
			parameters: Type.Object({
				task: Type.String({description: "The task you are about to work on."}),
				topic: Type.Optional(Type.String({description: "Optional explicit topic name to use for the brief."})),
				refresh: Type.Optional(
					Type.Union([
						Type.Literal("always"),
						Type.Literal("if_stale"),
						Type.Literal("never"),
					]),
				),
			}),
			async execute(_toolCallId, params, _signal, onUpdate, ctx) {
				const task = params.task.trim();
				if (!task) {
					return {
						content: [{type: "text", text: "Error: task parameter is required."}],
						details: {error: true},
					};
				}

				const policy = normalizeRefreshPolicy(params.refresh);
				if (!policy) {
					return {
						content: [{type: "text", text: "Error: refresh must be one of always, if_stale, or never."}],
						details: {error: true},
					};
				}

				onUpdate?.({
					content: [{type: "text", text: `Ensuring focused-context brief for: ${task}`}],
					details: {},
				});

				const ensured = await ensureBriefForTask({
					ctx,
					task,
					requestedTopic: params.topic,
					policy,
				});
				if (!ensured.ok) {
					return {
						content: [{type: "text", text: `Error: ${ensured.error}`}],
						details: {error: true},
					};
				}

				noteTopicSelection(ensured.brief.topic, {
					markTransition: true,
					resetWindow: ensured.action === "created" || ensured.action === "refreshed",
				});
				persistState({
					activeTopic: ensured.brief.topic,
					pinnedTopic: currentState.pinnedTopic,
					latestHandoff: currentState.latestHandoff,
				});
				await updateStatus(ctx, ensured.brief);

				const rendered = renderBriefEnsureText({
					brief: ensured.brief,
					action: ensured.action,
					freshness: ensured.freshness,
				});

				return {
					content: [{type: "text", text: rendered.text}],
					details: {
						topic: ensured.brief.topic,
						action: ensured.action,
						freshness: ensured.freshness,
						policy,
						truncated: rendered.truncated,
						usedModel: ensured.usedModel,
						modelSource: ensured.modelSource,
					},
				};
			},
		});

		pi.on("input", async (event, ctx) => {
			currentCtx = ctx;
			clearTurnInjection();
			if (awaitingHandoffPromptCapture && event.source !== "extension" && event.text.trim() && pendingHandoffState) {
				pendingHandoffState = attachHandoffPromptText(pendingHandoffState, event.text);
				persistState({
					activeTopic: currentState.activeTopic,
					pinnedTopic: currentState.pinnedTopic,
					latestHandoff: pendingHandoffState,
				});
				awaitingHandoffPromptCapture = false;
			}
			pendingRawInput = event.source === "extension" ? "" : event.text;
			return {action: "continue" as const};
		});

		pi.on("before_agent_start", async (event, ctx) => {
			currentCtx = ctx;
			const rawInput = pendingRawInput !== undefined ? pendingRawInput : event.prompt;
			await autoPrepareBriefForInput(ctx, rawInput);
		});

		pi.on("context", async (event) => {
			if (!currentTurnBriefText) return;
			return {
				messages: [
					...event.messages,
					{
						role: "custom",
						customType: "focused-context-brief",
						content: currentTurnBriefText,
						display: false,
						timestamp: Date.now(),
					},
				],
			};
		});

		pi.on("tool_call", async (event, ctx) => {
			currentCtx = ctx;
			const brief = await resolveActiveBrief(ctx);
			if (!brief) return;

			if (event.toolName === "edit" || event.toolName === "write") {
				const path = typeof (event.input as {path?: unknown}).path === "string" ? (event.input as {path?: string}).path : undefined;
				driftState.changedHotPaths = noteHotPathChange(
					ctx.cwd,
					[...brief.hotFiles, ...brief.hotDocs],
					path,
					driftState.changedHotPaths,
				);
				await updateStatus(ctx);
				return;
			}

			const explorationKey = buildExplorationKey(event.toolName, event.input as Record<string, unknown> | undefined);
			driftState.recentExplorationKeys = noteExplorationKey(driftState.recentExplorationKeys, explorationKey);
			await updateStatus(ctx);
		});

		pi.on("turn_end", async (_event, ctx) => {
			currentCtx = ctx;
			const brief = await resolveActiveBrief(ctx);
			if (brief) driftState.turnsSinceRefresh += 1;
			await updateStatus(ctx);
			await maybeRecommendFreshSession(ctx);
			clearTurnInjection();
		});

		pi.on("session_before_compact", async (event, ctx) => {
			currentCtx = ctx;
			const brief = await resolveActiveBrief(ctx);
			if (!brief) return;

			const reasons = getDriftReasons(driftState);
			const latestHandoffText = renderLatestHandoffSource(currentState.latestHandoff);
			const recentMessages = [
				...(event.preparation?.messagesToSummarize ?? []),
				...(event.preparation?.turnPrefixMessages ?? []),
			];
			const summary = buildFocusedCompactionSummary({
				brief,
				reasons,
				recentMessages,
				previousSummary: event.preparation?.previousSummary,
				customInstructions: event.customInstructions,
				latestHandoffText,
			});

			return {
				compaction: {
					summary,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: buildFocusedCompactionDetails({
						brief,
						reasons,
						latestHandoffText,
					}),
				},
			};
		});

		pi.on("session_compact", async (_event, ctx) => {
			currentCtx = ctx;
			await updateStatus(ctx);
		});

		pi.on("session_start", async (_event, ctx) => {
			await restoreAndSync(ctx);
		});

		pi.on("session_switch", async (_event, ctx) => {
			await restoreAndSync(ctx);
		});

		pi.events.on(HANDOFF_SESSION_STARTED_EVENT, async (payload: HandoffSessionStartedEvent) => {
			const sourceState =
				currentState.activeTopic || currentState.pinnedTopic || currentState.latestHandoff
					? currentState
					: carryoverSnapshot.state;
			const sourceReasons =
				currentState.activeTopic || currentState.pinnedTopic ? getDriftReasons(driftState) : carryoverSnapshot.reasons;
			pendingHandoffState = createLatestHandoffState({
				event: payload,
				activeTopic: sourceState.activeTopic,
				pinnedTopic: sourceState.pinnedTopic,
				staleReasons: sourceReasons,
			});
			awaitingHandoffPromptCapture = true;
			if (currentCtx) {
				await applyPendingHandoffState(currentCtx);
				await updateStatus(currentCtx);
			}
		});
	};
}

export default createFocusedContextExtension();
