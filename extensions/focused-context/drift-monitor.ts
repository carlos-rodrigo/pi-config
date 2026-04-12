import {resolve} from "node:path";

import {extractSection, truncateText} from "./brief-engine.ts";
import type {BriefRecord} from "./brief-store.ts";

export type StaleReason = "T" | "C" | "R" | "H";

export type DriftSignals = {
	turnsSinceRefresh: number;
	changedHotPaths: string[];
	recentExplorationKeys: string[];
	topicTransitionCount: number;
};

export const SESSION_TURN_DRIFT_THRESHOLD = 3;
export const EXPLORATION_WINDOW_SIZE = 6;
export const EXPLORATION_REPEAT_THRESHOLD = 3;

const STALE_REASON_ORDER: StaleReason[] = ["T", "C", "R", "H"];
const HANDOFF_COMMAND_MAX_CHARS = 340;
const NOTICE_MAX_CHARS = 220;
const MAX_CHANGED_PATHS = 3;

export function normalizeStaleReasons(reasons: Iterable<StaleReason>): StaleReason[] {
	const seen = new Set(reasons);
	return STALE_REASON_ORDER.filter((reason) => seen.has(reason));
}

export function formatStaleReasonLabel(reasons: Iterable<StaleReason>): "fresh" | `stale:${string}` {
	const ordered = normalizeStaleReasons(reasons);
	return ordered.length > 0 ? `stale:${ordered.join(",")}` : "fresh";
}

export function normalizePathForComparison(cwd: string, filePath: string | undefined): string | undefined {
	const value = filePath?.trim();
	if (!value) return undefined;
	return resolve(cwd, value);
}

export function matchesHotPath(cwd: string, hotPath: string, candidatePath: string | undefined): boolean {
	const hotAbs = normalizePathForComparison(cwd, hotPath);
	const candidateAbs = normalizePathForComparison(cwd, candidatePath);
	if (!hotAbs || !candidateAbs) return false;
	return hotAbs === candidateAbs;
}

export function noteHotPathChange(cwd: string, hotPaths: string[], candidatePath: string | undefined, existing: string[]): string[] {
	const matched = hotPaths.find((hotPath) => matchesHotPath(cwd, hotPath, candidatePath));
	if (!matched || existing.includes(matched)) return existing;
	return [...existing, matched];
}

function normalizeInlineText(value: string | undefined): string | undefined {
	if (!value?.trim()) return undefined;
	return value
		.replace(/^[-*]\s+/gm, "")
		.replace(/\s+/g, " ")
		.trim();
}

function summarizeSection(body: string, heading: string, fallback: string): string {
	return normalizeInlineText(extractSection(body, heading)) ?? fallback;
}

function summarizeChange(reason: StaleReason, changedHotPaths: string[]): string {
	if (reason === "T") return "the session drifted past the last fresh brief checkpoint";
	if (reason === "R") return "we are looping on repeated recon and rereads";
	if (reason === "H") return "the task scope shifted inside the current session";
	if (changedHotPaths.length === 0) return "relevant hot files or docs changed";
	const changed = changedHotPaths.slice(0, MAX_CHANGED_PATHS).join(", ");
	return `hot files/docs changed: ${changed}`;
}

export function buildRecommendationSummary(reasons: Iterable<StaleReason>, changedHotPaths: string[]): string {
	const ordered = normalizeStaleReasons(reasons);
	if (ordered.length === 0) return "";
	return ordered.map((reason) => summarizeChange(reason, changedHotPaths)).join("; ");
}

export function buildRecommendationKey(params: {
	topic: string;
	reasons: Iterable<StaleReason>;
	changedHotPaths: string[];
}): string | undefined {
	const ordered = normalizeStaleReasons(params.reasons);
	if (ordered.length === 0) return undefined;
	const changed = params.changedHotPaths.slice(0, MAX_CHANGED_PATHS).sort().join(",");
	return `${params.topic}|${ordered.join(",")}|${changed}`;
}

export function shouldRecommendFreshSession(reasons: Iterable<StaleReason>): boolean {
	const ordered = normalizeStaleReasons(reasons);
	if (ordered.length === 0) return false;
	if (ordered.includes("H") || ordered.includes("R")) return true;
	return ordered.length >= 2;
}

export function buildSuggestedHandoffCommand(params: {
	brief: BriefRecord;
	reasons: Iterable<StaleReason>;
	changedHotPaths: string[];
}): string {
	const nextSlice = summarizeSection(
		params.brief.body,
		"Next Slice",
		`Continue the next bounded slice for ${params.brief.topic}.`,
	);
	const summary = buildRecommendationSummary(params.reasons, params.changedHotPaths);
	const goal = [
		`Continue ${params.brief.topic} in a fresh session.`,
		`What changed: ${summary}.`,
		`Next slice: ${nextSlice}.`,
	].join(" ");
	return truncateText(`/handoff ${goal}`, HANDOFF_COMMAND_MAX_CHARS);
}

export function buildRecommendationNotice(params: {
	brief: BriefRecord;
	reasons: Iterable<StaleReason>;
	changedHotPaths: string[];
}): string {
	const ordered = normalizeStaleReasons(params.reasons);
	const summary = buildRecommendationSummary(ordered, params.changedHotPaths);
	return truncateText(
		`Fresh session recommended for ${params.brief.topic} (${ordered.join(",")}): ${summary}.`,
		NOTICE_MAX_CHARS,
	);
}

export function buildExplorationKey(toolName: string, input: Record<string, unknown> | undefined): string | undefined {
	if (!input) return undefined;
	if (toolName === "read") {
		const path = typeof input.path === "string" ? input.path.trim() : "";
		return path ? `read:${path}` : undefined;
	}
	if (toolName === "grep") {
		const path = typeof input.path === "string" ? input.path.trim() : ".";
		const glob = typeof input.glob === "string" ? input.glob.trim() : "";
		const pattern = typeof input.pattern === "string" ? input.pattern.trim() : "";
		return pattern ? `grep:${path}:${glob}:${truncateText(pattern, 80)}` : undefined;
	}
	if (toolName === "find") {
		const path = typeof input.path === "string" ? input.path.trim() : ".";
		const pattern = typeof input.pattern === "string" ? input.pattern.trim() : "";
		return pattern ? `find:${path}:${truncateText(pattern, 80)}` : undefined;
	}
	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command.trim().replace(/\s+/g, " ") : "";
		return command ? `bash:${truncateText(command, 120)}` : undefined;
	}
	return undefined;
}

export function noteExplorationKey(existing: string[], nextKey: string | undefined): string[] {
	if (!nextKey) return existing;
	return [...existing, nextKey].slice(-EXPLORATION_WINDOW_SIZE);
}

export function hasRepeatedExplorationLoop(keys: string[]): boolean {
	if (keys.length < EXPLORATION_REPEAT_THRESHOLD) return false;
	const counts = new Map<string, number>();
	for (const key of keys) {
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	let maxCount = 0;
	for (const count of counts.values()) {
		if (count > maxCount) maxCount = count;
	}
	if (maxCount >= EXPLORATION_REPEAT_THRESHOLD) return true;
	return keys.length >= 5 && counts.size <= 2;
}

export function computeStaleReasons(signals: DriftSignals): StaleReason[] {
	const reasons: StaleReason[] = [];
	if (signals.turnsSinceRefresh >= SESSION_TURN_DRIFT_THRESHOLD) reasons.push("T");
	if (signals.changedHotPaths.length > 0) reasons.push("C");
	if (hasRepeatedExplorationLoop(signals.recentExplorationKeys)) reasons.push("R");
	if (signals.topicTransitionCount > 0) reasons.push("H");
	return normalizeStaleReasons(reasons);
}
