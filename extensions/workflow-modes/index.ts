import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type AgentMode = "smart" | "deep" | "fast";


const MODE_LABEL: Record<AgentMode, string> = {
	smart: "Smart",
	deep: "Deep",
	fast: "Fast",
};

const MODE_STATUS_COLOR: Record<AgentMode, "success" | "error" | "warning"> = {
	smart: "success",
	deep: "error",
	fast: "warning",
};

type ModeModelCandidate = { provider: string; model: string };

type ModeProfile = {
	models: ModeModelCandidate[];
	thinking: string;
};

const MODE_PROFILE: Record<AgentMode, ModeProfile> = {
	smart: { models: [{ provider: "anthropic", model: "claude-opus-4-6" }], thinking: "high" },
	deep: {
		models: [
			{ provider: "openai-codex", model: "gpt-5.4" },
			{ provider: "openai-codex", model: "gpt-5.3-codex" },
		],
		thinking: "xhigh",
	},
	fast: { models: [{ provider: "anthropic", model: "claude-sonnet-4-6" }], thinking: "off" },
};

export function normalizeMode(raw: string | undefined): AgentMode | undefined {
	if (!raw) return undefined;
	const value = raw.trim().toLowerCase();
	if (["smart", "s"].includes(value)) return "smart";
	if (["deep", "d"].includes(value)) return "deep";
	if (["fast", "f", "rush", "r"].includes(value)) return "fast";
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

	async function applyMode(
		mode: AgentMode,
		ctx: ExtensionContext,
		options?: { persist?: boolean; notify?: boolean },
	): Promise<void> {
		currentMode = mode;
		pi.setActiveTools(getActiveToolsForMode());

		const profile = MODE_PROFILE[mode];
		let selectedModelCandidate: ModeModelCandidate | undefined;
		let firstUnavailableModel: ModeModelCandidate | undefined;

		for (const candidate of profile.models) {
			const targetModel = ctx.modelRegistry.find(candidate.provider, candidate.model);
			if (!targetModel) continue;

			const ok = await pi.setModel(targetModel);
			if (ok) {
				selectedModelCandidate = candidate;
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

		pi.setThinkingLevel(profile.thinking);
		updateStatus(ctx);
		pi.events.emit("workflow:mode", { mode });

		if (options?.persist !== false) {
			pi.appendEntry("workflow-mode", { mode });
		}

		if (options?.notify !== false) {
			const appliedModel = selectedModelCandidate
				? `${selectedModelCandidate.provider}/${selectedModelCandidate.model}`
				: "current model";
			ctx.ui.notify(`Switched to Mode: ${MODE_LABEL[mode]} (${appliedModel}, ${profile.thinking})`, "info");
		}
	}

	async function cycleMode(ctx: ExtensionContext): Promise<void> {
		const next: AgentMode = currentMode === "smart" ? "deep" : currentMode === "deep" ? "fast" : "smart";
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

	pi.registerFlag("mode", {
		description: "Start in agent mode (smart | deep | fast)",
		type: "string",
	});

	pi.registerShortcut("ctrl+shift+m", {
		description: "Cycle agent mode (Smart/Deep/Fast)",
		handler: async (ctx: ExtensionContext) => {
			await cycleMode(ctx);
		},
	});

	pi.registerCommand("mode", {
		description: "Switch agent mode: smart | deep | fast",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				if (!ctx.hasUI) {
					ctx.ui.notify(`Current mode: ${MODE_LABEL[currentMode]}`, "info");
					return;
				}

				const selected = await ctx.ui.select("Choose agent mode", ["Smart mode", "Deep mode", "Fast mode"]);
				if (!selected) return;
				const selectedMode = selected.startsWith("Smart") ? "smart" : selected.startsWith("Deep") ? "deep" : "fast";
				await applyMode(selectedMode, ctx);
				return;
			}

			if (input.toLowerCase() === "help") {
				ctx.ui.notify("Usage: /mode smart | /mode deep | /mode fast", "info");
				return;
			}

			const mode = normalizeMode(input);
			if (!mode) {
				ctx.ui.notify("Unknown mode. Use: smart, deep, or fast", "error");
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
		description: "Switch agent mode to Deep",
		handler: async (_args, ctx) => {
			await applyMode("deep", ctx);
		},
	});

	pi.registerCommand("deep3", {
		description: "Switch agent mode to Deep (xhigh reasoning)",
		handler: async (_args, ctx) => {
			await applyMode("deep", ctx);
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
