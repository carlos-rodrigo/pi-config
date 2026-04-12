import type {HandoffSessionStartedEvent} from "../handoff/events.ts";
import {truncateText} from "./brief-engine.ts";
import type {StaleReason} from "./drift-monitor.ts";

export type LatestHandoffState = {
	mode: "command" | "tool";
	activeTopic?: string;
	pinnedTopic?: string;
	staleReasons?: StaleReason[];
	previousSessionFile?: string;
	parentSessionFile?: string;
	nextSessionFile?: string;
	nextSessionId?: string;
	promptText?: string;
	capturedAt: string;
};

const MAX_HANDOFF_PROMPT_CHARS = 2_000;

export function createLatestHandoffState(params: {
	event: HandoffSessionStartedEvent;
	activeTopic?: string;
	pinnedTopic?: string;
	staleReasons?: StaleReason[];
	now?: Date;
}): LatestHandoffState {
	return {
		mode: params.event.mode,
		activeTopic: params.activeTopic,
		pinnedTopic: params.pinnedTopic,
		staleReasons: [...new Set(params.staleReasons ?? [])],
		previousSessionFile: params.event.previousSessionFile,
		parentSessionFile: params.event.parentSessionFile,
		nextSessionFile: params.event.nextSessionFile,
		nextSessionId: params.event.nextSessionId,
		capturedAt: (params.now ?? new Date()).toISOString(),
	};
}

export function attachHandoffPromptText(state: LatestHandoffState, promptText: string): LatestHandoffState {
	return {
		...state,
		promptText: truncateText(promptText, MAX_HANDOFF_PROMPT_CHARS),
	};
}

export function matchesHandoffSession(
	state: LatestHandoffState,
	session: {sessionId?: string; sessionFile?: string},
): boolean {
	if (state.nextSessionId && session.sessionId && state.nextSessionId !== session.sessionId) return false;
	if (state.nextSessionFile && session.sessionFile && state.nextSessionFile !== session.sessionFile) return false;
	return true;
}

export function renderLatestHandoffSource(state: LatestHandoffState | undefined): string | undefined {
	if (!state) return undefined;

	const lines = [
		"Latest handoff context:",
		`- mode: ${state.mode}`,
		state.activeTopic ? `- active topic: ${state.activeTopic}` : undefined,
		state.staleReasons && state.staleReasons.length > 0
			? `- stale at handoff: ${state.staleReasons.join(",")}`
			: undefined,
		state.previousSessionFile ? `- previous session: ${state.previousSessionFile}` : undefined,
		state.parentSessionFile && state.parentSessionFile !== state.previousSessionFile
			? `- parent session: ${state.parentSessionFile}`
			: undefined,
		state.nextSessionFile ? `- resumed in: ${state.nextSessionFile}` : undefined,
	];

	if (state.promptText?.trim()) {
		lines.push("", "Submitted handoff prompt:", state.promptText.trim());
	}

	return lines.filter(Boolean).join("\n");
}
