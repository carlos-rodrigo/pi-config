/**
 * Handoff extension - transfer context to a new focused session
 *
 * Provides both:
 *   - /handoff command (user-typed)
 *   - handoff tool (LLM-callable)
 *
 * Command path uses the supported ctx.newSession() flow.
 * Tool path uses a raw sessionManager.newSession() workaround on agent_end so
 * the agent can automatically hand off into a fresh session.
 */

import { existsSync, readFileSync } from "node:fs";
import { complete, type Message } from "@mariozechner/pi-ai";
import {
	BorderedLoader,
	buildSessionContext,
	convertToLlm,
	serializeConversation,
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { HANDOFF_SESSION_STARTED_EVENT, type HandoffSessionStartedEvent } from "./events.ts";
import { HANDOFF_SYSTEM_PROMPT } from "./shared.ts";

type HandoffResult = { type: "prompt"; text: string } | { type: "error"; message: string } | null;

type PendingAutoHandoff = {
	prompt: string;
	parentSessionFile?: string;
	previousSessionFile?: string;
};

function emitSessionStarted(pi: ExtensionAPI, payload: HandoffSessionStartedEvent) {
	pi.events.emit(HANDOFF_SESSION_STARTED_EVENT, payload);
}

function gatherConversation(ctx: ExtensionContext): string | null {
	const branch = ctx.sessionManager.getBranch();
	const leafId = ctx.sessionManager.getLeafId();
	const { messages } = buildSessionContext(branch, leafId);
	if (messages.length === 0) return null;
	return serializeConversation(convertToLlm(messages));
}

async function generateHandoffPrompt(
	conversationText: string,
	goal: string,
	ctx: ExtensionContext,
): Promise<HandoffResult> {
	return ctx.ui.custom<HandoffResult>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, "Generating handoff prompt...");
		loader.onAbort = () => done(null);

		const run = async () => {
			const apiKey = await ctx.modelRegistry.getApiKeyForProvider(ctx.model!.provider);
			if (!apiKey) {
				return { type: "error" as const, message: `No API key available for ${ctx.model!.provider}/${ctx.model!.id}.` };
			}

			const userMessage: Message = {
				role: "user",
				content: [
					{
						type: "text",
						text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
					},
				],
				timestamp: Date.now(),
			};

			const response = await complete(
				ctx.model!,
				{ systemPrompt: HANDOFF_SYSTEM_PROMPT, messages: [userMessage] },
				{ apiKey, signal: loader.signal },
			);

			if (response.stopReason === "aborted") return null;
			if (response.stopReason === "error") {
				const message =
					"errorMessage" in response && typeof response.errorMessage === "string"
						? response.errorMessage
						: "LLM request failed";
				return { type: "error" as const, message };
			}

			const text = response.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("\n")
				.trim();

			return text.length > 0
				? { type: "prompt" as const, text }
				: { type: "error" as const, message: "LLM returned empty response" };
		};

		run()
			.then(done)
			.catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				done({ type: "error" as const, message });
			});

		return loader;
	});
}

function getSessionHeader(sessionFile: string): { parentSession?: string } | null {
	try {
		if (!existsSync(sessionFile)) return null;
		const content = readFileSync(sessionFile, "utf8");
		const firstNewline = content.indexOf("\n");
		const firstLine = (firstNewline === -1 ? content : content.slice(0, firstNewline)).trim();
		if (!firstLine) return null;
		const parsed = JSON.parse(firstLine) as { type?: string; parentSession?: string };
		return parsed.type === "session" ? parsed : null;
	} catch {
		return null;
	}
}

function getSessionAncestry(parentSessionFile: string): string[] {
	const ancestry: string[] = [];
	const visited = new Set<string>();
	let current: string | undefined = parentSessionFile;

	while (current && !visited.has(current)) {
		visited.add(current);
		ancestry.push(current);
		current = getSessionHeader(current)?.parentSession;
	}

	return ancestry;
}

export function wrapWithParentSessionInfo(prompt: string, parentSessionFile: string | null): string {
	if (!parentSessionFile) return prompt;

	const ancestry = getSessionAncestry(parentSessionFile);
	const lines = [
		"## Session Lineage",
		"Use the `session_query` tool only when you need details from a previous session.",
		"",
		`**Parent session:** \`${ancestry[0]}\``,
	];

	if (ancestry.length > 1) {
		lines.push("");
		lines.push("**Ancestor sessions:**");
		for (const sessionFile of ancestry.slice(1)) {
			lines.push(`- \`${sessionFile}\``);
		}
	}

	lines.push("");
	return `${lines.join("\n")}\n${prompt}`;
}

export function filterHandoffContext<T extends { timestamp?: number }>(messages: T[], handoffTimestamp: number | null): T[] | null {
	if (handoffTimestamp === null) return null;
	const filtered = messages.filter((message) => typeof message.timestamp === "number" && message.timestamp >= handoffTimestamp);
	return filtered.length > 0 ? filtered : null;
}

export default function (pi: ExtensionAPI) {
	let pendingAutoHandoff: PendingAutoHandoff | null = null;
	let handoffTimestamp: number | null = null;

	function resetHandoffState() {
		pendingAutoHandoff = null;
		handoffTimestamp = null;
	}

	pi.on("session_start", async () => {
		resetHandoffState();
	});

	// Backward compatibility with current Pi runtime. Future Pi will move this
	// metadata onto session_start.
	pi.on("session_switch", async () => {
		resetHandoffState();
	});

	pi.on("context", (event) => {
		const filtered = filterHandoffContext(event.messages, handoffTimestamp);
		if (filtered) {
			return { messages: filtered };
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!pendingAutoHandoff) return;

		const handoff = pendingAutoHandoff;
		pendingAutoHandoff = null;
		handoffTimestamp = Date.now();

		const rawSessionManager = ctx.sessionManager as typeof ctx.sessionManager & {
			newSession: (options?: { parentSession?: string }) => string | undefined;
		};
		rawSessionManager.newSession({ parentSession: handoff.parentSessionFile });

		emitSessionStarted(pi, {
			mode: "tool",
			previousSessionFile: handoff.previousSessionFile,
			parentSessionFile: handoff.parentSessionFile,
			nextSessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
			nextSessionId: ctx.sessionManager.getSessionId(),
		});

		setTimeout(() => {
			if (!ctx.hasUI) return;
			ctx.ui.setEditorText(handoff.prompt);
			ctx.ui.notify("Auto-handoff ready — review if needed, then press Enter to continue.", "info");
		}, 0);
	});

	pi.registerCommand("handoff", {
		description: "Transfer context to a new focused session",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("handoff requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /handoff <goal for new thread>", "error");
				return;
			}

			const conversationText = gatherConversation(ctx);
			if (!conversationText) {
				ctx.ui.notify("No conversation to hand off", "error");
				return;
			}

			const result = await generateHandoffPrompt(conversationText, goal, ctx);
			if (!result) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}
			if (result.type === "error") {
				ctx.ui.notify(`Handoff failed: ${result.message}`, "error");
				return;
			}

			const currentSessionFile = ctx.sessionManager.getSessionFile();
			const wrappedPrompt = wrapWithParentSessionInfo(result.text, currentSessionFile ?? null);
			const editedPrompt = await ctx.ui.editor("Edit handoff prompt", wrappedPrompt);

			if (editedPrompt === undefined) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			const newSessionResult = await ctx.newSession({
				parentSession: currentSessionFile ?? undefined,
			});

			if (newSessionResult.cancelled) {
				ctx.ui.notify("New session cancelled", "info");
				return;
			}

			emitSessionStarted(pi, {
				mode: "command",
				previousSessionFile: currentSessionFile ?? undefined,
				parentSessionFile: currentSessionFile ?? undefined,
				nextSessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
				nextSessionId: ctx.sessionManager.getSessionId(),
			});

			ctx.ui.setEditorText(editedPrompt);
			ctx.ui.notify("Handoff ready — submit to start the new session.", "info");
		},
	});

	pi.registerTool({
		name: "handoff",
		label: "Handoff",
		description:
			"Transfer context to a new session with a fresh context window. " +
			"Generates a focused prompt from conversation history and the given goal, " +
			"starts a new session automatically after the current turn, and leaves the handoff prompt in the editor. " +
			"Use when you need to continue work in a clean context.",
		parameters: Type.Object({
			goal: Type.String({
				description:
					"Context and instructions for the next session. Include: what was just completed, " +
					"key patterns/gotchas discovered, and what the next session should do.",
			}),
		}),

		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: handoff requires interactive mode." }],
					details: {},
				};
			}

			if (!ctx.model) {
				return {
					content: [{ type: "text", text: "Error: no model selected." }],
					details: {},
				};
			}

			const goal = params.goal.trim();
			if (!goal) {
				return {
					content: [{ type: "text", text: "Error: goal parameter is required." }],
					details: {},
				};
			}

			const conversationText = gatherConversation(ctx);
			if (!conversationText) {
				return {
					content: [{ type: "text", text: "Error: no conversation history to hand off." }],
					details: {},
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: "Generating handoff prompt from conversation history..." }],
				details: {},
			});

			const result = await generateHandoffPrompt(conversationText, goal, ctx);
			if (!result) {
				return {
					content: [{ type: "text", text: "Handoff cancelled." }],
					details: {},
				};
			}
			if (result.type === "error") {
				return {
					content: [{ type: "text", text: `Handoff failed: ${result.message}` }],
					details: {},
				};
			}

			const currentSessionFile = ctx.sessionManager.getSessionFile();
			const wrappedPrompt = wrapWithParentSessionInfo(result.text, currentSessionFile ?? null);

			pendingAutoHandoff = {
				prompt: wrappedPrompt,
				parentSessionFile: currentSessionFile ?? undefined,
				previousSessionFile: currentSessionFile ?? undefined,
			};

			return {
				content: [
					{
						type: "text",
						text: "Handoff initiated. A fresh session will open automatically after this turn completes.",
					},
				],
				details: {},
			};
		},
	});
}
