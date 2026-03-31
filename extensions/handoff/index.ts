/**
 * Handoff extension - transfer context to a new focused session
 *
 * Provides both:
 *   - /handoff command (user-typed)
 *   - handoff tool (LLM-callable)
 *
 * Usage (command):
 *   /handoff now implement this for teams as well
 *   /handoff execute phase one of the plan
 *
 * Usage (tool):
 *   Agent calls handoff({ goal: "..." }) to autonomously transfer context
 *
 * Note: pi.sendUserMessage() doesn't execute extension commands - it sends raw
 * user messages to the LLM. So we can't use sendUserMessage to trigger a command.
 * Instead, we use agent_end to set up the editor for manual completion.
 */

import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { HANDOFF_SYSTEM_PROMPT } from "./shared.js";

export default function (pi: ExtensionAPI) {
	let pendingHandoffPrompt: string | null = null;

	// After agent finishes, check if we have a pending handoff and prompt user to complete it
	pi.on("agent_end", async (_event, ctx) => {
		if (!pendingHandoffPrompt) return;

		// Set up the editor with the command to complete the handoff
		ctx.ui.setEditorText("/_handoff_complete");
		ctx.ui.notify("Handoff ready — press Enter to create the new session.", "info");
	});

	// Clear pending state on session switch to avoid stale handoffs
	pi.on("session_switch", async () => {
		pendingHandoffPrompt = null;
	});

	// Internal command that completes the handoff (creates new session)
	// User presses Enter after agent_end sets up the editor
	pi.registerCommand("_handoff_complete", {
		description: "Complete a handoff initiated by the handoff tool (internal)",
		handler: async (_args, ctx) => {
			const prompt = pendingHandoffPrompt;
			pendingHandoffPrompt = null;

			if (!prompt) {
				ctx.ui.notify("No pending handoff prompt", "error");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify("Handoff requires interactive mode", "error");
				return;
			}

			const currentSessionFile = ctx.sessionManager.getSessionFile();

			const result = await ctx.newSession({
				parentSession: currentSessionFile,
			});

			if (result.cancelled) {
				ctx.ui.notify("New session cancelled", "info");
				return;
			}

			ctx.ui.setEditorText(prompt);
			ctx.ui.notify("Handoff ready — submit to start the new session.", "info");
		},
	});

	// User-facing /handoff command
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

			// Gather conversation context from current branch
			const branch = ctx.sessionManager.getBranch();
			const messages = branch
				.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
				.map((entry) => entry.message);

			if (messages.length === 0) {
				ctx.ui.notify("No conversation to hand off", "error");
				return;
			}

			// Convert to LLM format and serialize
			const llmMessages = convertToLlm(messages);
			const conversationText = serializeConversation(llmMessages);
			const currentSessionFile = ctx.sessionManager.getSessionFile();

			// Generate the handoff prompt with loader UI
			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, `Generating handoff prompt...`);
				loader.onAbort = () => done(null);

				const doGenerate = async () => {
					const apiKey = await ctx.modelRegistry.getApiKeyForProvider(ctx.model!.provider);
					if (!apiKey) {
						throw new Error(`No API key available for ${ctx.model!.provider}/${ctx.model!.id}`);
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

					if (response.stopReason === "aborted") {
						return null;
					}

					return response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
				};

				doGenerate()
					.then(done)
					.catch((err) => {
						console.error("Handoff generation failed:", err);
						done(null);
					});

				return loader;
			});

			if (result === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// Let user edit the generated prompt
			const editedPrompt = await ctx.ui.editor("Edit handoff prompt", result);

			if (editedPrompt === undefined) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// Create new session with parent tracking
			const newSessionResult = await ctx.newSession({
				parentSession: currentSessionFile,
			});

			if (newSessionResult.cancelled) {
				ctx.ui.notify("New session cancelled", "info");
				return;
			}

			// Set the edited prompt in the main editor for submission
			ctx.ui.setEditorText(editedPrompt);
			ctx.ui.notify("Handoff ready. Submit when ready.", "info");
		},
	});

	// LLM-callable handoff tool
	pi.registerTool({
		name: "handoff",
		label: "Handoff",
		description:
			"Transfer context to a new session with a fresh context window. " +
			"Generates a focused prompt from conversation history and the given goal, " +
			"then creates a new session with that prompt ready to submit. " +
			"Use when you need to continue work in a clean context (e.g., after completing a task in the loop).",
		parameters: Type.Object({
			goal: Type.String({
				description:
					"Context and instructions for the next session. Include: what was just completed, " +
					"key patterns/gotchas discovered, and what the next session should do.",
			}),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
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

			// Gather conversation context from current branch
			const branch = ctx.sessionManager.getBranch();
			const messages = branch
				.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
				.map((entry) => entry.message);

			if (messages.length === 0) {
				return {
					content: [{ type: "text", text: "Error: no conversation history to hand off." }],
					details: {},
				};
			}

			// Stream progress to the agent
			onUpdate?.({
				content: [{ type: "text", text: "Generating handoff prompt from conversation history..." }],
				details: {},
			});

			// Convert to LLM format and serialize
			const llmMessages = convertToLlm(messages);
			const conversationText = serializeConversation(llmMessages);
			const apiKey = await ctx.modelRegistry.getApiKeyForProvider(ctx.model.provider);
			if (!apiKey) {
				return {
					content: [
						{ type: "text", text: `Error: no API key available for ${ctx.model.provider}/${ctx.model.id}.` },
					],
					details: {},
				};
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
				ctx.model,
				{ systemPrompt: HANDOFF_SYSTEM_PROMPT, messages: [userMessage] },
				{ apiKey, signal },
			);

			if (response.stopReason === "aborted") {
				return {
					content: [{ type: "text", text: "Handoff cancelled (aborted)." }],
					details: {},
				};
			}

			const generatedPrompt = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			if (!generatedPrompt) {
				return {
					content: [{ type: "text", text: "Error: failed to generate handoff prompt." }],
					details: {},
				};
			}

			// Store prompt for completion in agent_end handler
			// Note: We can't use pi.sendUserMessage("/_handoff_complete") because
			// sendUserMessage doesn't execute extension commands - it sends raw
			// user messages to the LLM. The agent_end handler will set up the
			// editor for manual completion.
			if (pendingHandoffPrompt) {
				console.warn("[handoff] Overwriting pending handoff from earlier in this turn");
			}
			pendingHandoffPrompt = generatedPrompt;

			return {
				content: [
					{
						type: "text",
						text: "Handoff prepared. When this turn ends, press Enter (the command will be pre-filled) to create the new session. Do not send any more messages in this session.",
					},
				],
				details: {},
			};
		},
	});
}
