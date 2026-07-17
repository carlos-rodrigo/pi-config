import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { recommendModeFromArchive } from "../self-improvement-archive/index.ts";

type AgentMode = "fast" | "smart" | "deep3" | "max";
type ModelLike = { provider?: string; id?: string; model?: string } | undefined;

const MODE_LABEL: Record<AgentMode, string> = {
	fast: "Fast",
	smart: "Smart",
	deep3: "Deep³",
	max: "Max",
};

type ModeStatusColor = "thinkingMedium" | "thinkingHigh" | "thinkingXhigh" | "thinkingMax";

const MODE_STATUS_COLOR: Record<AgentMode, ModeStatusColor> = {
	fast: "thinkingMedium",
	smart: "thinkingHigh",
	deep3: "thinkingXhigh",
	max: "thinkingMax",
};

type ModeModel = { provider: string; model: string };

type ModeProfile = {
	model: ModeModel;
	thinking: ThinkingLevel;
};

const SOL_MODEL: ModeModel = { provider: "openai-codex", model: "gpt-5.6-sol" };

const MODE_PROFILE: Record<AgentMode, ModeProfile> = {
	fast: { model: SOL_MODEL, thinking: "medium" },
	smart: { model: SOL_MODEL, thinking: "high" },
	deep3: { model: SOL_MODEL, thinking: "xhigh" },
	max: { model: SOL_MODEL, thinking: "max" },
};

const MODE_CYCLE: AgentMode[] = ["fast", "smart", "deep3", "max"];

export function normalizeMode(raw: string | undefined): AgentMode | undefined {
	if (!raw) return undefined;
	const value = raw.trim().toLowerCase();
	if (["fast", "f", "rush", "r"].includes(value)) return "fast";
	if (["smart", "s"].includes(value)) return "smart";
	if (["deep", "deep3", "deep³", "d", "d3"].includes(value)) return "deep3";
	if (["max", "maximum"].includes(value)) return "max";
	return undefined;
}

function getModeFlag(pi: ExtensionAPI): AgentMode | undefined {
	return normalizeMode(
		(pi.getFlag("workflow-mode") as string | undefined) ?? (pi.getFlag("mode") as string | undefined),
	);
}

function hasExplicitStartupOverrides(argv: string[] = process.argv.slice(2)): boolean {
	const hasFlag = (name: string) => argv.some((arg) => arg === name || arg.startsWith(`${name}=`));
	return hasFlag("--model") || hasFlag("--models") || hasFlag("--thinking");
}

function getModelId(model: ModelLike): string | undefined {
	if (!model) return undefined;
	return model.id ?? model.model;
}

function inferModeFromModel(model: ModelLike, thinking?: ThinkingLevel | "off"): AgentMode | undefined {
	const modelId = getModelId(model);
	if (!model?.provider || !modelId) return undefined;

	const matches = (Object.entries(MODE_PROFILE) as [AgentMode, ModeProfile][]).filter(([, profile]) =>
		profile.model.provider === model.provider && profile.model.model === modelId,
	);

	return matches.find(([, profile]) => profile.thinking === thinking)?.[0] ?? matches[0]?.[0];
}

export default function (pi: ExtensionAPI) {
	let currentMode: AgentMode = "fast";
	let currentCtx: ExtensionContext | undefined;

	function updateStatus(ctx: ExtensionContext): void {
		const label = MODE_LABEL[currentMode];
		const color = MODE_STATUS_COLOR[currentMode];
		ctx.ui.setStatus("workflow-mode", ctx.ui.theme.fg(color, `mode: ${label}`));
	}

	function getActiveToolsForMode(): string[] {
		return [...new Set(pi.getAllTools().map((tool) => tool.name))];
	}

	function syncModeState(ctx: ExtensionContext): void {
		pi.setActiveTools(getActiveToolsForMode());
		updateStatus(ctx);
		pi.events.emit("workflow:mode", { mode: currentMode, label: MODE_LABEL[currentMode] });
	}

	async function applyMode(
		mode: AgentMode,
		ctx: ExtensionContext,
		options?: { persist?: boolean; notify?: boolean },
	): Promise<void> {
		currentMode = mode;

		const profile = MODE_PROFILE[mode];
		const targetModel = ctx.modelRegistry.find(profile.model.provider, profile.model.model);
		const modelApplied = targetModel ? await pi.setModel(targetModel) : false;

		if (!targetModel) {
			ctx.ui.notify(
				`Mode ${MODE_LABEL[mode]}: model ${profile.model.provider}/${profile.model.model} not found. Keeping current model.`,
				"warning",
			);
		} else if (!modelApplied) {
			ctx.ui.notify(
				`Mode ${MODE_LABEL[mode]}: no API key for ${profile.model.provider}/${profile.model.model}. Keeping current model.`,
				"warning",
			);
		}

		pi.setThinkingLevel(profile.thinking);
		syncModeState(ctx);

		if (options?.persist !== false) {
			pi.appendEntry("workflow-mode", { mode });
		}

		if (options?.notify !== false) {
			const appliedModel = modelApplied ? `${profile.model.provider}/${profile.model.model}` : "current model";
			ctx.ui.notify(`Switched to Mode: ${MODE_LABEL[mode]} (${appliedModel}, ${profile.thinking})`, "info");
		}
	}

	async function cycleMode(ctx: ExtensionContext): Promise<void> {
		const currentIndex = MODE_CYCLE.indexOf(currentMode);
		const next = MODE_CYCLE[(currentIndex + 1) % MODE_CYCLE.length] ?? "fast";
		await applyMode(next, ctx);
	}

	function restoreModeFromSession(ctx: ExtensionContext): AgentMode | undefined {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as { type?: string; customType?: string; data?: { mode?: string } };
			if (entry.type === "custom" && entry.customType === "workflow-mode") {
				return normalizeMode(entry.data?.mode);
			}
		}
		return undefined;
	}

	pi.registerFlag("workflow-mode", {
		description: "Start in agent mode (fast | smart | deep3 | max)",
		type: "string",
	});

	pi.registerShortcut("ctrl+shift+m", {
		description: "Cycle agent mode (Fast/Smart/Deep³/Max)",
		handler: async (ctx: ExtensionContext) => {
			await cycleMode(ctx);
		},
	});

	pi.registerCommand("mode", {
		description: "Switch agent mode: fast | smart | deep3 | max",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				if (!ctx.hasUI) {
					ctx.ui.notify(`Current mode: ${MODE_LABEL[currentMode]}`, "info");
					return;
				}

				const choices = MODE_CYCLE.map((mode) => `${MODE_LABEL[mode]} mode`);
				const selected = await ctx.ui.select("Choose agent mode", choices);
				if (!selected) return;
				const selectedIndex = choices.indexOf(selected);
				await applyMode(MODE_CYCLE[selectedIndex] ?? "fast", ctx);
				return;
			}

			if (input.toLowerCase() === "help") {
				ctx.ui.notify("Usage: /mode fast | /mode smart | /mode deep3 | /mode max | /mode recommend", "info");
				return;
			}

			if (["recommend", "why"].includes(input.toLowerCase())) {
				const recommendation = recommendModeFromArchive(ctx.cwd);
				ctx.ui.notify(`Recommended mode: ${MODE_LABEL[recommendation.mode]} — ${recommendation.reason}`, "info");
				ctx.ui.setEditorText?.(`Recommended mode: ${recommendation.mode}\n\n${recommendation.reason}\n\nRun /${recommendation.mode} to switch if you agree.`);
				return;
			}

			const mode = normalizeMode(input);
			if (!mode) {
				ctx.ui.notify("Unknown mode. Use: fast, smart, deep3, or max", "error");
				return;
			}

			await applyMode(mode, ctx);
		},
	});

	pi.registerCommand("smart", {
		description: "Switch agent mode to Smart (high reasoning)",
		handler: async (_args, ctx) => {
			await applyMode("smart", ctx);
		},
	});

	pi.registerCommand("deep", {
		description: "Switch agent mode to Deep³ (xhigh reasoning)",
		handler: async (_args, ctx) => {
			await applyMode("deep3", ctx);
		},
	});

	pi.registerCommand("deep3", {
		description: "Switch agent mode to Deep³ (xhigh reasoning)",
		handler: async (_args, ctx) => {
			await applyMode("deep3", ctx);
		},
	});

	pi.registerCommand("max", {
		description: "Switch agent mode to Max (max reasoning)",
		handler: async (_args, ctx) => {
			await applyMode("max", ctx);
		},
	});

	pi.registerCommand("fast", {
		description: "Switch agent mode to Fast (medium reasoning)",
		handler: async (_args, ctx) => {
			await applyMode("fast", ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;

		const flagMode = getModeFlag(pi);
		const restoredMode = restoreModeFromSession(ctx);
		const inferredMode = inferModeFromModel(ctx.model as ModelLike, pi.getThinkingLevel());

		if (hasExplicitStartupOverrides() && !flagMode) {
			currentMode = inferredMode ?? currentMode;
			syncModeState(ctx);
			return;
		}

		const mode = flagMode ?? restoredMode ?? currentMode;
		await applyMode(mode, ctx, { persist: false, notify: false });
	});

	pi.on("session_shutdown", async () => {
		currentCtx = undefined;
	});

	pi.events.on("workflow:request-mode", () => {
		if (!currentCtx) return;
		pi.events.emit("workflow:mode", { mode: currentMode, label: MODE_LABEL[currentMode] });
	});
}
