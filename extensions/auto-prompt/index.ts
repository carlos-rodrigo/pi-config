/**
 * Auto Prompt Suggestion — ghost text next-step prompt suggestions.
 *
 * After the agent finishes responding, calls an LLM to generate a single
 * suggested next prompt the user can send to move the work forward. The
 * suggestion appears as gray ghost text inside the editor (rendered by
 * bordered-editor via pi.events).
 *
 * Prompts follow best practices for agent collaboration:
 * - Directive, not questions ("Fix X" not "Why isn't X working?")
 * - Include feedback loops when applicable ("Run tests after", "Verify by checking X")
 * - Reference specific files/patterns when available
 * - Give definition of done so the agent can self-verify
 *
 * Acceptance:
 * - Right arrow → accepts the full suggestion
 * - Any character → dismisses ghost, types normally
 * - Escape / Backspace → dismisses ghost
 *
 * Improve Prompt (Ctrl+Shift+I):
 *   Takes whatever the user has typed in the editor and rewrites it
 *   following the same best-practice principles — making it more
 *   directive, specific, and feedback-loopable. Replaces the editor
 *   text with the improved version.
 *
 * Commands:
 *   /suggest          Toggle auto-suggestions on/off
 *   /suggest model    Change the suggestion model (e.g. /suggest model openai-codex/gpt-5.1-codex-mini)
 *   /suggest now      Manually trigger a suggestion
 *   /improve          Manually improve the current editor text
 */

import {
	complete,
	getModels,
	getProviders,
	type Api,
	type KnownProvider,
	type Model,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// --- Configuration defaults ---

const PRIMARY_MODEL = { provider: "openai-codex" as const, id: "gpt-5.1-codex-mini" as const };
const FALLBACK_MODEL = { provider: "openai-codex" as const, id: "gpt-5.3-codex-spark" as const };

// --- State ---

let enabled = true;
let pendingController: AbortController | null = null;
let currentCtx: ExtensionContext | undefined;
let configuredModel: { provider: string; id: string } = { ...PRIMARY_MODEL };

// --- Helpers ---

type ContentBlock = { type?: string; text?: string; thinking?: string };
type SessionEntry = { type: string; message?: { role?: string; content?: unknown } };

function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const textParts = content
		.filter((p): p is ContentBlock => typeof p?.text === "string")
		.map((p) => p.text!.trim())
		.filter(Boolean);
	if (textParts.length > 0) return textParts.join("\n");

	const thinkingParts = content
		.filter((p): p is ContentBlock => typeof p?.thinking === "string")
		.map((p) => p.thinking!.trim())
		.filter(Boolean);
	return thinkingParts.join("\n");
}

export function extractAssistantOutput(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return extractTextFromContent(content).trim();
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

/** Extract file paths mentioned in conversation for specificity. */
export function extractFilePaths(conversationContext: string): string[] {
	// Match common file path patterns (relative and absolute)
	const pathPattern = /(?:^|\s|`|["'(])([a-zA-Z0-9_./-]+\.[a-zA-Z]{1,10})(?:[\s`"'),:]|$)/gm;
	const paths = new Set<string>();
	let match: RegExpExecArray | null;
	while ((match = pathPattern.exec(conversationContext)) !== null) {
		const p = match[1];
		// Filter out common non-file-path matches
		if (p && !p.startsWith("http") && !p.startsWith("www.") && p.includes("/")) {
			paths.add(p);
		}
	}
	return [...paths].slice(0, 8);
}

/** Extract test/build commands mentioned in conversation. */
export function extractCommands(conversationContext: string): string[] {
	const cmdPatterns = [
		/(?:run|execute|use)\s+`([^`]+)`/gi,
		/\$\s+(.+?)(?:\n|$)/g,
		/(?:npm|pnpm|yarn|bun|npx|node|deno|cargo|make|go)\s+\S+(?:\s+\S+)*/g,
	];
	const cmds = new Set<string>();
	for (const pattern of cmdPatterns) {
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(conversationContext)) !== null) {
			const cmd = (match[1] || match[0]).trim();
			if (cmd.length > 3 && cmd.length < 100) cmds.add(cmd);
		}
	}
	return [...cmds].slice(0, 5);
}

/** Detect the current conversation phase to tailor suggestions. */
export function detectPhase(conversationContext: string): ConversationPhase {
	const lower = conversationContext.toLowerCase();

	// Check for debugging signals
	const debugSignals = ["bug", "error", "fix", "debug", "broken", "issue", "fail", "crash", "stack trace", "exception", "undefined", "null", "not working", "doesn't work"];
	const debugScore = debugSignals.filter((s) => lower.includes(s)).length;

	// Check for testing signals
	const testSignals = ["test", "spec", "assert", "expect", "coverage", "passing", "failing", "e2e", "unit test", "integration test"];
	const testScore = testSignals.filter((s) => lower.includes(s)).length;

	// Check for building/implementing signals
	const buildSignals = ["implement", "create", "add", "build", "feature", "component", "endpoint", "page", "function", "class", "module"];
	const buildScore = buildSignals.filter((s) => lower.includes(s)).length;

	// Check for review/shipping signals
	const shipSignals = ["review", "pr", "commit", "merge", "deploy", "ship", "push", "pull request", "done", "complete", "finished", "ready"];
	const shipScore = shipSignals.filter((s) => lower.includes(s)).length;

	// Check for planning/design signals
	const planSignals = ["plan", "design", "architecture", "approach", "prd", "requirements", "should we", "how should", "strategy", "trade-off"];
	const planScore = planSignals.filter((s) => lower.includes(s)).length;

	const scores: Array<[ConversationPhase, number]> = [
		["debugging", debugScore],
		["testing", testScore],
		["building", buildScore],
		["shipping", shipScore],
		["planning", planScore],
	];

	scores.sort((a, b) => b[1] - a[1]);
	return scores[0][1] > 0 ? scores[0][0] : "building";
}

function normalizeGuideline(raw: string): string {
	return raw
		.replace(/^[-*]\s+/, "")
		.replace(/^\d+\.\s+/, "")
		.replace(/^>\s+/, "")
		.replace(/\*\*(.*?)\*\*/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 220);
}

/**
 * Extract a compact set of baseline AGENTS/system guidelines so prompt suggestions
 * focus on the next-step delta instead of repeating global process defaults.
 */
export function extractBaselineGuidelines(systemPrompt: string, maxGuidelines = 8): string[] {
	if (!systemPrompt.trim()) return [];

	const lines = systemPrompt.split(/\r?\n/);
	const sections = [
		"non-negotiables",
		"change discipline",
		"development workflow",
		"exceptions",
		"golden rule",
	];

	const out: string[] = [];
	const seen = new Set<string>();
	let currentSection = "";

	const push = (candidate: string): void => {
		const normalized = normalizeGuideline(candidate);
		if (!normalized) return;
		const key = normalized.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		out.push(normalized);
	};

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		if (/^#{1,6}\s+/.test(trimmed)) {
			currentSection = trimmed.replace(/^#{1,6}\s+/, "").toLowerCase();
			continue;
		}

		const inImportantSection = sections.some((s) => currentSection.includes(s));
		const isBullet = /^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed);
		const hasStrongPolicyLanguage =
			/^(never|always|requires approval|allowed without approval|golden rule)/i.test(trimmed) ||
			/\b(do not|must|never|requires approval)\b/i.test(trimmed);

		if ((inImportantSection && isBullet) || hasStrongPolicyLanguage) {
			push(trimmed);
		}

		if (out.length >= maxGuidelines) break;
	}

	return out.slice(0, maxGuidelines);
}

function buildBaselineGuidelinesBlock(baselineGuidelines?: string[]): string {
	if (!baselineGuidelines || baselineGuidelines.length === 0) return "";
	const bulletList = baselineGuidelines.map((g) => `- ${g}`).join("\n");
	return `\n\n<baseline_agent_guidelines>\n${bulletList}\n</baseline_agent_guidelines>`;
}

function isLikelyBaselineRestatement(text: string): boolean {
	const lower = text.toLowerCase();
	const baselineSignals = [
		"follow agents",
		"follow the loop",
		"feed the loop",
		"best practices",
		"keep it scoped",
		"follow guidelines",
		"non-negotiable",
		"golden rule",
		"according to agents",
	];
	const hasBaselineSignal = baselineSignals.some((s) => lower.includes(s));
	if (!hasBaselineSignal) return false;

	const hasConcreteArtifact = /[a-zA-Z0-9_./-]+\.[a-zA-Z]{1,10}/.test(text);
	const hasConcreteCommand = /\b(npm|pnpm|yarn|bun|npx|node|go|cargo|make)\b/.test(lower);
	const hasActionVerb = /\b(fix|implement|update|edit|run|add|remove|refactor|verify|commit|push)\b/.test(lower);

	return !hasConcreteArtifact && !hasConcreteCommand && !hasActionVerb;
}

export type ConversationPhase = "debugging" | "testing" | "building" | "shipping" | "planning";

export function buildSuggestionPrompt(
	conversationContext: string,
	workflowMode?: string,
	filePaths?: string[],
	commands?: string[],
	phase?: ConversationPhase,
	baselineGuidelines?: string[],
): string {
	const modeHint = workflowMode ? `\n- Current agent mode: ${workflowMode}` : "";
	const modeGuidance =
		workflowMode === "deep"
			? `
- In Deep mode, prefer prompts that drive deeper analysis, edge-case checks, and thorough validation`
			: workflowMode === "fast"
				? `
- In Fast mode, prefer narrow, concrete next actions with minimal scope`
				: workflowMode === "smart"
					? `
- In Smart mode, prefer balanced prompts that keep momentum without sacrificing quality`
					: "";

	const fileContext =
		filePaths && filePaths.length > 0
			? `\n\n<files_in_conversation>\n${filePaths.join("\n")}\n</files_in_conversation>`
			: "";

	const cmdContext =
		commands && commands.length > 0
			? `\n\n<commands_in_conversation>\n${commands.join("\n")}\n</commands_in_conversation>`
			: "";

	const phaseGuidance = phase
		? `\n\n<phase_guidance phase="${phase}">
${getPhaseGuidance(phase)}
</phase_guidance>`
		: "";

	const baselineContext = buildBaselineGuidelinesBlock(baselineGuidelines);

	return `You draft the next prompt the USER should send to a coding agent to move the work forward.
You write prompts that follow best practices for agent collaboration.

Based on the recent conversation, suggest ONE actionable next-step prompt for the user.

## Prompt Writing Principles

Good prompts for coding agents are:
1. DIRECTIVE — Give direction, not questions. "Fix the auth bug in login.ts" beats "Why isn't login working?"
2. SPECIFIC — Reference exact files, functions, patterns. "Follow the pattern in src/api/messages.ts" beats "Make it consistent"
3. FEEDBACK-LOOPABLE — Include how the agent should verify its work. "Run the tests after" or "Check the output by running X"
4. SCOPED — One clear task with a definition of done, not open-ended exploration
5. CONTEXTUAL — Mention constraints, patterns to follow, things to avoid

## Structure

A great prompt has up to 3 parts (combine naturally into 1-2 sentences):
- WHAT to do (always required)
- HOW to verify / definition of done (include when there's a clear verification step)
- WHAT to reference or follow (include when specific files/patterns are relevant)

Keep it concise: 10-40 words. One or two sentences max.

## Rules

- Write the prompt as something the user can send directly to the agent
- Optimize for forward progress — suggest the most impactful next action
- Must be a natural next step from what JUST happened
- Stay in the user's voice; do NOT write as the assistant
- Do NOT suggest tangential work, new features, or improvements unless the user was exploring that
- When a task was just completed, suggest verification (run tests, check output, try the feature)
- When debugging, suggest the next concrete debugging action, not more investigation
- When tests are failing, suggest fixing them with a specific approach
- When the user was told to do something manually, suggest that manual step
- Assume baseline AGENTS/system guidelines are already enforced by the coding agent
- Do NOT restate generic process defaults (e.g. "follow AGENTS", "run/feed the loop") unless it is the specific blocking action now
- Prefer delta guidance: what concrete next action should happen now${modeHint}${modeGuidance}
- Return ONLY the prompt text. No quotes, no explanation, no markdown.${phaseGuidance}

<recent_conversation>
${conversationContext}
</recent_conversation>${fileContext}${cmdContext}${baselineContext}`;
}

function getPhaseGuidance(phase: ConversationPhase): string {
	switch (phase) {
		case "debugging":
			return `The conversation is in a DEBUGGING phase.
- Suggest creating a reproducible test case if none exists
- Suggest targeted fixes with verification: "Fix X, then run the failing test to confirm"
- If the cause is unclear, suggest isolating the issue: "Add logging to X to trace the value of Y"
- Prefer: "Fix the collision detection in physics.ts and run the headless CLI to verify" over "Why is it broken?"`;
		case "testing":
			return `The conversation is in a TESTING phase.
- Suggest running specific test suites or adding missing test cases
- Include verification: "Run the full test suite and fix any failures"
- If tests pass, suggest edge cases or moving to the next step
- Prefer: "Add edge case tests for empty input and null values, then run the suite" over "Write more tests"`;
		case "building":
			return `The conversation is in a BUILDING phase.
- Suggest the next implementation step with a clear deliverable
- Include a way to verify: "Implement X, then run the tests" or "Build X following the pattern in Y"
- Reference specific files or patterns when available
- Prefer: "Add the notification endpoint following src/api/messages.ts, run API tests after" over "Build notifications"`;
		case "shipping":
			return `The conversation is in a SHIPPING phase.
- Suggest review, commit, or deployment steps
- Include pre-ship checks: "Run the full test suite and linter before pushing"
- If review is done, suggest the concrete ship action
- Prefer: "Run tests and linter, then create the PR with a summary of changes" over "Ship it"`;
		case "planning":
			return `The conversation is in a PLANNING phase.
- Suggest clarifying requirements, defining scope, or documenting decisions
- If planning is done, suggest transitioning to implementation
- Prefer: "Define the API contract for the notification endpoint and save to design.md" over "Let's plan more"`;
	}
}

export function buildImprovementPrompt(
	userDraft: string,
	conversationContext: string,
	filePaths?: string[],
	commands?: string[],
	phase?: ConversationPhase,
	baselineGuidelines?: string[],
): string {
	const fileContext =
		filePaths && filePaths.length > 0
			? `\n\n<files_in_conversation>\n${filePaths.join("\n")}\n</files_in_conversation>`
			: "";

	const cmdContext =
		commands && commands.length > 0
			? `\n\n<commands_in_conversation>\n${commands.join("\n")}\n</commands_in_conversation>`
			: "";

	const phaseHint = phase ? `\nThe conversation is currently in a ${phase.toUpperCase()} phase.` : "";
	const baselineContext = buildBaselineGuidelinesBlock(baselineGuidelines);

	return `You improve prompts that users send to coding agents.
Given the user's draft prompt and the recent conversation, rewrite the prompt to be more effective.

## Your Task

Rewrite the user's draft to follow best practices for agent collaboration, while preserving their original intent exactly.

## Improvement Principles

1. DIRECTIVE — Rewrite questions as instructions. "Why isn't X working?" → "Fix X in file.ts"
2. SPECIFIC — Add file paths, function names, or patterns from the conversation when relevant
3. FEEDBACK-LOOPABLE — Add a verification step if one is missing: "then run the tests", "verify by checking X"
4. SCOPED — Keep it focused on one task. If the draft is already scoped, don't expand it
5. CONTEXTUAL — Add relevant constraints or references the user likely meant but didn't spell out

## Rules

- PRESERVE the user's intent — do NOT change what they want done, only improve how they say it
- Keep improvements proportional — a short draft becomes a better short prompt, not a paragraph
- If the draft is already good, make only minor improvements or return it as-is
- Add verification/feedback steps only when there's a natural one (tests, build, check output)
- Reference specific files or commands from conversation context when they're relevant to the task
- Treat baseline AGENTS/system guidance as already implied; don't add generic process boilerplate unless it is explicitly requested
- Do NOT add new requirements, features, or scope the user didn't ask for
- Do NOT add preamble, explanation, or commentary
- Return ONLY the improved prompt text. No quotes, no markdown formatting.${phaseHint}

<user_draft>
${userDraft}
</user_draft>

<recent_conversation>
${conversationContext}
</recent_conversation>${fileContext}${cmdContext}${baselineContext}`;
}

function resolveModel(config: { provider: string; id: string }): Model<Api> | null {
	if (!config.provider || !config.id) return null;

	try {
		const provider = config.provider as KnownProvider;
		if (!getProviders().includes(provider)) return null;
		const candidates = getModels(provider) as Array<Model<Api>>;
		return candidates.find((m) => m.id === config.id) ?? null;
	} catch {
		return null;
	}
}

function resolveModelSync(): Model<Api> | null {
	return resolveModel(configuredModel) ?? resolveModel(FALLBACK_MODEL);
}

const AUTOPROMPT_SYSTEM_INSTRUCTIONS =
	"You generate concise, actionable prompt text for coding-agent collaboration. Follow the user request exactly and return only plain text.";

function buildCompletionContext(userText: string): {
	systemPrompt: string;
	messages: Array<{ role: "user"; content: Array<{ type: "text"; text: string }>; timestamp: number }>;
} {
	return {
		systemPrompt: AUTOPROMPT_SYSTEM_INSTRUCTIONS,
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: userText }],
				timestamp: Date.now(),
			},
		],
	};
}

function buildCompletionOptions(model: Model<Api>, apiKey: string, signal: AbortSignal): {
	apiKey: string;
	signal: AbortSignal;
	reasoningEffort?: "none" | "minimal";
} {
	if (model.api === "openai-codex-responses") {
		return { apiKey, signal, reasoningEffort: "none" };
	}
	if (
		model.api === "openai-responses" ||
		model.api === "openai-completions" ||
		model.api === "azure-openai-responses"
	) {
		return { apiKey, signal, reasoningEffort: "minimal" };
	}
	return { apiKey, signal };
}

function ensureCompletionSucceeded(response: { stopReason: string; errorMessage?: string }): void {
	if (response.stopReason === "error") {
		throw new Error(response.errorMessage || "Model request failed");
	}
}

function startImproveLoadingStatus(ctx: ExtensionContext): () => void {
	const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	const startedAt = Date.now();
	let idx = 0;

	ctx.ui.setStatus("auto-prompt", "Improving prompt…");
	const timer = setInterval(() => {
		const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
		ctx.ui.setStatus("auto-prompt", `${frames[idx % frames.length]} Improving prompt… ${elapsed}s`);
		idx += 1;
	}, 120);

	return () => {
		clearInterval(timer);
		ctx.ui.setStatus("auto-prompt", undefined);
	};
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
		ctx.ui.notify("Auto Prompt: no model available, suggestions disabled", "warning");
		enabled = false;
		pi.appendEntry("auto-prompt", { enabled });
		return;
	}

	const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
	if (!apiKey) {
		ctx.ui.notify("Auto Prompt: no API key available, suggestions disabled", "warning");
		enabled = false;
		pi.appendEntry("auto-prompt", { enabled });
		return;
	}

	const conversationContext = buildConversationContext(ctx);
	if (!conversationContext.trim()) return;

	// Detect current agent mode from session
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

	// Extract context signals for richer prompt generation
	const filePaths = extractFilePaths(conversationContext);
	const commands = extractCommands(conversationContext);
	const phase = detectPhase(conversationContext);
	const baselineGuidelines = extractBaselineGuidelines(ctx.getSystemPrompt());

	const controller = new AbortController();
	pendingController = controller;

	const requestSuggestion = async (revisionHint?: string): Promise<string> => {
		const basePrompt = buildSuggestionPrompt(
			conversationContext,
			workflowMode,
			filePaths,
			commands,
			phase,
			baselineGuidelines,
		);
		const prompt = revisionHint
			? `${basePrompt}\n\n<revision_request>\n${revisionHint}\n</revision_request>`
			: basePrompt;

		const response = await complete(
			model,
			buildCompletionContext(prompt),
			buildCompletionOptions(model, apiKey, controller.signal),
		);
		ensureCompletionSucceeded(response);

		return extractAssistantOutput(response.content);
	};

	try {
		let suggestion = await requestSuggestion();

		// Don't emit if cancelled while waiting
		if (controller.signal.aborted) return;

		if (suggestion && isLikelyBaselineRestatement(suggestion)) {
			suggestion = await requestSuggestion(
				"Your previous output mostly repeated baseline process guidance. Rewrite as a concrete immediate next action tied to this conversation, ideally naming a file, command, or explicit deliverable.",
			);
		}

		if (controller.signal.aborted) return;

		if (suggestion && suggestion.length > 0 && suggestion.length < 200) {
			pi.events.emit("auto-prompt:suggest", { text: suggestion });
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

async function improveCurrentDraft(pi: ExtensionAPI, ctx: ExtensionContext, explicitDraft?: string): Promise<void> {
	if (!ctx.hasUI) return;

	const draft = (explicitDraft ?? ctx.ui.getEditorText()).trim();
	if (!draft) {
		ctx.ui.notify("Type a prompt first, then press Ctrl+Shift+I", "info");
		return;
	}

	cancelPending();
	pi.events.emit("auto-prompt:clear", {});

	const model = resolveModelSync();
	if (!model) {
		ctx.ui.notify("Auto Prompt: no model available", "warning");
		return;
	}

	const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
	if (!apiKey) {
		ctx.ui.notify("Auto Prompt: no API key available", "warning");
		return;
	}

	const conversationContext = buildConversationContext(ctx, 3);
	const analysisContext = [conversationContext, `User draft: ${draft}`].filter(Boolean).join("\n\n");
	const filePaths = extractFilePaths(analysisContext);
	const commands = extractCommands(analysisContext);
	const phase = detectPhase(analysisContext);
	const baselineGuidelines = extractBaselineGuidelines(ctx.getSystemPrompt());

	const controller = new AbortController();
	pendingController = controller;

	let stopLoading: (() => void) | null = null;

	try {
		stopLoading = startImproveLoadingStatus(ctx);
		const prompt = buildImprovementPrompt(
			draft,
			conversationContext,
			filePaths,
			commands,
			phase,
			baselineGuidelines,
		);
		const response = await complete(
			model,
			buildCompletionContext(prompt),
			buildCompletionOptions(model, apiKey, controller.signal),
		);
		ensureCompletionSucceeded(response);

		if (controller.signal.aborted) return;

		let improved = extractAssistantOutput(response.content);

		if (!improved) {
			const retryPrompt = `Rewrite this draft into one concise, actionable prompt for a coding agent. Preserve intent. Return only the rewritten prompt text.\n\nDraft: ${draft}`;
			const retryResponse = await complete(
				model,
				buildCompletionContext(retryPrompt),
				buildCompletionOptions(model, apiKey, controller.signal),
			);
			ensureCompletionSucceeded(retryResponse);

			if (controller.signal.aborted) return;
			improved = extractAssistantOutput(retryResponse.content);
		}

		if (!improved) {
			ctx.ui.notify("Could not improve prompt. Try again.", "warning");
			return;
		}

		if (improved.length > 1000) {
			ctx.ui.notify("Improved prompt is too long. Try a more focused draft.", "warning");
			return;
		}

		ctx.ui.setEditorText(improved);
		ctx.ui.notify("Prompt improved", "success");
	} catch (err: unknown) {
		if (err instanceof Error && err.name === "AbortError") return;
		const reason = err instanceof Error ? err.message : "Unknown error";
		const shortReason = reason.length > 120 ? `${reason.slice(0, 117)}...` : reason;
		ctx.ui.notify(`Failed to improve prompt: ${shortReason}`, "warning");
	} finally {
		if (stopLoading) stopLoading();
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
		pi.events.emit("auto-prompt:clear", {});
		return { action: "continue" as const };
	});

	pi.on("turn_start", async () => {
		cancelPending();
		pi.events.emit("auto-prompt:clear", {});
	});

	// Generate suggestion after agent finishes
	pi.on("agent_end", async (_event, ctx) => {
		currentCtx = ctx;
		// Small delay so the response renders before we fire the LLM call
		setTimeout(() => generateSuggestion(pi, ctx), 300);
	});

	// Track acceptance/dismissal
	pi.events.on("auto-prompt:accepted", () => {
		cancelPending();
	});

	pi.events.on("auto-prompt:dismissed", () => {
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
			if (e.type === "custom" && e.customType === "auto-prompt") {
				if (e.data?.enabled !== undefined) enabled = e.data.enabled;
				if (e.data?.model) configuredModel = e.data.model;
			}
		}
	});

	pi.registerShortcut("ctrl+shift+i", {
		description: "Improve the current draft prompt in the editor",
		handler: async (ctx: ExtensionContext) => {
			await improveCurrentDraft(pi, ctx);
		},
	});

	pi.registerCommand("improve", {
		description: "Improve the current editor text (or /improve <text>) using prompt best practices",
		handler: async (args, ctx) => {
			await improveCurrentDraft(pi, ctx, args);
		},
	});

	// /suggest command
	pi.registerCommand("suggest", {
		description: "Toggle auto-suggestions or configure: /suggest | /suggest model <provider/id> | /suggest now",
		handler: async (args, ctx) => {
			const input = args.trim().toLowerCase();

			if (!input) {
				enabled = !enabled;
				pi.appendEntry("auto-prompt", { enabled, model: configuredModel });
				ctx.ui.notify(`Auto Prompt suggestions ${enabled ? "enabled" : "disabled"}`, "info");
				if (!enabled) {
					cancelPending();
					pi.events.emit("auto-prompt:clear", {});
				}
				return;
			}

			if (input === "now") {
				if (!enabled) {
					ctx.ui.notify("Auto Prompt is disabled. Use /suggest to enable.", "warning");
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
				pi.appendEntry("auto-prompt", { enabled, model: configuredModel });
				ctx.ui.notify(`Auto Prompt model set to ${configuredModel.provider}/${configuredModel.id}`, "info");
				return;
			}

			ctx.ui.notify("Usage: /suggest | /suggest model <provider/id> | /suggest now", "info");
		},
	});
}
