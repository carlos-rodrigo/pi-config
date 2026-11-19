/**
 * Decides whether a finished agent attempt failed because its model provider was unavailable, so the
 * launcher may run the task on the next configured model. Dependency-free: `run.sh` loads it with plain Node
 * through `model-fallback-cli.ts`.
 *
 * Pi exposes no provider status code. The structured signal is the last assistant message's
 * `stopReason: "error"`; only its `errorMessage` text names the cause, so the patterns below are a documented
 * text fallback. Pi already retries transient transport failures (pi-ai `isRetryableAssistantError`), and those
 * are not fallback causes. Cancellation (`aborted`), successful stops and exit codes never fall back.
 */
const PROVIDER_UNAVAILABLE_PATTERNS = [
	// Quota, usage and billing limits, e.g. "Claude quota exceeded … You've hit your 5-hour limit",
	// "…reached their Subscription Sharing usage limit", OpenAI `insufficient_quota`.
	/quota|usage limit|hit your .{0,40}limit|out of budget|billing|credit balance/i,
	/rate.?limit|too many requests|\b429\b|resource.?exhausted/i,
	/overloaded|high demand|service.?unavailable|\b503\b|\b529\b/i,
	/unauthori[sz]ed|forbidden|\b40[13]\b|authenticat|api.?key|credentials|not logged in|subscription/i,
	/\bmodel\b.{0,60}\b(not found|not available|unavailable|not supported|does not exist)|unknown model|no such model/i,
];

function namesUnavailableProvider(text: string): boolean {
	return PROVIDER_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(text));
}

function lastAssistantMessage(eventsJsonl: string): { stopReason?: unknown; errorMessage?: unknown } | undefined {
	let last: { stopReason?: unknown; errorMessage?: unknown } | undefined;
	for (const line of eventsJsonl.split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line);
			if (event?.type === "message_end" && event.message?.role === "assistant") last = event.message;
		} catch { /* Partial or foreign lines are not assistant messages. */ }
	}
	return last;
}

/** The attempt's provider-unavailability reason, or undefined when the next model must not be tried. */
export function providerUnavailableReason(eventsJsonl: string, stderr: string): string | undefined {
	const message = lastAssistantMessage(eventsJsonl);
	if (message) {
		const reason = message.stopReason === "error" && typeof message.errorMessage === "string" ? message.errorMessage : "";
		return namesUnavailableProvider(reason) ? reason : undefined;
	}
	// No assistant message: pi failed before the model answered, e.g. `Error: Model "x" not found.`
	return stderr.split("\n").map((line) => line.trim()).find((line) => /^error\b/i.test(line) && namesUnavailableProvider(line));
}
