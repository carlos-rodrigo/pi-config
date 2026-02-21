/**
 * Agent Handoff Tool - lets the LLM generate a focused handoff prompt.
 *
 * NOTE: /agent-handoff command was removed because queued slash commands sent via
 * pi.sendUserMessage() are treated as plain user text (not command invocations).
 *
 * Current flow:
 *   1. Agent calls the handoff tool with a goal
 *   2. Tool gathers conversation and generates a focused prompt via LLM
 *   3. Tool places the prompt in the editor and instructs the user to run /new manually
 */

import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "handoff",
		label: "Handoff",
		description:
			"Generate a focused handoff prompt from conversation history for continuing work in a fresh session.",
		parameters: Type.Object({
			goal: Type.String({
				description:
					"Context and instructions for the next session. Include: what was just completed, " +
					"key patterns/gotchas discovered, and what the next session should do.",
			}),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
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

			onUpdate?.({
				content: [{ type: "text", text: "Generating handoff prompt from conversation history..." }],
			});

			const llmMessages = convertToLlm(messages);
			const conversationText = serializeConversation(llmMessages);
			const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);

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
				{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
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

			ctx.ui.setEditorText(generatedPrompt);
			ctx.ui.notify("Handoff prompt drafted in editor. Run /new, then submit it.", "info");

			return {
				content: [
					{
						type: "text",
						text: "Handoff prompt generated and placed in the editor. Automatic session switching is disabled; run /new manually, then submit this prompt in the new session.",
					},
				],
				details: {},
			};
		},
	});
}
