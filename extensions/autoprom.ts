/**
 * AutoProm Suggestion — ghost text prompt suggestions.
 *
 * After the agent finishes responding, calls an LLM to generate a single
 * suggested next prompt. The suggestion appears as gray ghost text inside
 * the editor (rendered by bordered-editor via pi.events).
 *
 * - Right arrow → accepts the full suggestion
 * - Any character → dismisses ghost, types normally
 * - Escape / Backspace → dismisses ghost
 *
 * Commands:
 *   /suggest          Toggle auto-suggestions on/off
 *   /suggest model    Change the suggestion model (e.g. /suggest model anthropic/claude-haiku-4-5)
 *   /suggest now      Manually trigger a suggestion
 */

import { complete, getModel, type Api, type Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// --- Configuration defaults ---

const PRIMARY_MODEL = { provider: "anthropic" as const, id: "claude-sonnet-4-6" as const };
const FALLBACK_MODEL = { provider: "anthropic" as const, id: "claude-haiku-4-5" as const };

// --- State ---

let enabled = true;
let pendingController: AbortController | null = null;
let currentCtx: ExtensionContext | undefined;
let configuredModel: { provider: string; id: string } = { ...PRIMARY_MODEL };

// --- Helpers ---

type ContentBlock = { type?: string; text?: string };
type SessionEntry = { type: string; message?: { role?: string; content?: unknown } };

function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((p): p is ContentBlock => p?.type === "text" && typeof p.text === "string")
		.map((p) => p.text!)
		.join("\n");
}

function buildConversationContext(ctx: ExtensionContext, maxMessages = 5): string {
	const entries = ctx.sessionManager.getBranch() as SessionEntry[];
	const messages: string[] = [];

	for (let i = entries.length - 1; i >= 0 && messages.length < maxMessages; i--) {
		const entry = entries[i];
		if (entry.type !== "message" || !entry.message?.role) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;

		const text = extractTextFromContent(entry.message.content).trim();
		if (!text) continue;

		const label = role === "user" ? "User" : "Assistant";
		// Trim long messages to ~500 chars each to keep context small
		const trimmed = text.length > 500 ? text.slice(0, 500) + "…" : text;
		messages.unshift(`${label}: ${trimmed}`);
	}

	return messages.join("\n\n");
}

function buildSuggestionPrompt(conversationContext: string, workflowMode?: string): string {
	const modeHint = workflowMode ? `\n- Current workflow mode: ${workflowMode}` : "";
	return `You are predicting what the user will type next in a coding assistant chat.

Based on the recent conversation, suggest ONE brief prompt the user is most likely to send next.

Rules:
- Single sentence, 5-20 words
- Must be a natural follow-up to what JUST happened (the last exchange)
- If the user just completed a task, suggest testing it, verifying it works, or moving on to the next related task
- If the user was debugging, suggest the next debugging step
- If the user asked a question, suggest a follow-up question or action
- Do NOT suggest new features, improvements, or extensions to what was just built — unless the user explicitly asked for that
- Do NOT suggest tangentially related work
- Think: "what would the user most likely type right now?"${modeHint}
- Return ONLY the prompt text. No quotes, no explanation, no markdown.

<recent_conversation>
${conversationContext}
</recent_conversation>`;
}

function resolveModelSync(): Model<Api> | null {
	// Try configured model first
	try {
		const model = getModel(
			configuredModel.provider as "anthropic",
			configuredModel.id as "claude-sonnet-4-6",
		);
		if (model) return model as Model<Api>;
	} catch {
		// Model not found, try fallback
	}

	// Fallback
	try {
		const model = getModel(FALLBACK_MODEL.provider, FALLBACK_MODEL.id);
		if (model) return model as Model<Api>;
	} catch {
		// Fallback also not found
	}

	return null;
}

function cancelPending(): void {
	if (pendingController) {
		pendingController.abort();
		pendingController = null;
	}
}

async function generateSuggestion(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!enabled || !ctx.hasUI) return;

	cancelPending();

	const model = resolveModelSync();
	if (!model) {
		ctx.ui.notify("AutoProm: no model available, suggestions disabled", "warning");
		enabled = false;
		pi.appendEntry("autoprom", { enabled });
		return;
	}

	const apiKey = await ctx.modelRegistry.getApiKey(model);
	if (!apiKey) {
		ctx.ui.notify("AutoProm: no API key available, suggestions disabled", "warning");
		enabled = false;
		pi.appendEntry("autoprom", { enabled });
		return;
	}

	const conversationContext = buildConversationContext(ctx);
	if (!conversationContext.trim()) return;

	// Detect workflow mode from session
	let workflowMode: string | undefined;
	const entries = ctx.sessionManager.getEntries() as Array<{
		type: string;
		customType?: string;
		data?: { mode?: string };
	}>;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "custom" && entries[i].customType === "workflow-mode") {
			workflowMode = entries[i].data?.mode;
			break;
		}
	}

	const controller = new AbortController();
	pendingController = controller;

	try {
		const prompt = buildSuggestionPrompt(conversationContext, workflowMode);
		const response = await complete(
			model,
			{
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: prompt }],
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey, reasoningEffort: "off", signal: controller.signal },
		);

		// Don't emit if cancelled while waiting
		if (controller.signal.aborted) return;

		const suggestion = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text.trim())
			.join("")
			.trim();

		if (suggestion && suggestion.length > 0 && suggestion.length < 200) {
			pi.events.emit("autoprom:suggest", { text: suggestion });
		}
	} catch (err: unknown) {
		if (err instanceof Error && err.name === "AbortError") return;
		// Silently fail — don't break the user's flow
	} finally {
		if (pendingController === controller) {
			pendingController = null;
		}
	}
}

// --- Extension entry ---

export default function (pi: ExtensionAPI) {
	// Clear ghost text and cancel pending when user acts
	pi.on("input", async (_event, _ctx) => {
		cancelPending();
		pi.events.emit("autoprom:clear", {});
		return { action: "continue" as const };
	});

	pi.on("turn_start", async () => {
		cancelPending();
		pi.events.emit("autoprom:clear", {});
	});

	// Generate suggestion after agent finishes
	pi.on("agent_end", async (_event, ctx) => {
		currentCtx = ctx;
		// Small delay so the response renders before we fire the LLM call
		setTimeout(() => generateSuggestion(pi, ctx), 300);
	});

	// Track acceptance/dismissal
	pi.events.on("autoprom:accepted", () => {
		cancelPending();
	});

	pi.events.on("autoprom:dismissed", () => {
		cancelPending();
	});

	// Restore state on session start
	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;

		for (const entry of ctx.sessionManager.getEntries()) {
			const e = entry as {
				type: string;
				customType?: string;
				data?: { enabled?: boolean; model?: { provider: string; id: string } };
			};
			if (e.type === "custom" && e.customType === "autoprom") {
				if (e.data?.enabled !== undefined) enabled = e.data.enabled;
				if (e.data?.model) configuredModel = e.data.model;
			}
		}
	});

	// /suggest command
	pi.registerCommand("suggest", {
		description: "Toggle auto-suggestions or configure: /suggest | /suggest model <provider/id> | /suggest now",
		handler: async (args, ctx) => {
			const input = args.trim().toLowerCase();

			if (!input) {
				enabled = !enabled;
				pi.appendEntry("autoprom", { enabled, model: configuredModel });
				ctx.ui.notify(`AutoProm suggestions ${enabled ? "enabled" : "disabled"}`, "info");
				if (!enabled) {
					cancelPending();
					pi.events.emit("autoprom:clear", {});
				}
				return;
			}

			if (input === "now") {
				if (!enabled) {
					ctx.ui.notify("AutoProm is disabled. Use /suggest to enable.", "warning");
					return;
				}
				await generateSuggestion(pi, ctx);
				return;
			}

			if (input.startsWith("model")) {
				const modelArg = args.trim().slice(5).trim();
				if (!modelArg) {
					ctx.ui.notify(`Current model: ${configuredModel.provider}/${configuredModel.id}`, "info");
					return;
				}
				const parts = modelArg.split("/");
				if (parts.length !== 2) {
					ctx.ui.notify("Usage: /suggest model <provider>/<model-id>", "warning");
					return;
				}
				configuredModel = { provider: parts[0], id: parts[1] };
				pi.appendEntry("autoprom", { enabled, model: configuredModel });
				ctx.ui.notify(`AutoProm model set to ${configuredModel.provider}/${configuredModel.id}`, "info");
				return;
			}

			ctx.ui.notify("Usage: /suggest | /suggest model <provider/id> | /suggest now", "info");
		},
	});
}
