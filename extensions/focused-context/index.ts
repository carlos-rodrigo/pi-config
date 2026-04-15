import {existsSync, readFileSync} from "node:fs";

import {complete, type Message} from "@mariozechner/pi-ai";
import {
	SessionManager,
	buildSessionContext,
	convertToLlm,
	serializeConversation,
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {Type} from "@sinclair/typebox";

import {HANDOFF_SESSION_STARTED_EVENT, type HandoffSessionStartedEvent} from "../handoff/events.ts";
import {
	describeModel,
	extractSection,
	refreshBrief,
	resolveRefreshModel,
	truncateText,
	type RefreshBriefResult,
	type RefreshSource,
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

type CaptureTopicResult =
	| {ok: true; topic: string}
	| {ok: false; error: string};

export type FocusedContextDeps = {
	refreshBriefForTopic?: (params: {
		ctx: ExtensionContext;
		topic: string;
		brief?: BriefRecord;
		sessionSources?: RefreshSource[];
		latestHandoffText?: string;
	}) => Promise<RefreshBriefResult>;
	captureTopicFromSessionHistory?: (params: {
		ctx: ExtensionContext;
		briefs: BriefRecord[];
		sessionSources: RefreshSource[];
		latestHandoffText?: string;
	}) => Promise<CaptureTopicResult>;
	openBriefFile?: (brief: BriefRecord, ctx: ExtensionContext) => Promise<void>;
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
const CAPTURE_MAX_LINEAGE_SESSIONS = 4;
const CAPTURE_SESSION_SOURCE_MAX_CHARS = 3_000;
const CAPTURE_TOPIC_SYSTEM_PROMPT = `You infer a single durable focused-context topic from coding session history.
Return ONLY JSON in one of these forms:
{"topic":"kebab-case-topic"}
{"error":"ambiguous"}

Rules:
- Prefer an existing topic when one clearly matches the session history.
- Topic must be durable and specific: feature, subsystem, workflow, or module.
- Use 1-4 words in lowercase kebab-case.
- Do not return prose, markdown, explanations, or code fences.`;
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

function scoreBriefLookupCandidate(candidate: string, normalizedQuery: string, queryTokens: string[]): number {
	let score = 0;
	if (candidate === normalizedQuery) return 1000;
	if (candidate.startsWith(normalizedQuery)) score = Math.max(score, 800);
	else if (candidate.includes(normalizedQuery)) score = Math.max(score, 650);

	const candidateTokens = candidate.split(/[-_\s]+/).filter(Boolean);
	let exactMatches = 0;
	let prefixMatches = 0;
	let containsMatches = 0;

	for (const token of queryTokens) {
		if (candidateTokens.some((part) => part === token)) {
			exactMatches += 1;
			prefixMatches += 1;
			containsMatches += 1;
			continue;
		}
		if (candidateTokens.some((part) => part.startsWith(token))) {
			prefixMatches += 1;
			containsMatches += 1;
			continue;
		}
		if (candidateTokens.some((part) => part.includes(token))) {
			containsMatches += 1;
		}
	}

	if (queryTokens.length > 0) {
		if (exactMatches === queryTokens.length) score = Math.max(score, 760 + exactMatches * 10);
		else if (prefixMatches === queryTokens.length) score = Math.max(score, 720 + prefixMatches * 10);
		else if (containsMatches === queryTokens.length) score = Math.max(score, 660 + containsMatches * 10);
	}

	return score + exactMatches * 30 + (prefixMatches - exactMatches) * 18 + (containsMatches - prefixMatches) * 8;
}

function resolveBriefLookup(briefs: BriefRecord[], query: string): {brief?: BriefRecord; matches: BriefRecord[]} {
	const normalizedQuery = normalizeTopicCandidate(query);
	if (!normalizedQuery) return {matches: []};

	const exactMatches = briefs.filter((brief) => brief.topic === normalizedQuery || brief.aliases.includes(normalizedQuery));
	if (exactMatches.length === 1) return {brief: exactMatches[0], matches: exactMatches};
	if (exactMatches.length > 1) return {matches: exactMatches};

	const queryTokens = normalizedQuery.split("-").filter(Boolean);
	const ranked = briefs
		.map((brief) => ({
			brief,
			score: Math.max(brief.topic ? scoreBriefLookupCandidate(brief.topic, normalizedQuery, queryTokens) : 0, ...brief.aliases.map((alias) => scoreBriefLookupCandidate(alias, normalizedQuery, queryTokens))),
		}))
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score || left.brief.topic.localeCompare(right.brief.topic));

	if (ranked.length === 0) return {matches: []};
	if (ranked.length === 1 || ranked[0].score > ranked[1].score) return {brief: ranked[0].brief, matches: ranked.map((entry) => entry.brief)};
	return {matches: ranked.filter((entry) => entry.score === ranked[0].score).map((entry) => entry.brief)};
}

function resolveRequestedTopicInput(briefs: BriefRecord[], query: string): {topic?: string; brief?: BriefRecord; matches: BriefRecord[]} {
	const lookup = resolveBriefLookup(briefs, query);
	if (lookup.brief) return {topic: lookup.brief.topic, brief: lookup.brief, matches: lookup.matches};
	if (lookup.matches.length > 1) return {matches: lookup.matches};
	const normalized = normalizeTopicCandidate(query);
	return normalized ? {topic: normalized, matches: []} : {matches: []};
}

function normalizeTopicCandidate(value: string): string | undefined {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || undefined;
}

function getSessionHeader(sessionFile: string): {parentSession?: string} | null {
	try {
		if (!existsSync(sessionFile)) return null;
		const content = readFileSync(sessionFile, "utf8");
		const firstNewline = content.indexOf("\n");
		const firstLine = (firstNewline === -1 ? content : content.slice(0, firstNewline)).trim();
		if (!firstLine) return null;
		const parsed = JSON.parse(firstLine) as {type?: string; parentSession?: string};
		return parsed.type === "session" ? parsed : null;
	} catch {
		return null;
	}
}

function serializeSessionMessages(messages: unknown[]): string {
	if (messages.length === 0) return "";
	try {
		return serializeConversation(convertToLlm(messages as any));
	} catch {
		return "";
	}
}

function getParentSessionFiles(currentSessionFile: string | undefined, fallbackParentSessionFile?: string): string[] {
	const lineage: string[] = [];
	const visited = new Set<string>();
	let current = currentSessionFile ? getSessionHeader(currentSessionFile)?.parentSession : fallbackParentSessionFile;
	if (!current && fallbackParentSessionFile) current = fallbackParentSessionFile;

	while (current && !visited.has(current) && lineage.length < CAPTURE_MAX_LINEAGE_SESSIONS - 1) {
		visited.add(current);
		lineage.push(current);
		current = getSessionHeader(current)?.parentSession;
	}

	return lineage;
}

function labelCapturedSession(index: number): string {
	if (index === 0) return "parent-session";
	return `ancestor-session-${index}`;
}

async function collectCaptureSessionSources(
	ctx: ExtensionContext,
	fallbackParentSessionFile?: string,
): Promise<RefreshSource[]> {
	const sessionSources: RefreshSource[] = [];
	const rawSessionManager = ctx.sessionManager as ExtensionContext["sessionManager"] & {
		buildSessionContext?: () => {messages: unknown[]};
		getBranch?: () => unknown[];
		getLeafId?: () => string;
		getSessionFile?: () => string | undefined;
	};

	let currentSessionText = "";
	if (rawSessionManager.buildSessionContext) {
		try {
			const built = rawSessionManager.buildSessionContext();
			currentSessionText = serializeSessionMessages(built.messages ?? []);
		} catch {
			currentSessionText = "";
		}
	} else if (rawSessionManager.getBranch && rawSessionManager.getLeafId) {
		try {
			const built = buildSessionContext(rawSessionManager.getBranch(), rawSessionManager.getLeafId());
			currentSessionText = serializeSessionMessages(built.messages ?? []);
		} catch {
			currentSessionText = "";
		}
	}

	if (currentSessionText.trim()) {
		sessionSources.push({
			label: "current-session",
			content: truncateText(currentSessionText, CAPTURE_SESSION_SOURCE_MAX_CHARS),
			path: rawSessionManager.getSessionFile?.(),
		});
	}

	const parentSessionFiles = getParentSessionFiles(rawSessionManager.getSessionFile?.(), fallbackParentSessionFile);
	for (let i = 0; i < parentSessionFiles.length; i++) {
		try {
			const sessionManager = SessionManager.open(parentSessionFiles[i]);
			const built = sessionManager.buildSessionContext();
			const text = serializeSessionMessages(built.messages ?? []);
			if (!text.trim()) continue;
			sessionSources.push({
				label: labelCapturedSession(i),
				content: truncateText(text, CAPTURE_SESSION_SOURCE_MAX_CHARS),
				path: parentSessionFiles[i],
			});
		} catch {
			// Skip unreadable ancestor sessions.
		}
	}

	return sessionSources;
}

function buildCaptureTopicPrompt(params: {
	briefs: BriefRecord[];
	sessionSources: RefreshSource[];
	latestHandoffText?: string;
}): string {
	const briefHints =
		params.briefs.length > 0
			? params.briefs
					.slice(0, 20)
					.map((brief) => `- ${brief.topic}${brief.aliases.length > 0 ? ` (aliases: ${brief.aliases.join(", ")})` : ""}`)
					.join("\n")
			: "- none";
	const sourceText = params.sessionSources.map((source) => `### ${source.label}\n${source.content}`).join("\n\n");
	const handoffText = params.latestHandoffText?.trim()
		? `\n\n### latest-handoff\n${truncateText(params.latestHandoffText, CAPTURE_SESSION_SOURCE_MAX_CHARS)}`
		: "";
	return [
		"Infer the best focused-context topic for this work history.",
		"",
		"Known briefs:",
		briefHints,
		"",
		"Session history:",
		sourceText || "### current-session\nNo session history available.",
		`${handoffText}`,
	].join("\n");
}

function extractTextContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is {type?: string; text?: string} => typeof part?.text === "string")
		.map((part) => part.text!.trim())
		.filter(Boolean)
		.join("\n")
		.trim();
}

async function inferCaptureTopicFromSessionHistory(params: {
	ctx: ExtensionContext;
	briefs: BriefRecord[];
	sessionSources: RefreshSource[];
	latestHandoffText?: string;
}): Promise<CaptureTopicResult> {
	const heuristicTopic = inferTopicFromTask(
		[
			...params.sessionSources.map((source) => source.content),
			params.latestHandoffText ?? "",
		].join("\n\n"),
		params.briefs,
	);
	const resolved = await resolveRefreshModel(params.ctx);
	if ("error" in resolved) {
		return heuristicTopic
			? {ok: true, topic: heuristicTopic}
			: {ok: false, error: "Unable to infer a topic automatically. Use /brief-capture <topic>."};
	}

	try {
		const response = await complete(
			resolved.model as any,
			{
				systemPrompt: CAPTURE_TOPIC_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [{type: "text", text: buildCaptureTopicPrompt(params)}],
						timestamp: Date.now(),
					} satisfies Message,
				],
			},
			{apiKey: resolved.apiKey},
		);

		if (response.stopReason === "error") {
			return heuristicTopic
				? {ok: true, topic: heuristicTopic}
				: {ok: false, error: "Unable to infer a topic automatically. Use /brief-capture <topic>."};
		}

		const text = extractTextContent(response.content);
		let parsedTopic: string | undefined;
		try {
			const parsed = JSON.parse(text) as {topic?: unknown; error?: unknown};
			if (typeof parsed.topic === "string") parsedTopic = normalizeTopicCandidate(parsed.topic);
		} catch {
			parsedTopic = normalizeTopicCandidate(text.split(/\r?\n/, 1)[0] ?? "");
		}

		if (parsedTopic) return {ok: true, topic: parsedTopic};
		if (heuristicTopic) return {ok: true, topic: heuristicTopic};
		return {ok: false, error: `Unable to infer a single topic from session history using ${describeModel(resolved.model)}.`};
	} catch {
		return heuristicTopic
			? {ok: true, topic: heuristicTopic}
			: {ok: false, error: "Unable to infer a topic automatically. Use /brief-capture <topic>."};
	}
}

export function resolveEnsureTopic(params: {
	requestedTopic?: string;
	task: string;
	briefs: BriefRecord[];
	state: FocusedContextState;
}): string | undefined {
	if (params.requestedTopic?.trim()) {
		const resolved = resolveRequestedTopicInput(params.briefs, params.requestedTopic);
		if (!resolved.topic || resolved.matches.length > 1) return undefined;
		return resolved.topic;
	}
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
		((params: {
			ctx: ExtensionContext;
			topic: string;
			brief?: BriefRecord;
			sessionSources?: RefreshSource[];
			latestHandoffText?: string;
		}) => refreshBrief(params));
	const runCaptureTopic = deps.captureTopicFromSessionHistory ?? ((params: {
		ctx: ExtensionContext;
		briefs: BriefRecord[];
		sessionSources: RefreshSource[];
		latestHandoffText?: string;
	}) => inferCaptureTopicFromSessionHistory(params));
	const openBriefFile = deps.openBriefFile ?? (async (brief: BriefRecord, ctx: ExtensionContext) => {
		const content = readFileSync(brief.path, "utf8");
		const fileOpener = await import("../file-opener/index.ts");
		await fileOpener.openFileOverlay(brief.path, content, ctx);
	});

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
				driftState.topicTransitionCount = 0;
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

		async function showBrief(rawQuery: string, ctx: ExtensionContext): Promise<void> {
			const query = rawQuery.trim();
			const briefs = query ? await loadAvailableBriefs(ctx) : undefined;
			const lookup = query && briefs ? resolveBriefLookup(briefs, query) : undefined;
			const brief = lookup?.brief ?? (query ? undefined : await resolveActiveBrief(ctx));
			if (!brief) {
				if (query) {
					if (lookup && lookup.matches.length > 1 && ctx.hasUI) ctx.ui.setEditorText(formatBriefList(lookup.matches, currentState));
					else if (briefs && ctx.hasUI) ctx.ui.setEditorText(formatBriefList(briefs, currentState));
					ctx.ui.notify(
						lookup && lookup.matches.length > 1
							? `Ambiguous brief query: ${query}. Be more specific.`
							: `No brief matched: ${query}. Use /brief-list to browse topics.`,
						"warning",
					);
					return;
				}
				ctx.ui.notify("No active brief. Use /brief-list and /brief-pin <topic> first.", "warning");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.setEditorText(formatBriefView(brief));
				ctx.ui.notify(`Loaded brief for ${brief.topic}`, "info");
				return;
			}

			await openBriefFile(brief, ctx);
			ctx.ui.notify(`Opened brief for ${brief.topic}`, "info");
		}

		async function pinBrief(rawTopic: string, ctx: ExtensionContext): Promise<void> {
			const topic = rawTopic.trim();
			if (!topic) {
				ctx.ui.notify("Usage: /brief-pin <topic>", "warning");
				return;
			}

			const briefs = await loadAvailableBriefs(ctx);
			const lookup = resolveBriefLookup(briefs, topic);
			const brief = lookup.brief;
			if (!brief) {
				if (lookup.matches.length > 1 && ctx.hasUI) ctx.ui.setEditorText(formatBriefList(lookup.matches, currentState));
				else if (ctx.hasUI) ctx.ui.setEditorText(formatBriefList(briefs, currentState));
				ctx.ui.notify(
					lookup.matches.length > 1
						? `Ambiguous brief query: ${topic}. Be more specific.`
						: `No brief matched: ${topic}. Use /brief-list to browse topics.`,
					"warning",
				);
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

		async function createTopic(rawTopic: string, ctx: ExtensionContext): Promise<void> {
			const requested = rawTopic.trim();
			if (!requested) {
				ctx.ui.notify("Usage: /brief-new <topic>", "warning");
				return;
			}

			const briefs = await loadAvailableBriefs(ctx);
			const resolved = resolveRequestedTopicInput(briefs, requested);
			if (resolved.matches.length > 1 && !resolved.brief) {
				if (ctx.hasUI) ctx.ui.setEditorText(formatBriefList(resolved.matches, currentState));
				ctx.ui.notify(`Ambiguous brief query: ${requested}. Be more specific.`, "warning");
				return;
			}
			if (resolved.brief) {
				if (ctx.hasUI) ctx.ui.setEditorText(formatBriefView(resolved.brief));
				ctx.ui.notify(`Brief already exists for ${resolved.brief.topic}. Use /brief-refresh to update it.`, "warning");
				return;
			}
			if (!resolved.topic) {
				ctx.ui.notify("Usage: /brief-new <topic>", "warning");
				return;
			}

			const result = await runRefresh({
				ctx,
				topic: resolved.topic,
				latestHandoffText: renderLatestHandoffSource(currentState.latestHandoff),
			});
			if (!result.ok) {
				ctx.ui.notify(`Focused Context refresh failed: ${result.error}`, "warning");
				return;
			}

			noteTopicSelection(result.brief.topic, {resetWindow: true});
			persistState({
				activeTopic: result.brief.topic,
				pinnedTopic: undefined,
				latestHandoff: currentState.latestHandoff,
			});
			await updateStatus(ctx, result.brief);
			postBriefActionMessage(
				`${result.created ? "Created" : "Refreshed"} brief for ${result.brief.topic}. Use /brief to view it.`,
				{action: result.created ? "created" : "refreshed", topic: result.brief.topic, path: result.brief.path},
			);
			ctx.ui.notify(
				`${result.created ? "Created" : "Refreshed"} brief for ${result.brief.topic} using ${result.usedModel}`,
				"info",
			);
		}

		async function refreshTopic(rawTopic: string, ctx: ExtensionContext): Promise<void> {
			if (rawTopic.trim()) {
				ctx.ui.notify(
					"Usage: /brief-refresh (refreshes the current brief). Use /brief-new <topic> to create a new brief.",
					"warning",
				);
				return;
			}

			const briefs = await loadAvailableBriefs(ctx);
			const existing = findBriefByTopicOrAlias(briefs, currentState.pinnedTopic ?? currentState.activeTopic);
			if (!existing) {
				ctx.ui.notify("No active brief to refresh. Use /brief-new <topic> or /brief-pin <topic> first.", "warning");
				return;
			}

			const result = await runRefresh({
				ctx,
				topic: existing.topic,
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
			await updateStatus(ctx, result.brief);
			postBriefActionMessage(
				`Refreshed brief for ${result.brief.topic}. Use /brief to view it.`,
				{action: "refreshed", topic: result.brief.topic, path: result.brief.path},
			);
			ctx.ui.notify(`Refreshed brief for ${result.brief.topic} using ${result.usedModel}`, "info");
		}

		async function captureTopicHistory(rawTopic: string, ctx: ExtensionContext): Promise<void> {
			const briefs = await loadAvailableBriefs(ctx);
			const latestHandoffText = renderLatestHandoffSource(currentState.latestHandoff);
			const sessionSources = await collectCaptureSessionSources(ctx, currentState.latestHandoff?.previousSessionFile);
			if (sessionSources.length === 0 && !latestHandoffText?.trim()) {
				ctx.ui.notify(
					"No session history available to capture. Use /brief-new <topic> to create a brief manually.",
					"warning",
				);
				return;
			}

			const requested = rawTopic.trim();
			let topic: string | undefined;
			let existing: BriefRecord | undefined;
			if (requested) {
				const resolved = resolveRequestedTopicInput(briefs, requested);
				if (resolved.matches.length > 1 && !resolved.brief) {
					if (ctx.hasUI) ctx.ui.setEditorText(formatBriefList(resolved.matches, currentState));
					ctx.ui.notify(`Ambiguous brief query: ${requested}. Be more specific.`, "warning");
					return;
				}
				topic = resolved.topic;
				existing = resolved.brief;
				if (!topic) {
					ctx.ui.notify("Usage: /brief-capture [topic]", "warning");
					return;
				}
			} else {
				const captured = await runCaptureTopic({
					ctx,
					briefs,
					sessionSources,
					latestHandoffText,
				});
				if (!captured.ok) {
					ctx.ui.notify(`${captured.error} Use /brief-capture <topic> to override.`, "warning");
					return;
				}
				topic = captured.topic;
				existing = findBriefByTopicOrAlias(briefs, topic);
			}

			const result = await runRefresh({
				ctx,
				topic: existing?.topic ?? topic,
				brief: existing,
				sessionSources,
				latestHandoffText,
			});
			if (!result.ok) {
				ctx.ui.notify(`Focused Context capture failed: ${result.error}`, "warning");
				return;
			}

			noteTopicSelection(result.brief.topic, {resetWindow: true});
			persistState({
				activeTopic: result.brief.topic,
				pinnedTopic: currentState.pinnedTopic === result.brief.topic ? currentState.pinnedTopic : undefined,
				latestHandoff: currentState.latestHandoff,
			});
			await updateStatus(ctx, result.brief);
			postBriefActionMessage(
				`${result.created ? "Created" : "Refreshed"} brief for ${result.brief.topic} from session history. Use /brief to view it.`,
				{action: result.created ? "created" : "refreshed", topic: result.brief.topic, path: result.brief.path, source: "session-history"},
			);
			ctx.ui.notify(
				`${result.created ? "Created" : "Refreshed"} brief for ${result.brief.topic} from session history using ${result.usedModel}`,
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
			const explicit = params.requestedTopic?.trim() ? resolveRequestedTopicInput(briefs, params.requestedTopic) : undefined;
			if (explicit && explicit.matches.length > 1 && !explicit.brief) {
				return {ok: false, error: `Ambiguous brief query: ${params.requestedTopic!.trim()}. Be more specific.`};
			}
			const topic = explicit?.topic ?? resolveEnsureTopic({
				requestedTopic: params.requestedTopic,
				task: params.task,
				briefs,
				state: currentState,
			});
			if (!topic) {
				return {ok: false, error: "Unable to resolve a topic. Pass `topic` explicitly or pin a brief first."};
			}

			const existing = explicit?.brief ?? findBriefByTopicOrAlias(briefs, topic);
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

		function postBriefActionMessage(content: string, details: Record<string, unknown>): void {
			pi.sendMessage({
				customType: "focused-context",
				content,
				display: true,
				details,
			});
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
			description: "Pin the active focused-context brief topic (usage: /brief-pin <topic-or-query>)",
			handler: async (args, ctx) => {
				await pinBrief(args, ctx);
			},
		});

		pi.registerCommand("brief-new", {
			description: "Create a focused-context brief for a topic (usage: /brief-new <topic>)",
			handler: async (args, ctx) => {
				await createTopic(args, ctx);
			},
		});

		pi.registerCommand("brief-refresh", {
			description: "Refresh the current focused-context brief (usage: /brief-refresh)",
			handler: async (args, ctx) => {
				await refreshTopic(args, ctx);
			},
		});

		pi.registerCommand("brief-capture", {
			description: "Capture a brief from the current session history (usage: /brief-capture [topic])",
			handler: async (args, ctx) => {
				await captureTopicHistory(args, ctx);
			},
		});

		pi.registerCommand("brief", {
			description: "Show the active focused-context brief or open a topic via /brief <query>",
			handler: async (args, ctx) => {
				await showBrief(args, ctx);
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
