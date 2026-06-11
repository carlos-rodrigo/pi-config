import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type AgentMode = "smart" | "deep1" | "deep2" | "deep3" | "fast";
type ModelLike = { provider?: string; id?: string; model?: string } | undefined;

const MODE_LABEL: Record<AgentMode, string> = {
	smart: "Smart",
	deep1: "Deep¹",
	deep2: "Deep²",
	deep3: "Deep³",
	fast: "Fast",
};

const MODE_STATUS_COLOR: Record<AgentMode, "success" | "error" | "warning"> = {
	smart: "success",
	deep1: "error",
	deep2: "error",
	deep3: "error",
	fast: "warning",
};

type ModeModelCandidate = { provider: string; model: string; thinking?: string };

type ModeProfile = {
	models: ModeModelCandidate[];
	thinking: string;
};

const MODE_PROFILE: Record<AgentMode, ModeProfile> = {
	smart: {
		models: [
			{ provider: "openai-codex", model: "gpt-5.5" },
			{ provider: "openai-codex", model: "gpt-5.4", thinking: "medium" },
			{ provider: "anthropic", model: "claude-opus-4-5", thinking: "high" },
		],
		thinking: "low",
	},
	deep1: {
		models: [
			{ provider: "openai-codex", model: "gpt-5.5" },
			{ provider: "openai-codex", model: "gpt-5.4", thinking: "medium" },
			{ provider: "anthropic", model: "claude-opus-4-5", thinking: "high" },
		],
		thinking: "low",
	},
	deep2: {
		models: [
			{ provider: "openai-codex", model: "gpt-5.5" },
			{ provider: "openai-codex", model: "gpt-5.4", thinking: "high" },
			{ provider: "openai-codex", model: "gpt-5.3-codex", thinking: "xhigh" },
		],
		thinking: "medium",
	},
	deep3: {
		models: [
			{ provider: "openai-codex", model: "gpt-5.5" },
			{ provider: "openai-codex", model: "gpt-5.4" },
			{ provider: "openai-codex", model: "gpt-5.3-codex" },
		],
		thinking: "xhigh",
	},
	fast: { models: [{ provider: "anthropic", model: "claude-sonnet-4-6" }], thinking: "off" },
};

const MODE_CYCLE: AgentMode[] = ["smart", "deep1", "deep2", "deep3", "fast"];

export function normalizeMode(raw: string | undefined): AgentMode | undefined {
	if (!raw) return undefined;
	const value = raw.trim().toLowerCase();
	if (["smart", "s"].includes(value)) return "smart";
	if (["deep1", "deep¹", "d1"].includes(value)) return "deep1";
	if (["deep", "deep2", "deep²", "d", "d2"].includes(value)) return "deep2";
	if (["deep3", "deep³", "d3"].includes(value)) return "deep3";
	if (["fast", "f", "rush", "r"].includes(value)) return "fast";
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

function inferModeFromModel(model: ModelLike): AgentMode | undefined {
	const modelId = getModelId(model);
	if (!model?.provider || !modelId) return undefined;

	for (const [mode, profile] of Object.entries(MODE_PROFILE) as [AgentMode, ModeProfile][]) {
		if (profile.models.some((candidate) => candidate.provider === model.provider && candidate.model === modelId)) {
			return mode;
		}
	}

	return undefined;
}

export default function (pi: ExtensionAPI) {
	let currentMode: AgentMode = "smart";
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
		let selectedModelCandidate: ModeModelCandidate | undefined;
		let selectedThinking = profile.thinking;
		let firstUnavailableModel: ModeModelCandidate | undefined;

		for (const candidate of profile.models) {
			const targetModel = ctx.modelRegistry.find(candidate.provider, candidate.model);
			if (!targetModel) continue;

			const ok = await pi.setModel(targetModel);
			if (ok) {
				selectedModelCandidate = candidate;
				selectedThinking = candidate.thinking ?? profile.thinking;
				break;
			}

			if (!firstUnavailableModel) firstUnavailableModel = candidate;
		}

		if (!selectedModelCandidate) {
			if (firstUnavailableModel) {
				ctx.ui.notify(
					`Mode ${MODE_LABEL[mode]}: no API key for ${firstUnavailableModel.provider}/${firstUnavailableModel.model}. Keeping current model.`,
					"warning",
				);
			} else {
				const requestedModels = profile.models.map((candidate) => `${candidate.provider}/${candidate.model}`).join(" or ");
				ctx.ui.notify(
					`Mode ${MODE_LABEL[mode]}: models ${requestedModels} not found. Keeping current model.`,
					"warning",
				);
			}
		}

		pi.setThinkingLevel(selectedThinking);
		syncModeState(ctx);

		if (options?.persist !== false) {
			pi.appendEntry("workflow-mode", { mode });
		}

		if (options?.notify !== false) {
			const appliedModel = selectedModelCandidate
				? `${selectedModelCandidate.provider}/${selectedModelCandidate.model}`
				: "current model";
			ctx.ui.notify(`Switched to Mode: ${MODE_LABEL[mode]} (${appliedModel}, ${selectedThinking})`, "info");
		}
	}

	async function cycleMode(ctx: ExtensionContext): Promise<void> {
		const currentIndex = MODE_CYCLE.indexOf(currentMode);
		const next = MODE_CYCLE[(currentIndex + 1) % MODE_CYCLE.length] ?? "smart";
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
		description: "Start in agent mode (smart | deep1 | deep2 | deep3 | fast)",
		type: "string",
	});

	pi.registerShortcut("ctrl+shift+m", {
		description: "Cycle agent mode (Smart/Deep¹/Deep²/Deep³/Fast)",
		handler: async (ctx: ExtensionContext) => {
			await cycleMode(ctx);
		},
	});

	pi.registerCommand("mode", {
		description: "Switch agent mode: smart | deep1 | deep2 | deep3 | fast",
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
				await applyMode(MODE_CYCLE[selectedIndex] ?? "smart", ctx);
				return;
			}

			if (input.toLowerCase() === "help") {
				ctx.ui.notify("Usage: /mode smart | /mode deep1 | /mode deep2 | /mode deep3 | /mode fast", "info");
				return;
			}

			const mode = normalizeMode(input);
			if (!mode) {
				ctx.ui.notify("Unknown mode. Use: smart, deep1, deep2, deep3, or fast", "error");
				return;
			}

			await applyMode(mode, ctx);
		},
	});

	pi.registerCommand("smart", {
		description: "Switch agent mode to Smart",
		handler: async (_args, ctx) => {
			await applyMode("smart", ctx);
		},
	});

	pi.registerCommand("deep", {
		description: "Switch agent mode to Deep² (medium reasoning)",
		handler: async (_args, ctx) => {
			await applyMode("deep2", ctx);
		},
	});

	pi.registerCommand("deep1", {
		description: "Switch agent mode to Deep¹ (low reasoning)",
		handler: async (_args, ctx) => {
			await applyMode("deep1", ctx);
		},
	});

	pi.registerCommand("deep2", {
		description: "Switch agent mode to Deep² (medium reasoning)",
		handler: async (_args, ctx) => {
			await applyMode("deep2", ctx);
		},
	});

	pi.registerCommand("deep3", {
		description: "Switch agent mode to Deep³ (xhigh reasoning)",
		handler: async (_args, ctx) => {
			await applyMode("deep3", ctx);
		},
	});

	pi.registerCommand("fast", {
		description: "Switch agent mode to Fast",
		handler: async (_args, ctx) => {
			await applyMode("fast", ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;

		const flagMode = getModeFlag(pi);
		const restoredMode = restoreModeFromSession(ctx);
		const inferredMode = inferModeFromModel(ctx.model as ModelLike);

		if (hasExplicitStartupOverrides() && !flagMode) {
			currentMode = inferredMode ?? currentMode;
			syncModeState(ctx);
			return;
		}

		const mode = flagMode ?? restoredMode ?? inferredMode ?? currentMode;
		await applyMode(mode, ctx, { persist: false, notify: false });
	});

	pi.events.on("workflow:request-mode", () => {
		if (!currentCtx) return;
		pi.events.emit("workflow:mode", { mode: currentMode, label: MODE_LABEL[currentMode] });
	});
}
