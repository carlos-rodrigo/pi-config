/**
 * Session parser — reads .jsonl session files and extracts minimap blocks.
 *
 * Each block represents one entry in the context window: user message,
 * assistant response, tool call/result, system prompt, etc.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────

export type BlockKind =
	| "system"       // system instructions, AGENTS.md, tools
	| "user"         // user message
	| "assistant"    // assistant text response
	| "thinking"     // thinking/reasoning content
	| "tool-call"    // tool invocation (Read, Edit, Bash, etc.)
	| "tool-result"  // tool result
	| "compaction"   // compaction summary
	| "branch-summary" // branch summary
	| "custom"       // custom extension message
	| "meta";        // model change, label, session info, etc.

export interface Block {
	kind: BlockKind;
	label: string;        // short display label (e.g. "Read()", "user", "Edit()")
	detail: string;       // longer description for drill-down
	tokens: number;       // estimated token count (for proportional height)
	timestamp: number;    // unix ms
	entryId: string;      // session entry id
	isError?: boolean;    // tool result was an error
}

export interface SessionMap {
	sessionId: string;
	sessionFile: string;
	parentSession?: string;
	cwd: string;
	timestamp: number;      // session start time
	name?: string;          // session display name
	blocks: Block[];
	totalTokens: number;    // sum of all block tokens
	contextUsage?: {        // from last assistant message usage
		input: number;
		output: number;
		total: number;
		cost?: number;
	};
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Rough token estimate: ~4 chars per token */
export function estimateTokens(text: string): number {
	if (!text) return 0;
	return Math.max(1, Math.ceil(text.length / 4));
}

function contentToString(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c: any) => {
				if (c.type === "text") return c.text || "";
				if (c.type === "thinking") return c.thinking || "";
				if (c.type === "toolCall") return `${c.name}(${JSON.stringify(c.arguments).slice(0, 200)})`;
				if (c.type === "image") return "[image]";
				return JSON.stringify(c).slice(0, 100);
			})
			.join("\n");
	}
	return JSON.stringify(content).slice(0, 200);
}

function contentPreview(content: unknown, maxLen = 80): string {
	const text = contentToString(content);
	const firstLine = text.split("\n")[0] || "";
	return firstLine.length > maxLen ? firstLine.slice(0, maxLen) + "…" : firstLine;
}

// ── Parser ─────────────────────────────────────────────────────────────────

export function parseSessionFile(filePath: string): SessionMap | null {
	if (!fs.existsSync(filePath)) return null;

	const raw = fs.readFileSync(filePath, "utf-8").trim();
	if (!raw) return null;

	const lines = raw.split("\n");
	const blocks: Block[] = [];
	let header: any = null;
	let sessionName: string | undefined;
	let lastUsage: SessionMap["contextUsage"] | undefined;

	for (const line of lines) {
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		if (entry.type === "session") {
			header = entry;
			continue;
		}

		if (entry.type === "session_info" && entry.name) {
			sessionName = entry.name;
			continue;
		}

		if (entry.type === "message") {
			const msg = entry.message;
			if (!msg) continue;

			const ts = msg.timestamp || new Date(entry.timestamp).getTime();
			const id = entry.id || "";

			if (msg.role === "user") {
				const text = contentToString(msg.content);
				blocks.push({
					kind: "user",
					label: "User",
					detail: contentPreview(msg.content, 200),
					tokens: estimateTokens(text),
					timestamp: ts,
					entryId: id,
				});
			} else if (msg.role === "assistant") {
				// Split assistant into thinking + text + tool calls
				const content = Array.isArray(msg.content) ? msg.content : [];

				// Thinking blocks
				const thinking = content.filter((c: any) => c.type === "thinking");
				if (thinking.length > 0) {
					const thinkText = thinking.map((c: any) => c.thinking || "").join("\n");
					blocks.push({
						kind: "thinking",
						label: "Thinking",
						detail: contentPreview(thinkText, 200),
						tokens: estimateTokens(thinkText),
						timestamp: ts,
						entryId: id,
					});
				}

				// Text response
				const texts = content.filter((c: any) => c.type === "text");
				if (texts.length > 0) {
					const textContent = texts.map((c: any) => c.text || "").join("\n");
					blocks.push({
						kind: "assistant",
						label: "Assistant",
						detail: contentPreview(textContent, 200),
						tokens: estimateTokens(textContent),
						timestamp: ts,
						entryId: id,
					});
				}

				// Tool calls
				const toolCalls = content.filter((c: any) => c.type === "toolCall");
				for (const tc of toolCalls) {
					const argStr = JSON.stringify(tc.arguments || {});
					blocks.push({
						kind: "tool-call",
						label: `${tc.name}()`,
						detail: argStr.slice(0, 200),
						tokens: estimateTokens(argStr),
						timestamp: ts,
						entryId: id,
					});
				}

				// Track usage
				if (msg.usage) {
					lastUsage = {
						input: msg.usage.input || 0,
						output: msg.usage.output || 0,
						total: msg.usage.totalTokens || 0,
						cost: msg.usage.cost?.total,
					};
				}
			} else if (msg.role === "toolResult") {
				const text = contentToString(msg.content);
				blocks.push({
					kind: "tool-result",
					label: `${msg.toolName || "tool"}()`,
					detail: contentPreview(msg.content, 200),
					tokens: estimateTokens(text),
					timestamp: ts,
					entryId: id,
					isError: msg.isError || false,
				});
			} else if (msg.role === "custom") {
				const text = contentToString(msg.content);
				blocks.push({
					kind: "custom",
					label: msg.customType || "custom",
					detail: contentPreview(msg.content, 200),
					tokens: estimateTokens(text),
					timestamp: ts,
					entryId: id,
				});
			}
		} else if (entry.type === "compaction") {
			blocks.push({
				kind: "compaction",
				label: "Compaction",
				detail: `Summarized ${entry.tokensBefore || "?"} tokens`,
				tokens: estimateTokens(entry.summary || ""),
				timestamp: new Date(entry.timestamp).getTime(),
				entryId: entry.id || "",
			});
		} else if (entry.type === "branch_summary") {
			blocks.push({
				kind: "branch-summary",
				label: "Branch Summary",
				detail: contentPreview(entry.summary, 200),
				tokens: estimateTokens(entry.summary || ""),
				timestamp: new Date(entry.timestamp).getTime(),
				entryId: entry.id || "",
			});
		}
		// Skip meta entries (model_change, thinking_level_change, label, etc.) —
		// they don't consume meaningful context
	}

	if (!header) return null;

	const totalTokens = blocks.reduce((sum, b) => sum + b.tokens, 0);

	return {
		sessionId: header.id,
		sessionFile: filePath,
		parentSession: header.parentSession,
		cwd: header.cwd || "",
		timestamp: new Date(header.timestamp).getTime(),
		name: sessionName,
		blocks,
		totalTokens,
		contextUsage: lastUsage,
	};
}

/**
 * Build a chain of sessions by following parentSession links backward.
 * Returns oldest first.
 */
export function buildSessionChain(startFile: string, maxDepth = 20): SessionMap[] {
	const chain: SessionMap[] = [];
	let currentFile: string | undefined = startFile;
	let depth = 0;

	while (currentFile && depth < maxDepth) {
		const session = parseSessionFile(currentFile);
		if (!session) break;
		chain.unshift(session); // oldest first
		currentFile = session.parentSession;
		depth++;
	}

	return chain;
}

/**
 * Parse the current session from the live session manager branch.
 * This avoids reading the file (which may be incomplete during streaming).
 */
export function parseSessionBranch(
	branch: any[],
	sessionId: string,
	sessionFile: string,
	parentSession?: string,
	cwd?: string,
): SessionMap {
	const blocks: Block[] = [];
	let lastUsage: SessionMap["contextUsage"] | undefined;

	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg) continue;

		const ts = msg.timestamp || 0;
		const id = entry.id || "";

		if (msg.role === "user") {
			const text = contentToString(msg.content);
			blocks.push({
				kind: "user",
				label: "User",
				detail: contentPreview(msg.content, 200),
				tokens: estimateTokens(text),
				timestamp: ts,
				entryId: id,
			});
		} else if (msg.role === "assistant") {
			const content = Array.isArray(msg.content) ? msg.content : [];

			const thinking = content.filter((c: any) => c.type === "thinking");
			if (thinking.length > 0) {
				const thinkText = thinking.map((c: any) => c.thinking || "").join("\n");
				blocks.push({
					kind: "thinking",
					label: "Thinking",
					detail: contentPreview(thinkText, 200),
					tokens: estimateTokens(thinkText),
					timestamp: ts,
					entryId: id,
				});
			}

			const texts = content.filter((c: any) => c.type === "text");
			if (texts.length > 0) {
				const textContent = texts.map((c: any) => c.text || "").join("\n");
				blocks.push({
					kind: "assistant",
					label: "Assistant",
					detail: contentPreview(textContent, 200),
					tokens: estimateTokens(textContent),
					timestamp: ts,
					entryId: id,
				});
			}

			const toolCalls = content.filter((c: any) => c.type === "toolCall");
			for (const tc of toolCalls) {
				const argStr = JSON.stringify(tc.arguments || {});
				blocks.push({
					kind: "tool-call",
					label: `${tc.name}()`,
					detail: argStr.slice(0, 200),
					tokens: estimateTokens(argStr),
					timestamp: ts,
					entryId: id,
				});
			}

			if (msg.usage) {
				lastUsage = {
					input: msg.usage.input || 0,
					output: msg.usage.output || 0,
					total: msg.usage.totalTokens || 0,
					cost: msg.usage.cost?.total,
				};
			}
		} else if (msg.role === "toolResult") {
			const text = contentToString(msg.content);
			blocks.push({
				kind: "tool-result",
				label: `${msg.toolName || "tool"}()`,
				detail: contentPreview(msg.content, 200),
				tokens: estimateTokens(text),
				timestamp: ts,
				entryId: id,
				isError: msg.isError || false,
			});
		} else if (msg.role === "custom") {
			const text = contentToString(msg.content);
			blocks.push({
				kind: "custom",
				label: msg.customType || "custom",
				detail: contentPreview(msg.content, 200),
				tokens: estimateTokens(text),
				timestamp: ts,
				entryId: id,
			});
		}
	}

	const totalTokens = blocks.reduce((sum, b) => sum + b.tokens, 0);

	return {
		sessionId,
		sessionFile,
		parentSession,
		cwd: cwd || "",
		timestamp: blocks[0]?.timestamp || Date.now(),
		blocks,
		totalTokens,
		contextUsage: lastUsage,
	};
}
