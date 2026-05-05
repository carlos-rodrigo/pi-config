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
 * - Include feedback loops when applicable — prefer E2E verification over "run tests"
 * - Reference specific files/patterns when available
 * - Give definition of done so the agent can self-verify
 * - Devil's advocate: prefer real inputs from docs/API samples over agent-generated test data
 * - E2E bias: suggest hitting real boundaries (curl, CLI) not just unit tests
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
 *   /suggest model    Change the suggestion model (e.g. /suggest model openai-codex/gpt-5.3-codex-spark)
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

type ModelSelection = { provider: string; id: string };

const LEGACY_UNSUPPORTED_MODEL = {
	provider: "openai-codex" as const,
	id: "gpt-5.1-codex-mini" as const,
};
const PRIMARY_MODEL = { provider: "openai-codex" as const, id: "gpt-5.3-codex-spark" as const };
const FALLBACK_MODEL = { provider: "openai-codex" as const, id: "gpt-5.3-codex" as const };

// --- State ---

let enabled = true;
let pendingController: AbortController | null = null;
let currentCtx: ExtensionContext | undefined;
let configuredModel: ModelSelection = { ...PRIMARY_MODEL };
let statusClearTimer: ReturnType<typeof setTimeout> | null = null;

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

export function normalizeComparablePromptText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function hasMeaningfulPromptChange(original: string, improved: string): boolean {
	return normalizeComparablePromptText(original) !== normalizeComparablePromptText(improved);
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

/**
 * Detect if the assistant just completed an implementation without mentioning verification.
 * This triggers aggressive verification suggestions (devil's advocate mode).
 */
export function detectUnverifiedImplementation(conversationContext: string): boolean {
	const lower = conversationContext.toLowerCase();

	// Get the last assistant message
	const lastAssistantMatch = conversationContext.match(/Assistant:\s*([\s\S]*?)(?:User:|$)/gi);
	if (!lastAssistantMatch || lastAssistantMatch.length === 0) return false;

	const lastAssistant = lastAssistantMatch[lastAssistantMatch.length - 1].toLowerCase();

	// Implementation signals - agent claims to have done something
	const implementationSignals = [
		"created", "added", "implemented", "updated", "fixed", "changed",
		"modified", "wrote", "built", "refactored", "moved", "renamed",
		"deleted", "removed", "done", "completed", "finished",
		"i've ", "i have ", "here's the", "here is the",
		"changes made", "committed", "pushed"
	];

	// Verification signals - agent mentions testing/verification
	const verificationSignals = [
		"test", "verify", "verified", "verification", "curl", "checked",
		"confirmed", "passing", "passed", "ran ", "running", "output",
		"result", "response", "returns", "works", "working",
		"validated", "validation", "e2e", "end-to-end",
		"tried", "tested"
	];

	const hasImplementation = implementationSignals.some(s => lastAssistant.includes(s));
	const hasVerification = verificationSignals.some(s => lastAssistant.includes(s));

	// Implementation without verification = needs devil's advocate suggestion
	return hasImplementation && !hasVerification;
}

function getWorkflowModeGuidance(workflowMode?: string): string {
	switch (workflowMode) {
		case "smart":
			return `
- In Smart mode (GPT-5.5 low), prefer a narrow next action plus one focused check`;
		case "deep":
		case "deep2":
			return `
- In Deep mode (GPT-5.5 medium), prefer outcome-focused prompts with constraints and a verification_plan before behavior-changing edits`;
		case "deep3":
			return `
- In Deep³ mode, prefer maximum-quality prompts: reproduce or diagnose first, state tradeoffs, patch only if localized, and verify with focused + regression checks`;
		case "fast":
			return `
- In Fast mode, prefer tiny, concrete next actions with a cheap proof check`;
		default:
			return "";
	}
}

export function buildSuggestionPrompt(
	conversationContext: string,
	workflowMode?: string,
	filePaths?: string[],
	commands?: string[],
	phase?: ConversationPhase,
	baselineGuidelines?: string[],
	unverifiedImplementation?: boolean,
): string {
	const modeHint = workflowMode ? `\n- Current agent mode: ${workflowMode}` : "";
	const modeGuidance = getWorkflowModeGuidance(workflowMode);

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
3. FEEDBACK-LOOPABLE — Include how the agent should verify its work. Prefer E2E verification over "run tests"
4. SCOPED — One clear task with a definition of done, not open-ended exploration
5. CONTEXTUAL — Mention constraints, patterns to follow, things to avoid
6. DEVIL'S ADVOCATE — When suggesting verification, prefer real inputs (from docs, API samples) over agent-generated test data. Challenge the implementation from the outside.

## Structure

A great prompt has up to 3 parts (combine naturally into 1-2 sentences):
- WHAT to do (always required)
- HOW to verify / definition of done (prefer E2E: "curl the endpoint with sample payload", "run the CLI with real input" over just "run tests")
- WHAT to reference or follow (include when specific files/patterns are relevant)

Use an Action + proof shape by default: "Do X, then verify with Y." For behavior-changing edits, either ask the agent to call verification_plan first or name a concrete check.

Keep it concise: 10-45 words. One or two sentences max. Never exceed 240 characters.

## Rules

- Write the prompt as something the user can send directly to the agent
- Optimize for forward progress — suggest the most impactful next action
- Must be a natural next step from what JUST happened
- Stay in the user's voice; do NOT write as the assistant
- Do NOT suggest tangential work, new features, or improvements unless the user was exploring that
- When a task was just completed, suggest E2E verification (curl the endpoint, run CLI with real input, check actual output) not just "run tests"
- When the next step is implementation, include verification_plan before editing unless the verification contract is already clear
- When debugging, suggest the next concrete debugging action plus the failing input or focused test that proves it
- When tests are failing, suggest fixing them with a specific approach and rerunning the failing command
- When the user was told to do something manually, suggest that manual step
- Assume baseline AGENTS/system guidelines are already enforced by the coding agent
- Do NOT restate generic process defaults (e.g. "follow AGENTS", "run/feed the loop") unless it is the specific blocking action now
- Prefer delta guidance: what concrete next action should happen now${modeHint}${modeGuidance}
- Return ONLY the prompt text. No quotes, no explanation, no markdown.
- Hard limit: 240 characters maximum.${phaseGuidance}${unverifiedImplementation ? `

<verification_gap>
IMPORTANT: The agent just completed an implementation but did NOT mention verification.
Your suggestion MUST be a verification prompt. Do not suggest more implementation.

Suggest E2E verification that:
- Hits a real boundary (curl endpoint, run CLI, check DB) — not just "run tests"
- Uses real inputs from docs/API samples if this is an integration
- Would catch bugs that unit tests might miss (the blind spot problem)
- A person who didn't write the code could run to verify it works

Examples:
- "Verify the webhook handler by curling it with the sample payload from BitFreighter docs"
- "Test the export by running the CLI with a real data file and checking the output"
- "Check the API returns correct data by curling /api/users and comparing to the DB"
</verification_gap>` : ""}

<recent_conversation>
${conversationContext}
</recent_conversation>${fileContext}${cmdContext}${baselineContext}`;
}

function getPhaseGuidance(phase: ConversationPhase): string {
	switch (phase) {
		case "debugging":
			return `The conversation is in a DEBUGGING phase.
- Suggest creating a reproducible test case if none exists
- Suggest targeted fixes with E2E verification: "Fix X, then curl the endpoint with the failing payload"
- If the cause is unclear, suggest isolating the issue: "Add logging to X to trace the value of Y"
- Prefer real-world reproduction: "Test with the actual BitFreighter webhook payload from their docs"
- Prefer: "Fix the collision detection in physics.ts and run the headless CLI to verify" over "Why is it broken?"`;
		case "testing":
			return `The conversation is in a TESTING phase.
- Suggest E2E verification that hits real boundaries (HTTP endpoints, CLI, actual DB), not just unit tests
- Unit tests written by the agent can share blind spots with the code — suggest testing with real fixtures from docs/samples
- If tests pass, suggest edge case verification with real inputs: "Try the endpoint with edge case payloads from the API docs"
- Prefer: "Test the webhook handler with fixtures/bitfreighter/sample.json from their docs" over "Write more tests"`;
		case "building":
			return `The conversation is in a BUILDING phase.
- Suggest the next implementation step with a clear deliverable
- Include verification_plan before behavior-changing edits, or include a concrete check if the plan already exists
- Include E2E verification: "Implement X, then curl it with a sample payload" or "Build X, verify with real input"
- Reference specific files or patterns when available
- When integration work, suggest: "Get a sample payload from the API docs and save to fixtures/ for testing"
- Prefer: "Add the webhook endpoint, test with curl using the sample payload from BitFreighter docs" over "Build webhook"`;
		case "shipping":
			return `The conversation is in a SHIPPING phase.
- Before shipping, suggest devil's advocate verification: test with real inputs the agent didn't generate
- Include pre-ship checks: "Verify with a real payload from docs, then run full test suite"
- If review is done, suggest the concrete ship action
- Prefer: "Test the integration with sample payloads from their API docs, then create the PR" over "Ship it"`;
		case "planning":
			return `The conversation is in a PLANNING phase.
- Suggest clarifying requirements, defining scope, or documenting decisions
- For integrations, suggest: "Get sample payloads from their API docs and save to fixtures/"
- If planning is done, suggest transitioning to implementation with a verification_plan or explicit success criteria
- Prefer: "Define the webhook contract and save a sample payload from BitFreighter docs to fixtures/" over "Let's plan more"`;
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
3. FEEDBACK-LOOPABLE — For behavior-changing work, add verification_plan before coding or a concrete check after coding. Prefer "curl the endpoint with sample payload" over just "run tests"
4. SCOPED — Keep it focused on one task. If the draft is already scoped, don't expand it
5. CONTEXTUAL — Add relevant constraints or references the user likely meant but didn't spell out
6. DEVIL'S ADVOCATE — When adding verification, prefer real inputs (from docs, API samples, fixtures) over agent-generated test data

## Rules

- PRESERVE the user's intent — do NOT change what they want done, only improve how they say it
- Keep improvements proportional — a short draft becomes a better short prompt, not a paragraph
- If the draft is already good, make only minor improvements or return it as-is
- For behavior-changing drafts, include verification_plan before editing or a concrete check after editing; prefer E2E (curl, CLI with real input) over just "run tests"
- If the task involves integration, suggest verification with real fixtures from docs/API samples
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

function sameModelSelection(a: ModelSelection, b: ModelSelection): boolean {
	return a.provider === b.provider && a.id === b.id;
}

export function normalizeConfiguredModel(config: ModelSelection): ModelSelection {
	return sameModelSelection(config, LEGACY_UNSUPPORTED_MODEL) ? { ...PRIMARY_MODEL } : config;
}

function resolveModel(config: ModelSelection): Model<Api> | null {
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

function resolveModelSelections(): Model<Api>[] {
	const resolved: Model<Api>[] = [];
	const seen = new Set<string>();

	for (const selection of [normalizeConfiguredModel(configuredModel), FALLBACK_MODEL]) {
		const key = `${selection.provider}/${selection.id}`;
		if (seen.has(key)) continue;
		seen.add(key);

		const model = resolveModel(selection);
		if (model) resolved.push(model);
	}

	return resolved;
}

type ResolvedModelCandidate = { model: Model<Api>; apiKey: string };

async function resolveRequestCandidates(ctx: ExtensionContext): Promise<ResolvedModelCandidate[]> {
	const candidates: ResolvedModelCandidate[] = [];
	for (const model of resolveModelSelections()) {
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
		if (!apiKey) continue;
		candidates.push({ model, apiKey });
	}
	return candidates;
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

function clearAutoPromptTransientStatus(): void {
	if (statusClearTimer) {
		clearTimeout(statusClearTimer);
		statusClearTimer = null;
	}
}

function setAutoPromptStatus(ctx: ExtensionContext, text: string | undefined): void {
	clearAutoPromptTransientStatus();
	ctx.ui.setStatus("auto-prompt", text);
}

function showTransientAutoPromptStatus(ctx: ExtensionContext, text: string, durationMs = 2500): void {
	clearAutoPromptTransientStatus();
	ctx.ui.setStatus("auto-prompt", text);
	const timer = setTimeout(() => {
		if (statusClearTimer === timer) {
			statusClearTimer = null;
		}
		ctx.ui.setStatus("auto-prompt", undefined);
	}, durationMs);
	statusClearTimer = timer;
}

export function extractAutoPromptErrorMessage(err: unknown): string {
	const raw = (err instanceof Error ? err.message : String(err)).trim();
	if (!raw) return "Unknown error";

	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed?.detail === "string") return parsed.detail;
		if (typeof parsed?.message === "string") return parsed.message;
		if (typeof parsed?.error?.message === "string") return parsed.error.message;
	} catch {
		// Fall through to raw error text.
	}

	return raw;
}

export function shouldRetryAutoPromptWithFallback(err: unknown): boolean {
	const reason = extractAutoPromptErrorMessage(err);
	return /model/i.test(reason) && /(not supported|unsupported|not found|unknown|unavailable)/i.test(reason);
}

function formatAutoPromptError(err: unknown): string {
	const reason = extractAutoPromptErrorMessage(err);
	return reason.length > 120 ? `${reason.slice(0, 117)}...` : reason;
}

async function runWithModelFallback<T>(
	candidates: ResolvedModelCandidate[],
	task: (candidate: ResolvedModelCandidate) => Promise<T>,
): Promise<T> {
	let lastError: unknown;

	for (let i = 0; i < candidates.length; i++) {
		try {
			return await task(candidates[i]);
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") throw err;
			lastError = err;
			if (i === candidates.length - 1 || !shouldRetryAutoPromptWithFallback(err)) {
				throw err;
			}
		}
	}

	throw lastError ?? new Error("Model request failed");
}

function startLoadingStatus(ctx: ExtensionContext, label: string): () => void {
	const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	const startedAt = Date.now();
	let idx = 0;

	setAutoPromptStatus(ctx, label);
	const timer = setInterval(() => {
		const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
		setAutoPromptStatus(ctx, `${frames[idx % frames.length]} ${label} ${elapsed}s`);
		idx += 1;
	}, 120);

	return () => {
		clearInterval(timer);
		setAutoPromptStatus(ctx, undefined);
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

	const availableModels = resolveModelSelections();
	if (availableModels.length === 0) {
		ctx.ui.notify("Auto Prompt: no model available, suggestions disabled", "warning");
		enabled = false;
		pi.appendEntry("auto-prompt", { enabled });
		return;
	}

	const requestCandidates = await resolveRequestCandidates(ctx);
	if (requestCandidates.length === 0) {
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
	const unverifiedImplementation = detectUnverifiedImplementation(conversationContext);

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
			unverifiedImplementation,
		);
		const prompt = revisionHint
			? `${basePrompt}\n\n<revision_request>\n${revisionHint}\n</revision_request>`
			: basePrompt;

		const response = await runWithModelFallback(requestCandidates, async ({ model, apiKey }) => {
			const response = await complete(
				model,
				buildCompletionContext(prompt),
				buildCompletionOptions(model, apiKey, controller.signal),
			);
			ensureCompletionSucceeded(response);
			return response;
		});

		return extractAssistantOutput(response.content);
	};

	let stopLoading: (() => void) | null = null;

	try {
		stopLoading = startLoadingStatus(ctx, "Suggesting next prompt…");
		let suggestion = await requestSuggestion();

		// Don't emit if cancelled while waiting
		if (controller.signal.aborted) return;

		if (suggestion && isLikelyBaselineRestatement(suggestion)) {
			suggestion = await requestSuggestion(
				"Your previous output mostly repeated baseline process guidance. Rewrite as a concrete immediate next action tied to this conversation, ideally naming a file, command, or explicit deliverable.",
			);
		}

		if (controller.signal.aborted) return;

		if (!suggestion) {
			stopLoading();
			stopLoading = null;
			showTransientAutoPromptStatus(ctx, "No suggestion generated");
			return;
		}

		if (suggestion.length >= 200) {
			stopLoading();
			stopLoading = null;
			showTransientAutoPromptStatus(ctx, "Suggestion skipped — too long");
			return;
		}

		if (ctx.ui.getEditorText().length > 0) {
			stopLoading();
			stopLoading = null;
			showTransientAutoPromptStatus(ctx, "Suggestion ready — clear the draft to view it");
			return;
		}

		stopLoading();
		stopLoading = null;
		pi.events.emit("auto-prompt:suggest", { text: suggestion });
	} catch (err: unknown) {
		if (err instanceof Error && err.name === "AbortError") return;
		if (stopLoading) {
			stopLoading();
			stopLoading = null;
		}
		const shortReason = formatAutoPromptError(err);
		showTransientAutoPromptStatus(ctx, "Auto Prompt failed");
		ctx.ui.notify(`Auto Prompt failed: ${shortReason}`, "warning");
	} finally {
		if (stopLoading) stopLoading();
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

	const availableModels = resolveModelSelections();
	if (availableModels.length === 0) {
		ctx.ui.notify("Auto Prompt: no model available", "warning");
		return;
	}

	const requestCandidates = await resolveRequestCandidates(ctx);
	if (requestCandidates.length === 0) {
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
		stopLoading = startLoadingStatus(ctx, "Improving prompt…");
		const prompt = buildImprovementPrompt(
			draft,
			conversationContext,
			filePaths,
			commands,
			phase,
			baselineGuidelines,
		);
		const response = await runWithModelFallback(requestCandidates, async ({ model, apiKey }) => {
			const response = await complete(
				model,
				buildCompletionContext(prompt),
				buildCompletionOptions(model, apiKey, controller.signal),
			);
			ensureCompletionSucceeded(response);
			return response;
		});

		if (controller.signal.aborted) return;

		let improved = extractAssistantOutput(response.content);

		if (!improved) {
			const retryPrompt = `Rewrite this draft into one concise, actionable prompt for a coding agent. Preserve intent. Return only the rewritten prompt text.\n\nDraft: ${draft}`;
			const retryResponse = await runWithModelFallback(requestCandidates, async ({ model, apiKey }) => {
				const retryResponse = await complete(
					model,
					buildCompletionContext(retryPrompt),
					buildCompletionOptions(model, apiKey, controller.signal),
				);
				ensureCompletionSucceeded(retryResponse);
				return retryResponse;
			});

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

		const changed = hasMeaningfulPromptChange(draft, improved);
		ctx.ui.setEditorText(improved);
		ctx.ui.notify(changed ? "Prompt improved" : "Prompt already looked good — no meaningful changes", changed ? "success" : "info");
	} catch (err: unknown) {
		if (err instanceof Error && err.name === "AbortError") return;
		const shortReason = formatAutoPromptError(err);
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
				if (e.data?.model) configuredModel = normalizeConfiguredModel(e.data.model);
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
				const requestedModel: ModelSelection = { provider: parts[0], id: parts[1] };
				const normalizedModel = normalizeConfiguredModel(requestedModel);
				configuredModel = normalizedModel;
				pi.appendEntry("auto-prompt", { enabled, model: configuredModel });
				if (!sameModelSelection(requestedModel, normalizedModel)) {
					ctx.ui.notify(
						`${requestedModel.provider}/${requestedModel.id} is not supported with ChatGPT Codex login. Using ${configuredModel.provider}/${configuredModel.id} instead.`,
						"warning",
					);
					return;
				}
				ctx.ui.notify(`Auto Prompt model set to ${configuredModel.provider}/${configuredModel.id}`, "info");
				return;
			}

			ctx.ui.notify("Usage: /suggest | /suggest model <provider/id> | /suggest now", "info");
		},
	});
}
