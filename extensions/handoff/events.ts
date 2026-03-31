export const HANDOFF_SESSION_STARTED_EVENT = "handoff:session_started";

export type HandoffSessionStartedEvent = {
	mode: "command" | "tool";
	previousSessionFile?: string;
	parentSessionFile?: string;
	nextSessionFile?: string;
	nextSessionId?: string;
};
