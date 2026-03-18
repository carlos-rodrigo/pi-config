import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type WorkflowMode = "design" | "implement";

const BUILT_IN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

const MODE_LABEL: Record<WorkflowMode, string> = {
	design: "Design",
	implement: "Implement",
};

const MODE_STATUS_COLOR: Record<WorkflowMode, "success" | "warning"> = {
	design: "success",
	implement: "warning",
};

const MODE_PROFILE: Record<WorkflowMode, { provider: string; model: string; thinking: "xhigh" | "high" }> = {
	design: { provider: "anthropic", model: "claude-opus-4-6", thinking: "xhigh" },
	implement: { provider: "openai-codex", model: "gpt-5.4", thinking: "high" },
};

const DESIGN_BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const IMPLEMENT_BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

const DESIGN_PROMPT = `
[WORKFLOW MODE: Design]
You are in Design mode.
Goal: build the best design for the problem we are working on before implementation.
Treat the current request as a design task unless the user explicitly asks to switch to implementation.
Be thoughtful, ultrathink, and analyse carefully.
Be concise in progress updates and final responses; prefer short, high-signal answers unless the user asks for more detail.
Focus on:
- understanding the problem and constraints
- evaluating different options and trade-offs
- asking clarifying questions before implementation
- researching current code and alternatives
- producing PRD/design/tasks/research artifacts when needed
- creating or updating planning files when that helps the design flow
Do not implement product code changes in this mode unless the user explicitly asks to switch to implementation.`;

const IMPLEMENT_PROMPT = `
[WORKFLOW MODE: Implement]
You are in Implement mode.
Goal: implement the solution.
Treat the current request as an implementation task unless the user explicitly asks to switch to design.
Be efficient, follow the AGENTS.md development workflow, test your results, and be smart and ultrathink.
Be concise in progress updates and final responses; prefer short, high-signal answers unless the user asks for more detail.
Before implementing, define how you will test your work and define the feedback loop.
Focus on:
- implementing scoped changes in code
- validating with tests/checks when available
- keeping diffs focused and reversible
- reporting what changed and how it was verified.`;

const DESIGN_INTENT_PATTERNS = [
	/^\s*(?:let'?s\s+|please\s+|can you\s+|could you\s+)?(plan|design|spec|research|brainstorm|evaluate|compare|analy[sz]e|review|audit)\b/i,
	/\b(prd|specification|architecture|architect|trade-?offs?|options?|approaches?|proposal|investigate|analysis)\b/i,
	/\b(best approach|different options|compare options|evaluate options)\b/i,
];

const IMPLEMENT_INTENT_PATTERNS = [
	/^\s*(?:please\s+)?(implement|fix|change|edit|update|refactor|add|create|write|rename|remove|wire)\b/i,
	/\b(code|patch|ship|hook up|hook-up|apply the change|make the change)\b/i,
	/\b(bug fix|hotfix|cleanup|rewrite this part)\b/i,
];

const DESIGN_KEYWORDS = [
	"plan",
	"design",
	"spec",
	"prd",
	"architecture",
	"brainstorm",
	"evaluate",
	"compare",
	"option",
	"options",
	"trade-off",
	"tradeoffs",
	"tradeoff",
	"approach",
	"approaches",
	"research",
	"investigate",
	"analysis",
	"analyze",
	"review",
	"audit",
];

const IMPLEMENT_KEYWORDS = [
	"implement",
	"implementation",
	"fix",
	"change",
	"edit",
	"update",
	"refactor",
	"add",
	"create",
	"write",
	"rename",
	"remove",
	"code",
	"patch",
	"ship",
	"hook up",
	"cleanup",
];

export function normalizeMode(raw: string | undefined): WorkflowMode | undefined {
	if (!raw) return undefined;
	const value = raw.trim().toLowerCase();
	if (["design", "d"].includes(value)) return "design";
	if (["implement", "implementation", "build", "building", "i"].includes(value)) return "implement";
	return undefined;
}

function countKeywordHits(text: string, keywords: string[]): number {
	return keywords.reduce((count, keyword) => {
		const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const pattern = keyword.includes(" ") || keyword.includes("-") ? escaped : `\\b${escaped}\\b`;
		return count + (new RegExp(pattern, "i").test(text) ? 1 : 0);
	}, 0);
}

export function detectExplicitModeFromPrompt(text: string): WorkflowMode | undefined {
	const normalized = text.trim().toLowerCase();
	if (!normalized || normalized.startsWith("/")) return undefined;

	const switchMatch = normalized.match(
		/\b(?:switch(?:\s+workflow)?\s+mode\s+to|switch\s+to|change\s+(?:the\s+)?mode\s+to|set\s+(?:the\s+)?mode\s+to)\s+(design|d|implement|implementation|build|building|i)\b/,
	);
	if (switchMatch) {
		return normalizeMode(switchMatch[1]);
	}

	const labelMatch = normalized.match(/^(?:mode\s*:\s*|)(design|d|implement|implementation|build|building|i)\s*:/);
	if (labelMatch) {
		return normalizeMode(labelMatch[1]);
	}

	const directLabelMatch = normalized.match(/^mode\s*:\s*(design|d|implement|implementation|build|building|i)\b/);
	if (directLabelMatch) {
		return normalizeMode(directLabelMatch[1]);
	}

	return undefined;
}

export function detectModeFromPrompt(text: string): WorkflowMode | undefined {
	const normalized = text.trim().toLowerCase();
	if (!normalized || normalized.startsWith("/")) return undefined;

	const explicitMode = detectExplicitModeFromPrompt(normalized);
	if (explicitMode) return explicitMode;

	const designPatternHit = DESIGN_INTENT_PATTERNS.some((pattern) => pattern.test(normalized));
	const implementPatternHit = IMPLEMENT_INTENT_PATTERNS.some((pattern) => pattern.test(normalized));

	if (designPatternHit && !implementPatternHit) return "design";
	if (implementPatternHit && !designPatternHit) return "implement";
	if (designPatternHit && implementPatternHit) return undefined;

	const designScore = countKeywordHits(normalized, DESIGN_KEYWORDS);
	const implementScore = countKeywordHits(normalized, IMPLEMENT_KEYWORDS);

	if (designScore >= 2 && implementScore === 0) return "design";
	if (implementScore >= 2 && designScore === 0) return "implement";
	if (designScore >= 3 && designScore >= implementScore + 2) return "design";
	if (implementScore >= 3 && implementScore >= designScore + 2) return "implement";

	return undefined;
}

function buildModeContextMessage(mode: WorkflowMode, prompt: string): string {
	const request = prompt.trim();

	if (mode === "design") {
		return `[WORKFLOW MODE CONTEXT]
Current mode: Design
Treat the user's latest request as a design task.
Goal: build the best design for the problem we are working on before implementation.
Mindset: be thoughtful, ultrathink, and analyse carefully.
Requirements:
- keep responses concise and high-signal unless the user asks for more detail
Priorities:
- understand the problem and constraints
- evaluate different options and trade-offs
- ask clarifying questions when requirements are unclear
- create or update planning artifacts when useful (PRDs, research notes, technical designs, task files)
- avoid product code changes unless the user explicitly asks to switch to implementation
${request ? `User request:\n${request}` : ""}`;
	}

	return `[WORKFLOW MODE CONTEXT]
Current mode: Implement
Treat the user's latest request as an implementation task.
Goal: implement the solution.
Mindset: be efficient, smart, and ultrathink.
Requirements:
- follow the AGENTS.md development workflow
- before implementing, define how you will test your work
- define the feedback loop before implementation
- test your results
- keep responses concise and high-signal unless the user asks for more detail
Priorities:
- make the scoped code changes
- validate with tests or checks when available
- keep changes focused and reversible
- report what changed and how it was verified
${request ? `User request:\n${request}` : ""}`;
}

export function isSafeDesignCommand(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return false;

	const cdPrefixMatch = trimmed.match(/^cd\s+([^;&|]+)\s*&&\s*(.+)$/i);
	if (cdPrefixMatch) {
		return isSafeDesignCommand(cdPrefixMatch[2]!);
	}

	const destructivePatterns = [
		/(^|\s)(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|chgrp|ln|dd|truncate|tee)(\s|$)/i,
		/(^|[^<])>(?!>)/,
		/>>/,
		/(^|\s)(sudo|su|kill|pkill|killall|reboot|shutdown)(\s|$)/i,
		/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag|init|clone)\b/i,
		/\bnpm\s+(install|uninstall|update|ci|link|publish)\b/i,
		/\byarn\s+(add|remove|install|upgrade|publish)\b/i,
		/\bpnpm\s+(add|remove|install|update)\b/i,
	];

	if (destructivePatterns.some((p) => p.test(trimmed))) return false;

	const safeStarts = [
		/^cat\b/i,
		/^head\b/i,
		/^tail\b/i,
		/^less\b/i,
		/^more\b/i,
		/^grep\b/i,
		/^rg\b/i,
		/^find\b/i,
		/^fd\b/i,
		/^ls\b/i,
		/^pwd\b/i,
		/^tree\b/i,
		/^stat\b/i,
		/^du\b/i,
		/^df\b/i,
		/^which\b/i,
		/^whereis\b/i,
		/^env\b/i,
		/^printenv\b/i,
		/^uname\b/i,
		/^whoami\b/i,
		/^date\b/i,
		/^echo\b/i,
		/^printf\b/i,
		/^wc\b/i,
		/^sort\b/i,
		/^uniq\b/i,
		/^sed\s+-n\b/i,
		/^awk\b/i,
		/^git\s+(status|log|diff|show|branch|remote|config\s+--get)\b/i,
		/^npm\s+(test|ls|list|outdated|view|info|search)\b/i,
		/^yarn\s+(test|list|info|why)\b/i,
		/^pnpm\s+(test|list|why)\b/i,
	];

	return safeStarts.some((p) => p.test(trimmed));
}

export default function (pi: ExtensionAPI) {
	let currentMode: WorkflowMode = "implement";
	let currentCtx: ExtensionContext | undefined;

	function updateStatus(ctx: ExtensionContext): void {
		const label = MODE_LABEL[currentMode];
		const color = MODE_STATUS_COLOR[currentMode];
		ctx.ui.setStatus("workflow-mode", ctx.ui.theme.fg(color, `mode: ${label}`));
	}

	function getActiveToolsForMode(mode: WorkflowMode): string[] {
		const base = mode === "design" ? DESIGN_BUILTINS : IMPLEMENT_BUILTINS;
		const customTools = pi
			.getAllTools()
			.map((tool) => tool.name)
			.filter((name) => !BUILT_IN_TOOLS.has(name));
		return [...new Set([...base, ...customTools])];
	}

	async function applyMode(
		mode: WorkflowMode,
		ctx: ExtensionContext,
		options?: { persist?: boolean; notify?: boolean },
	): Promise<void> {
		currentMode = mode;
		pi.setActiveTools(getActiveToolsForMode(mode));

		const profile = MODE_PROFILE[mode];
		const targetModel = ctx.modelRegistry.find(profile.provider, profile.model);
		if (targetModel) {
			const ok = await pi.setModel(targetModel);
			if (!ok) {
				ctx.ui.notify(
					`Mode ${MODE_LABEL[mode]}: no API key for ${profile.provider}/${profile.model}. Keeping current model.`,
					"warning",
				);
			}
		} else {
			ctx.ui.notify(
				`Mode ${MODE_LABEL[mode]}: model ${profile.provider}/${profile.model} not found. Keeping current model.`,
				"warning",
			);
		}

		pi.setThinkingLevel(profile.thinking);
		updateStatus(ctx);
		pi.events.emit("workflow:mode", { mode });

		if (options?.persist !== false) {
			pi.appendEntry("workflow-mode", { mode });
		}

		if (options?.notify !== false) {
			ctx.ui.notify(
				`Switched to Mode: ${MODE_LABEL[mode]} (${profile.provider}/${profile.model}, ${profile.thinking})`,
				"info",
			);
		}
	}

	async function cycleMode(ctx: ExtensionContext): Promise<void> {
		const next: WorkflowMode = currentMode === "design" ? "implement" : "design";
		await applyMode(next, ctx);
	}

	function restoreModeFromSession(ctx: ExtensionContext): WorkflowMode | undefined {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as { type?: string; customType?: string; data?: { mode?: string } };
			if (entry.type === "custom" && entry.customType === "workflow-mode") {
				return normalizeMode(entry.data?.mode);
			}
		}
		return undefined;
	}

	pi.registerFlag("mode", {
		description: "Start in workflow mode (design or implement)",
		type: "string",
	});

	const cycleModeShortcut = {
		description: "Cycle workflow mode (Design/Implement)",
		handler: async (ctx: ExtensionContext) => {
			await cycleMode(ctx);
		},
	};

	pi.registerShortcut("ctrl+shift+m", cycleModeShortcut);

	const switchModeCommand = {
		description: "Switch workflow mode: design | implement",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				if (!ctx.hasUI) {
					ctx.ui.notify(`Current mode: ${MODE_LABEL[currentMode]}`, "info");
					return;
				}

				const selected = await ctx.ui.select("Choose workflow mode", ["Design mode", "Implement mode"]);
				if (!selected) return;
				await applyMode(selected.startsWith("Design") ? "design" : "implement", ctx);
				return;
			}

			if (input.toLowerCase() === "help") {
				ctx.ui.notify("Usage: /mode design | /mode implement", "info");
				return;
			}

			const mode = normalizeMode(input);
			if (!mode) {
				ctx.ui.notify("Unknown mode. Use: design or implement", "error");
				return;
			}

			await applyMode(mode, ctx);
		},
	};

	pi.registerCommand("mode", switchModeCommand);
	pi.registerCommand("design", {
		description: "Switch workflow mode to Design",
		handler: async (_args, ctx) => {
			await applyMode("design", ctx);
		},
	});
	pi.registerCommand("implement", {
		description: "Switch workflow mode to Implement",
		handler: async (_args, ctx) => {
			await applyMode("implement", ctx);
		},
	});

	pi.on("input", async (event, ctx) => {
		currentCtx = ctx;

		if (event.source === "extension") {
			return { action: "continue" };
		}

		const detectedMode = detectModeFromPrompt(event.text);
		if (!detectedMode || detectedMode === currentMode) {
			return { action: "continue" };
		}

		await applyMode(detectedMode, ctx, { notify: false });
		ctx.ui.notify(`Detected mode for this request: ${MODE_LABEL[detectedMode]}`, "info");
		return { action: "continue" };
	});

	pi.on("tool_call", async (event) => {
		if (currentMode !== "design") return;

		if (event.toolName === "bash") {
			const command = (event.input as { command?: string }).command ?? "";
			if (!isSafeDesignCommand(command)) {
				return {
					block: true,
					reason: `Mode: Design allows read-only bash commands only. Blocked: ${command}`,
				};
			}
		}
	});

	pi.on("before_agent_start", async (event) => {
		const suffix = currentMode === "design" ? DESIGN_PROMPT : IMPLEMENT_PROMPT;
		return {
			message: {
				customType: "workflow-mode-context",
				content: buildModeContextMessage(currentMode, event.prompt),
				display: false,
			},
			systemPrompt: `${event.systemPrompt}${suffix}`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;

		const flagMode = normalizeMode(pi.getFlag("mode") as string | undefined);
		const restoredMode = restoreModeFromSession(ctx);
		const mode = flagMode ?? restoredMode ?? currentMode;

		await applyMode(mode, ctx, { persist: false, notify: false });
	});

	pi.events.on("workflow:request-mode", () => {
		if (!currentCtx) return;
		pi.events.emit("workflow:mode", { mode: currentMode });
	});
}
