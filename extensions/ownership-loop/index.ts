import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export type OwnershipMode = "passive" | "strict" | "off";
export type OwnershipPhase = "off" | "idle" | "story-requested" | "story-approved" | "changes-detected" | "reown-requested";

export type OwnershipState = {
	active: boolean;
	mode: OwnershipMode;
	task?: string;
	phase: OwnershipPhase;
	changedSinceStory?: boolean;
	reownRequested?: boolean;
	storyApproved?: boolean;
	touchedPaths?: string[];
	memoryCardPending?: boolean;
	memoryCardTitle?: string;
	memoryCardPath?: string;
	memoryCardWriteRequested?: boolean;
	memoryCardWriteObserved?: boolean;
	updatedAt?: string;
};

type SessionEntry = {
	type?: string;
	customType?: string;
	data?: Partial<OwnershipState>;
};

export type OwnershipMemoryReply = { action: "save"; title?: string } | { action: "skip" };
export type ReownCommandOptions = {
	scope?: string;
	remember: boolean;
	title?: string;
};
export type ReownPromptOptions = {
	automatic?: boolean;
	remember?: boolean;
	memoryTitle?: string;
};

const OWNERSHIP_ENTRY_TYPE = "ownership-loop";
const OWNERSHIP_CARD_DIR = "docs/ownership/";
const TRACKED_WRITE_TOOLS = new Set(["edit", "write"]);

function nowIso(): string {
	return new Date().toISOString();
}

function defaultMode(data: Partial<OwnershipState> | undefined): OwnershipMode {
	if (data?.mode) return data.mode;
	if (data && data.active === false) return "off";
	return "passive";
}

function phaseForMode(mode: OwnershipMode, phase?: OwnershipPhase, active?: boolean): OwnershipPhase {
	if (mode === "off" || active === false) return "off";
	return phase && phase !== "off" ? phase : "idle";
}

export function normalizeOwnershipState(data: Partial<OwnershipState> | undefined): OwnershipState {
	const mode = defaultMode(data);
	const active = mode !== "off" && (data?.active ?? true);
	return {
		active,
		mode: active ? mode : "off",
		task: data?.task,
		phase: phaseForMode(active ? mode : "off", data?.phase, active),
		changedSinceStory: data?.changedSinceStory ?? false,
		reownRequested: data?.reownRequested ?? false,
		storyApproved: data?.storyApproved ?? false,
		touchedPaths: [...new Set(data?.touchedPaths ?? [])],
		memoryCardPending: data?.memoryCardPending ?? false,
		memoryCardTitle: data?.memoryCardTitle,
		memoryCardPath: data?.memoryCardPath,
		memoryCardWriteRequested: data?.memoryCardWriteRequested ?? false,
		memoryCardWriteObserved: data?.memoryCardWriteObserved ?? false,
		updatedAt: data?.updatedAt,
	};
}

export function restoreOwnershipState(entries: SessionEntry[]): OwnershipState {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === OWNERSHIP_ENTRY_TYPE) {
			return normalizeOwnershipState(entry.data);
		}
	}
	return normalizeOwnershipState(undefined);
}

export function normalizeOwnershipMode(raw: string | undefined): OwnershipMode | undefined {
	const value = raw?.trim().toLowerCase();
	if (!value) return undefined;
	if (["passive", "on", "auto", "p"].includes(value)) return "passive";
	if (["strict", "s"].includes(value)) return "strict";
	if (["off", "disable", "disabled", "o"].includes(value)) return "off";
	return undefined;
}

function stripWrappedQuotes(value: string): string {
	return value.replace(/^(["'])(.*)\1$/, "$2").trim();
}

export function parseReownArgs(rawArgs: string): ReownCommandOptions {
	let remember = false;
	let titleFromFlag: string | undefined;
	let text = rawArgs.trim();

	text = text.replace(/(^|\s)--remember(?:=([^\s]+))?/gi, (_match, _prefix, rawTitle?: string) => {
		remember = true;
		if (rawTitle && !titleFromFlag) titleFromFlag = stripWrappedQuotes(rawTitle);
		return " ";
	});
	text = text.replace(/(^|\s)-\s*remember\b/gi, () => {
		remember = true;
		return " ";
	});
	if (/^remember\b/i.test(text.trim())) {
		remember = true;
		text = text.trim().replace(/^remember\b/i, "");
	}

	let title = titleFromFlag;
	const titleMatch = text.match(/\btitle\s*:\s*(.+)$/i);
	if (titleMatch?.[1]?.trim()) {
		title = titleMatch[1].trim();
		text = text.slice(0, titleMatch.index).trim();
	}

	const scope = text.replace(/\s+/g, " ").trim() || undefined;
	return { remember, scope, title };
}

function normalizeReownPromptOptions(options: boolean | ReownPromptOptions | undefined): ReownPromptOptions {
	return typeof options === "boolean" ? { automatic: options } : (options ?? {});
}

export function buildOwnPrompt(task: string): string {
	return `Help me own this change before implementation: ${task}

Do not edit files yet. You may search/read repo files and use verification_plan; avoid edit, write, or mutating shell commands.

Create an Initial Change Story that I can approve before coding.

Required output:

1. Outcome — one sentence describing the change.
2. Current story — current behavior and flow in narrative form: actor/input → component/function → behavior/output.
3. Intended story — what flow/rule changes and why; include likely files/functions and how they communicate.
4. Business/workflow rule — the rule that will be true after the change, in plain language.
5. Constraints / non-goals — what should stay unchanged.
6. Proof plan — focused tests, manual checks, and regression gate; if behavior changes, call verification_plan and fold the contract into the story.
7. Risks / unknowns — mark uncertainty and what still needs reading.
8. Approval checkpoint — the specific decision or question I should approve before implementation.

Stop after the story. Do not implement until I approve.`;
}

export function buildReownPrompt(scope: string | undefined, state?: OwnershipState, options: boolean | ReownPromptOptions = false): string {
	const { automatic = false, remember = false, memoryTitle } = normalizeReownPromptOptions(options);
	const subject = scope?.trim() || state?.task || "the current change";
	const memorySubject = memoryTitle?.trim() || subject;
	const memoryPath = buildOwnershipCardPath(memorySubject);
	const automaticContext = automatic
		? "\n\nOwnership loop detected code changes. Re-own the result if useful. If there was no Initial Change Story, reconstruct the intended story from the task and diff."
		: "";
	const touched = state?.touchedPaths?.length
		? `\n\nKnown touched paths from the ownership loop:\n${state.touchedPaths.map((path) => `- ${path}`).join("\n")}`
		: "";
	const editBoundary = remember
		? `Do not edit implementation files. You may write or update only the ownership card at ${memoryPath}.`
		: "Do not edit files.";
	const memoryOutput = remember
		? `\n8. Memory card — after writing ${memoryPath}, report the path and one sentence on what semantic_search should now be able to answer.`
		: "";
	const memoryInstruction = remember
		? `\n\nMemory action requested: after the re-own analysis, write or update ${memoryPath}. Keep it concise and searchable for semantic_search. Use these card sections:\n\n# Ownership Card: ${memorySubject}\n\n## Why this changed\n## System story now\n## Key files / functions\n## Verification evidence\n## How to explain it back\n## Open questions / caveats\n\nDo not ask whether to save a card; writing it is part of this request.`
		: "\n\nDo not ask whether to save an ownership card. If I want searchable memory, I will run /reown --remember.";

	return `Help me re-own the completed change for: ${subject}${automaticContext}${touched}

${editBoundary} Inspect the actual git status/diff and relevant files. Find the latest "Initial Change Story" in this conversation; if none exists, say so and reconstruct the intended story from the task and diff.

Compare the intended story against the actual implementation.

Required output:

1. Change story — narrative: why this changed, old flow → new flow, and the key components/functions that now communicate.
2. Business/workflow rule now — the rule that is actually true after implementation.
3. Diff map — file/function → why it changed and what I should inspect.
4. Story comparison — Intended / Actual / Match? / Notes.
5. What is left — divergences, unproven behavior, manual caveats, or follow-up prompts if needed.
6. Verification evidence — commands/manual checks actually run and results; distinguish planned-but-not-run proof.
7. Ownership path — 2–5 files/functions to read in order to re-own the change.${memoryOutput}${memoryInstruction}

Be concise, specific, and evidence-first. Mark uncertainty. This is a review surface, not a victory lap.`;
}

export function slugifyOwnershipTitle(title: string): string {
	return title
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80) || "current-change";
}

export function buildOwnershipCardPath(title: string): string {
	return `${OWNERSHIP_CARD_DIR}${slugifyOwnershipTitle(title)}.md`;
}

export function buildRememberPrompt(title: string | undefined, state?: OwnershipState): string {
	const subject = title?.trim() || state?.memoryCardTitle || state?.task || "current change";
	const path = buildOwnershipCardPath(subject);
	return `Create an ownership memory card for: ${subject}

Write or update ${path}. Keep it concise and searchable for semantic_search.

Use the latest Initial Change Story, re-own comparison, git diff, and verification evidence from this conversation. If any source is missing, state that uncertainty in the card.

Required card sections:

# Ownership Card: ${subject}

## Why this changed
## System story now
## Key files / functions
## Verification evidence
## How to explain it back
## Open questions / caveats

After writing the card, report the file path and one sentence on what semantic_search should now be able to answer.`;
}

export function parseOwnershipMemoryReply(text: string): OwnershipMemoryReply | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;

	const titleMatch = trimmed.match(/^revise\s+title\s*:\s*(.+)$/i);
	if (titleMatch?.[1]?.trim()) return { action: "save", title: titleMatch[1].trim() };

	const normalized = trimmed.toLowerCase().replace(/[.!]+$/g, "").trim();
	if (["save it", "save this", "remember it", "remember this", "save card", "create card", "yes save it", "yes, save it"].includes(normalized)) {
		return { action: "save" };
	}
	if (["skip", "skip it", "don't save", "dont save", "do not save", "not now"].includes(normalized)) {
		return { action: "skip" };
	}
	return undefined;
}

export function buildOwnershipSystemPrompt(mode: OwnershipMode, state: OwnershipState): string {
	if (mode === "off") return "";
	const base = [
		"Ownership loop is active: optimize for the user retaining authorship, not just receiving a finished diff.",
		"For non-trivial behavior changes, keep a concise change story in view: current flow → intended flow → proof.",
		"For normal task finishes, stay lightweight: summarize changed paths, verification evidence, and uncertainty; do not produce a full re-own report unless asked.",
		"Use /reown when the user asks to explain or compare the completed work; use /reown --remember when the user asks to also save searchable docs/ownership/ memory.",
		"For recall questions about prior decisions or harness behavior, search docs/ownership/ first, then inspect code if needed.",
		"For tiny or docs-only tasks, stay lightweight and avoid ceremony.",
	];

	if (mode === "strict") {
		base.push(
			"Strict mode: before edit/write for behavior-changing work, produce an Initial Change Story and wait for explicit approval. The user can run /own-approve after approving the story.",
		);
	} else if (state.phase === "idle") {
		base.push("Passive mode: do not block execution, but make the work legible enough for the user to re-own afterward.");
	}

	return base.join("\n");
}

export function buildOwnershipStatus(state: OwnershipState): string {
	if (!state.active) return "Ownership loop: off";
	const lines = [
		`Ownership mode: ${state.mode}`,
		`Ownership loop: ${state.phase}`,
		`Task: ${state.task ?? "(not set)"}`,
		`Changed since story: ${state.changedSinceStory ? "yes" : "no"}`,
		`Story approved: ${state.storyApproved ? "yes" : "no"}`,
		`Re-own requested: ${state.reownRequested ? "yes" : "no"}`,
	];
	if (state.touchedPaths?.length) {
		lines.push("Touched paths:", ...state.touchedPaths.map((path) => `- ${path}`));
	}
	if (state.memoryCardPending) {
		lines.push(`Memory card pending: ${state.memoryCardPath ?? buildOwnershipCardPath(state.memoryCardTitle ?? state.task ?? "current change")}`);
	}
	return lines.join("\n");
}

export function shouldTrackToolCall(toolName: string): boolean {
	return TRACKED_WRITE_TOOLS.has(toolName);
}

export function shouldBlockStrictWrite(state: OwnershipState, toolName: string): boolean {
	return state.mode === "strict" && shouldTrackToolCall(toolName) && !state.storyApproved;
}

function extractToolPath(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const candidate = (input as { path?: unknown }).path;
	return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
}

function deliveryOptions(ctx: ExtensionContext): { deliverAs?: "followUp" } | undefined {
	return typeof ctx.isIdle === "function" && ctx.isIdle() ? undefined : { deliverAs: "followUp" };
}

function ownershipCardTitle(title: string | undefined, state: OwnershipState): string {
	return title?.trim() || state.memoryCardTitle || state.task || "current change";
}

function isOwnershipCardPath(path: string | undefined): boolean {
	const normalized = path?.replace(/\\/g, "/").replace(/^\.\//, "");
	return !!normalized && normalized.startsWith(OWNERSHIP_CARD_DIR) && normalized.endsWith(".md");
}

export default function (pi: ExtensionAPI) {
	let state: OwnershipState = normalizeOwnershipState(undefined);
	let lastSessionId: string | undefined;
	let currentCtx: ExtensionContext | undefined;

	function updateStatus(ctx: ExtensionContext): void {
		// Ownership should stay out of the composer/status bar; commands such as
		// /own-status remain available when the user explicitly wants state.
		ctx.ui.setStatus("ownership-loop", undefined);
	}

	function persist(next: OwnershipState, ctx?: ExtensionContext): void {
		state = normalizeOwnershipState({ ...next, updatedAt: nowIso() });
		pi.appendEntry(OWNERSHIP_ENTRY_TYPE, state);
		if (ctx) updateStatus(ctx);
	}

	function setMode(mode: OwnershipMode, ctx: ExtensionContext): void {
		if (mode === "off") {
			persist(normalizeOwnershipState({ active: false, mode: "off", phase: "off" }), ctx);
			return;
		}
		persist(
			normalizeOwnershipState({
				...state,
				active: true,
				mode,
				phase: state.phase === "off" ? "idle" : state.phase,
			}),
			ctx,
		);
	}

	function resetFromSession(ctx: ExtensionContext): void {
		currentCtx = ctx;
		lastSessionId = ctx.sessionManager.getSessionId();
		state = restoreOwnershipState(ctx.sessionManager.getEntries() as SessionEntry[]);
		updateStatus(ctx);
	}

	function syncSession(ctx: ExtensionContext): void {
		const sessionId = ctx.sessionManager.getSessionId();
		if (lastSessionId !== undefined && lastSessionId !== sessionId) {
			state = restoreOwnershipState(ctx.sessionManager.getEntries() as SessionEntry[]);
		}
		lastSessionId = sessionId;
		currentCtx = ctx;
	}

	pi.on("input", async (event, ctx) => {
		syncSession(ctx);
		if (!state.active || state.mode === "off" || !state.memoryCardPending) return;
		if (event.source === "extension") return;
		if (Array.isArray(event.images) && event.images.length > 0) return;

		const reply = parseOwnershipMemoryReply(event.text ?? "");
		if (!reply) return;

		if (reply.action === "skip") {
			persist({ ...state, memoryCardPending: false, memoryCardWriteRequested: false, memoryCardWriteObserved: false }, ctx);
			ctx.ui.notify("Ownership memory card skipped", "info");
			return { action: "handled" as const };
		}

		const title = ownershipCardTitle(reply.title, state);
		const next = normalizeOwnershipState({
			...state,
			memoryCardPending: false,
			memoryCardTitle: title,
			memoryCardPath: buildOwnershipCardPath(title),
			memoryCardWriteRequested: true,
			memoryCardWriteObserved: false,
		});
		persist(next, ctx);
		ctx.ui.notify(`Saving ownership card: ${next.memoryCardPath}`, "info");
		return { action: "transform" as const, text: buildRememberPrompt(title, next) };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		syncSession(ctx);
		if (state.mode === "off") return;
		const addition = buildOwnershipSystemPrompt(state.mode, state);
		const systemPrompt = event.systemPrompt ?? "";
		return {
			systemPrompt: `${systemPrompt}${systemPrompt ? "\n\n" : ""}${addition}`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		resetFromSession(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		resetFromSession(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		syncSession(ctx);
		if (!state.active || state.mode === "off" || !shouldTrackToolCall(event.toolName)) return;

		const path = extractToolPath(event.input);
		if (state.memoryCardWriteRequested && isOwnershipCardPath(path)) {
			if (!state.memoryCardWriteObserved || path !== state.memoryCardPath) {
				persist({ ...state, memoryCardPath: path ?? state.memoryCardPath, memoryCardWriteObserved: true }, ctx);
			}
			return;
		}

		if (shouldBlockStrictWrite(state, event.toolName)) {
			return {
				block: true,
				reason: "Ownership strict mode blocks edit/write until an Initial Change Story is approved. Run /own <task>, review the story, then /own-approve.",
			};
		}

		const touchedPaths = [...new Set([...(state.touchedPaths ?? []), ...(path ? [path] : [])])];
		const alreadyTracked = state.changedSinceStory && touchedPaths.length === (state.touchedPaths?.length ?? 0) && !state.reownRequested;
		if (alreadyTracked) return;

		persist(
			{
				...state,
				active: true,
				phase: "changes-detected",
				changedSinceStory: true,
				reownRequested: false,
				touchedPaths,
			},
			ctx,
		);
	});

	pi.on("agent_end", async (_event, ctx) => {
		syncSession(ctx);
		if (!state.active || state.mode === "off") return;

		if (state.memoryCardWriteRequested) {
			const wroteCard = state.memoryCardWriteObserved;
			persist(
				{
					...state,
					phase: wroteCard ? "idle" : state.phase,
					changedSinceStory: wroteCard ? false : state.changedSinceStory,
					reownRequested: wroteCard ? false : state.reownRequested,
					storyApproved: false,
					touchedPaths: wroteCard ? [] : state.touchedPaths,
					memoryCardPending: false,
					memoryCardWriteRequested: false,
					memoryCardWriteObserved: false,
				},
				ctx,
			);
			if (wroteCard) return;
		}

		if (state.reownRequested) {
			persist(
				{
					...state,
					phase: "idle",
					changedSinceStory: false,
					reownRequested: false,
					storyApproved: false,
					touchedPaths: [],
					memoryCardPending: false,
				},
				ctx,
			);
			return;
		}

		// Passive mode is intentionally quiet: changed files are tracked for
		// explicit /reown without injecting follow-ups or composer status.
		if (!state.changedSinceStory) return;
	});

	pi.registerCommand("own", {
		description: "Start an ownership loop with an Initial Change Story",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!task) {
				ctx.ui.setEditorText("Usage: /own <task to design before implementation>");
				ctx.ui.notify("/own usage written to editor", "info");
				return;
			}

			const next = normalizeOwnershipState({
				active: true,
				mode: state.mode === "off" ? "passive" : state.mode,
				task,
				phase: "story-requested",
				changedSinceStory: false,
				reownRequested: false,
				storyApproved: false,
				touchedPaths: [],
			});
			persist(next, ctx);
			ctx.ui.notify("Ownership loop started — asking for Initial Change Story", "info");
			pi.sendUserMessage(buildOwnPrompt(task), deliveryOptions(ctx));
		},
	});

	pi.registerCommand("own-approve", {
		description: "Mark the current Initial Change Story approved",
		handler: async (_args, ctx) => {
			syncSession(ctx);
			persist({ ...state, active: true, mode: state.mode === "off" ? "passive" : state.mode, phase: "story-approved", storyApproved: true }, ctx);
			ctx.ui.notify("Ownership story approved — edits are allowed", "success");
		},
	});

	pi.registerCommand("own-mode", {
		description: "Set ownership mode: passive | strict | off",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				ctx.ui.setEditorText(["Usage: /own-mode passive | strict | off", "", buildOwnershipStatus(state)].join("\n"));
				ctx.ui.notify("Ownership mode usage written to editor", "info");
				return;
			}

			const mode = normalizeOwnershipMode(input);
			if (!mode) {
				ctx.ui.notify("Unknown ownership mode. Use: passive, strict, or off", "error");
				return;
			}

			setMode(mode, ctx);
			ctx.ui.notify(`Ownership mode set to ${mode}`, "info");
		},
	});

	async function handleReownCommand(args: string, ctx: ExtensionContext): Promise<void> {
		syncSession(ctx);
		const parsed = parseReownArgs(args);
		const scope = parsed.scope || state.task || "current change";
		const memoryTitle = parsed.title?.trim() || scope;
		const next = normalizeOwnershipState({
			...state,
			active: true,
			mode: state.mode === "off" ? "passive" : state.mode,
			task: state.task ?? scope,
			phase: "reown-requested",
			reownRequested: true,
			storyApproved: false,
			memoryCardPending: false,
			memoryCardTitle: parsed.remember ? memoryTitle : state.memoryCardTitle,
			memoryCardPath: parsed.remember ? buildOwnershipCardPath(memoryTitle) : state.memoryCardPath,
			memoryCardWriteRequested: parsed.remember,
			memoryCardWriteObserved: false,
		});
		persist(next, ctx);
		ctx.ui.notify(parsed.remember ? `Asking agent to re-own and remember: ${next.memoryCardPath}` : "Asking agent to re-own the change", "info");
		pi.sendUserMessage(buildReownPrompt(scope, next, { remember: parsed.remember, memoryTitle }), deliveryOptions(ctx));
	}

	pi.registerCommand("reown", {
		description: "Compare the Initial Change Story to the actual diff; add --remember to write an ownership card",
		handler: handleReownCommand,
	});

	pi.registerCommand("re-own", {
		description: "Alias for /reown; add --remember to write an ownership card",
		handler: handleReownCommand,
	});

	pi.registerCommand("own-remember", {
		description: "Draft an ownership memory card under docs/ownership/",
		handler: async (args, ctx) => {
			syncSession(ctx);
			const title = ownershipCardTitle(args.trim() || undefined, state);
			const next = normalizeOwnershipState({
				...state,
				memoryCardPending: false,
				memoryCardTitle: title,
				memoryCardPath: buildOwnershipCardPath(title),
				memoryCardWriteRequested: true,
				memoryCardWriteObserved: false,
			});
			persist(next, ctx);
			ctx.ui.setEditorText(buildRememberPrompt(title, next));
			ctx.ui.notify("Ownership memory-card prompt written to editor", "info");
		},
	});

	pi.registerCommand("own-status", {
		description: "Show current ownership-loop state",
		handler: async (_args, ctx) => {
			syncSession(ctx);
			ctx.ui.setEditorText(buildOwnershipStatus(state));
			ctx.ui.notify("Ownership status written to editor", "info");
		},
	});

	pi.registerCommand("own-off", {
		description: "Turn off the ownership loop for this session",
		handler: async (_args, ctx) => {
			setMode("off", ctx);
			ctx.ui.notify("Ownership loop disabled", "info");
		},
	});

	pi.events.on("ownership:request-state", () => {
		if (!currentCtx) return;
		pi.events.emit("ownership:state", state);
	});
}
