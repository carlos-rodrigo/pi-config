/**
 * Dumb Zone Detector
 *
 * Monitors context window usage and triggers compaction before the agent
 * enters the "dumb zone" — where reasoning quality degrades due to
 * context length.
 *
 * Thresholds (model-specific):
 *
 *   Large context models (Opus 4.6, Sonnet 4.6):
 *     🟢  0–20%  — smart (green)
 *     🔴 20%+    — dumb (red) → auto-triggers compaction
 *
 *   Opus 4.5:
 *     🟢  0–40%  — smart (green)
 *     🔴 40%+    — dumb (red) → auto-triggers compaction
 *
 *   All other models:
 *     🟢  0–100% — smart (green)
 *     🔴 >100%   — dumb (disabled)
 *
 * The bordered editor appends the single active zone label to the
 * context readout, e.g. `31% of 272k . $3.36 - smart`.
 *
 * Updates on: turn_end, agent_end, model_select, workflow:mode, session events.
 *
 * Based on: https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Model-specific thresholds
const LARGE_CONTEXT_MODELS = ["claude-opus-4-6", "claude-sonnet-4-6"];
const OPUS_4_5_MODELS = ["claude-opus-4-5"];

const THRESHOLDS = {
	default: 101,
	largeContext: 20,
	opus45: 40,
} as const;

type DumbZoneContext = {
	ui: {
		theme: { fg(color: string, text: string): string };
		setStatus: (key: string, value: string | undefined) => void;
		notify?: (message: string, level: "info" | "error") => void;
	};
	getContextUsage: () => any;
	sessionManager: { getSessionId(): string };
	model?: { id: string };
	hasUI?: boolean;
	compact: (options?: {
		customInstructions?: string;
		onComplete?: (result: unknown) => void;
		onError?: (error: Error) => void;
	}) => void;
};

function getCompactionThreshold(modelId?: string): number {
	if (modelId && LARGE_CONTEXT_MODELS.some((m) => modelId.includes(m))) {
		return THRESHOLDS.largeContext;
	}
	if (modelId && OPUS_4_5_MODELS.some((m) => modelId.includes(m))) {
		return THRESHOLDS.opus45;
	}
	return THRESHOLDS.default;
}

export function getContextPercent(usage: { percent?: number; tokens: number; contextWindow: number }): number {
	return typeof usage.percent === "number"
		? usage.percent
		: Math.round((usage.tokens / usage.contextWindow) * 100);
}

export function getZoneLabel(pct: number, modelId?: string): "smart" | "dumb" {
	const compaction = getCompactionThreshold(modelId);
	if (pct >= compaction) return "dumb";
	return "smart";
}

const ZONE_COLORS: Record<string, string> = {
	smart: "success",
	dumb: "error",
};

export function getZoneStatus(pct: number, theme: { fg(color: string, text: string): string }, modelId?: string): string {
	const label = getZoneLabel(pct, modelId);
	return theme.fg(ZONE_COLORS[label], label);
}

export default function (pi: ExtensionAPI) {
	let compactionFired = false;
	let lastSessionId: string | undefined;
	let currentModelId: string | undefined;
	let currentCtx: DumbZoneContext | undefined;

	function setStatus(ctx: Pick<DumbZoneContext, "ui">, pct: number) {
		ctx.ui.setStatus("dumb-zone", getZoneStatus(pct, ctx.ui.theme, currentModelId));
	}

	function updateStatus(ctx: DumbZoneContext) {
		currentCtx = ctx;
		if (ctx.model?.id) currentModelId = ctx.model.id;
		const usage = ctx.getContextUsage();
		const pct = usage ? getContextPercent(usage) : 0;
		setStatus(ctx, pct);
	}

	function resetSessionState(ctx?: DumbZoneContext, options?: { freshSession?: boolean }) {
		compactionFired = false;
		if (ctx) {
			currentCtx = ctx;
			lastSessionId = ctx.sessionManager.getSessionId();
			if (options?.freshSession) {
				setStatus(ctx, 0);
				return;
			}
			updateStatus(ctx);
			return;
		}

		if (options?.freshSession && currentCtx) {
			setStatus(currentCtx, 0);
		}
	}

	function syncSessionState(ctx: { sessionManager: { getSessionId(): string } }) {
		const sessionId = ctx.sessionManager.getSessionId();
		if (lastSessionId !== undefined && lastSessionId !== sessionId) {
			compactionFired = false;
		}
		lastSessionId = sessionId;
	}

	// Check after every turn
	pi.on("turn_end", async (_event, ctx: DumbZoneContext) => {
		syncSessionState(ctx);
		updateStatus(ctx);

		if (compactionFired) return;

		const usage = ctx.getContextUsage();
		if (!usage) return;

		const pct = getContextPercent(usage);

		const compaction = getCompactionThreshold(currentModelId);
		if (pct >= compaction) {
			compactionFired = true;

			ctx.compact({
				customInstructions: [
					"Preserve the user's active goal, constraints, decisions, files changed, verification state, blockers, and the next concrete action.",
					"Prefer durable project/task context over low-level command output.",
				].join(" "),
				onComplete: () => {
					if (ctx.hasUI) ctx.ui.notify?.("Compaction completed — continuing in this session.", "info");
					resetSessionState(ctx, { freshSession: true });
				},
				onError: (error) => {
					compactionFired = false;
					if (ctx.hasUI) ctx.ui.notify?.(`Compaction failed: ${error.message}`, "error");
				},
			});
		}
	});

	// Also update on agent end (final reading)
	pi.on("agent_end", async (_event, ctx: DumbZoneContext) => {
		syncSessionState(ctx);
		updateStatus(ctx);
	});

	// Recalculate when the model changes (different context window size).
	pi.on("model_select", async (event, ctx: DumbZoneContext) => {
		syncSessionState(ctx);
		if (event.model?.id) currentModelId = event.model.id;
		const usage = ctx.getContextUsage();
		const pct = usage ? getContextPercent(usage) : 0;

		// Reset compaction gate when new model drops below threshold
		const compaction = getCompactionThreshold(currentModelId);
		if (pct < compaction) compactionFired = false;

		updateStatus(ctx);
	});

	// Update status when workflow mode changes (different model may be selected).
	pi.events.on("workflow:mode", () => {
		if (currentCtx) updateStatus(currentCtx);
	});

	// Reset on new/resumed session and immediately repopulate the legend.
	pi.on("session_switch", async (_event, ctx: DumbZoneContext) => {
		resetSessionState(ctx);
	});

	pi.on("session_start", async (_event, ctx: DumbZoneContext) => {
		resetSessionState(ctx);
	});
}
