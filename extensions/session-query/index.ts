/**
 * Session query tool - inspect prior Pi sessions on demand.
 *
 * Useful when a prior session path is available and only targeted details are needed.
 */

import { existsSync } from "node:fs";
import { complete, type Message } from "@earendil-works/pi-ai/compat";
import {
	SessionManager,
	convertToLlm,
	serializeConversation,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_SESSION_CHARS = 100_000;

const SESSION_QUERY_SYSTEM_PROMPT = `Extract information relevant to the question from the session history.
Return a concise answer using bullet points where appropriate.
Use code pointers (path/to/file.ts:42 or path/to/file.ts#functionName) when referencing specific code.
If the information is not in the session, say so clearly.`;

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "session_query",
		label: "Session Query",
		description:
			"Query a previous Pi session file for context, decisions, file changes, or other information. " +
			"Use the full path to a .jsonl session file.",
		parameters: Type.Object({
			sessionPath: Type.String({
				description: "Full path to the Pi session file (.jsonl) to inspect.",
			}),
			question: Type.String({
				description: "What you want to know about that session.",
			}),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!params.sessionPath.endsWith(".jsonl")) {
				throw new Error(`Invalid session path. Expected a .jsonl file, got: ${params.sessionPath}`);
			}

			if (!existsSync(params.sessionPath)) {
				throw new Error(`Session file not found: ${params.sessionPath}`);
			}

			onUpdate?.({
				content: [{ type: "text", text: `Querying session: ${params.question}` }],
				details: {},
			});

			let sessionManager: SessionManager;
			try {
				sessionManager = SessionManager.open(params.sessionPath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Error loading session: ${message}`, { cause: error });
			}

			const { messages } = sessionManager.buildSessionContext();
			if (messages.length === 0) {
				return {
					content: [{ type: "text" as const, text: "Session is empty - no messages found." }],
					details: { empty: true },
				};
			}

			let conversationText = serializeConversation(convertToLlm(messages));
			let truncated = false;
			if (conversationText.length > MAX_SESSION_CHARS) {
				conversationText = `…[earlier messages truncated]…\n\n${conversationText.slice(-MAX_SESSION_CHARS)}`;
				truncated = true;
			}

			if (!ctx.model) {
				throw new Error("No model available to analyze the session.");
			}

			const apiKey = await ctx.modelRegistry.getApiKeyForProvider(ctx.model.provider);
			if (!apiKey) {
				throw new Error(`No API key available for ${ctx.model.provider}/${ctx.model.id}.`);
			}

			try {
				const userMessage: Message = {
					role: "user",
					content: [
						{
							type: "text",
							text: `## Session Conversation\n\n${conversationText}\n\n## Question\n\n${params.question}`,
						},
					],
					timestamp: Date.now(),
				};

				const response = await complete(
					ctx.model,
					{ systemPrompt: SESSION_QUERY_SYSTEM_PROMPT, messages: [userMessage] },
					{ apiKey, signal },
				);

				if (response.stopReason === "aborted") {
					const error = new Error("Session query cancelled.");
					error.name = "AbortError";
					throw error;
				}

				if (response.stopReason === "error") {
					const message =
						"errorMessage" in response && typeof response.errorMessage === "string"
							? response.errorMessage
							: "LLM request failed";
					throw new Error(`Error querying session: ${message}`);
				}

				const answer = response.content
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map((part) => part.text)
					.join("\n")
					.trim();

				return {
					content: [{ type: "text" as const, text: answer || "No answer returned." }],
					details: {
						sessionPath: params.sessionPath,
						question: params.question,
						messageCount: messages.length,
						truncated,
					},
				};
			} catch (error) {
				if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
				const message = error instanceof Error ? error.message : String(error);
				if (message.startsWith("Error querying session:")) throw error;
				throw new Error(`Error querying session: ${message}`, { cause: error });
			}
		},
	});
}
