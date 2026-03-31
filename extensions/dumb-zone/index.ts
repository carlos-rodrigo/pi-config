/**
 * Dumb Zone Detector
 *
 * Monitors context window usage and forces a handoff before the agent
 * enters the "dumb zone" — where reasoning quality degrades due to
 * context length.
 *
 * Thresholds (model-specific):
 *
 *   Default models:
 *     🟢  0–40%  — smart (green)
 *     🔴 40%+    — dumb (red) → auto-triggers handoff
 *
 *   Large context models (Opus 4.5, Sonnet 4.6):
 *     🟢  0–20%  — smart (green)
 *     🔴 20%+    — dumb (red) → auto-triggers handoff
 *
 * The bordered editor appends the single active zone label to the
 * context readout, e.g. `31% of 272k . $3.36 - smart`.
 *
 * Updates on: turn_end, agent_end, model_select, workflow:mode, session events.
 *
 * Based on: https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { HANDOFF_SESSION_STARTED_EVENT } from "../handoff/events.ts";

// Model-specific thresholds: large-context models get stricter limits
const LARGE_CONTEXT_MODELS = ["claude-opus-4-5", "claude-sonnet-4-6"];

const THRESHOLDS = {
	default: 40,
	largeContext: 20,
} as const;

function getHandoffThreshold(modelId?: string): number {
	if (modelId && LARGE_CONTEXT_MODELS.some((m) => modelId.includes(m))) {
		return THRESHOLDS.largeContext;
	}
	return THRESHOLDS.default;
}

export function getContextPercent(usage: { percent?: number; tokens: number; contextWindow: number }): number {
	return typeof usage.percent === "number"
		? usage.percent
		: Math.round((usage.tokens / usage.contextWindow) * 100);
}

export function getZoneLabel(pct: number, modelId?: string): "smart" | "dumb" {
	const handoff = getHandoffThreshold(modelId);
	if (pct >= handoff) return "dumb";
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
	let handoffFired = false;
	let lastSessionId: string | undefined;
	let currentModelId: string | undefined;
	let currentCtx:
		| {
				ui: {
					theme: { fg(color: string, text: string): string };
					setStatus: (key: string, value: string | undefined) => void;
				};
				getContextUsage: () => any;
				sessionManager: { getSessionId(): string };
				model?: { id: string };
		  }
		| undefined;

	function setStatus(
		ctx: {
			ui: {
				theme: { fg(color: string, text: string): string };
				setStatus: (key: string, value: string | undefined) => void;
			};
		},
		pct: number,
	) {
		ctx.ui.setStatus("dumb-zone", getZoneStatus(pct, ctx.ui.theme, currentModelId));
	}

	function updateStatus(ctx: { ui: { theme: { fg(color: string, text: string): string }; setStatus: (key: string, value: string | undefined) => void }; getContextUsage: () => any; sessionManager: { getSessionId(): string }; model?: { id: string } }) {
		currentCtx = ctx;
		if (ctx.model?.id) currentModelId = ctx.model.id;
		const usage = ctx.getContextUsage();
		const pct = usage ? getContextPercent(usage) : 0;
		setStatus(ctx, pct);
	}

	function resetSessionState(
		ctx?: {
			ui: {
				theme: { fg(color: string, text: string): string };
				setStatus: (key: string, value: string | undefined) => void;
			};
			getContextUsage: () => any;
			sessionManager: { getSessionId(): string };
		},
		options?: { freshSession?: boolean },
	) {
		handoffFired = false;
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
			handoffFired = false;
		}
		lastSessionId = sessionId;
	}

	// Check after every turn
	pi.on("turn_end", async (_event, ctx) => {
		syncSessionState(ctx);
		updateStatus(ctx);

		if (handoffFired) return;

		const usage = ctx.getContextUsage();
		if (!usage) return;

		const pct = getContextPercent(usage);

		const handoff = getHandoffThreshold(currentModelId);
		if (pct >= handoff) {
			handoffFired = true;

			pi.sendMessage(
				{
					customType: "dumb-zone-alert",
					content: [
						`⚠️ CONTEXT AT ${pct}% — DUMB ZONE.`,
						"",
						"Your reasoning is degrading. You MUST hand off immediately:",
						"1. Summarize your progress, decisions, files changed, and remaining work.",
						"2. Call the `handoff` tool with that summary as the goal.",
						"3. Do NOT continue working — your output quality is compromised.",
					].join("\n"),
					display: true,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		}
	});

	// Also update on agent end (final reading)
	pi.on("agent_end", async (_event, ctx) => {
		syncSessionState(ctx);
		updateStatus(ctx);
	});

	// Recalculate when the model changes (different context window size).
	pi.on("model_select", async (event, ctx) => {
		syncSessionState(ctx);
		if (event.model?.id) currentModelId = event.model.id;
		const usage = ctx.getContextUsage();
		const pct = usage ? getContextPercent(usage) : 0;

		// Reset handoff gate when new model drops below threshold
		const handoff = getHandoffThreshold(currentModelId);
		if (pct < handoff) handoffFired = false;

		updateStatus(ctx);
	});

	// Update status when workflow mode changes (different model may be selected).
	pi.events.on("workflow:mode", () => {
		if (currentCtx) updateStatus(currentCtx);
	});

	// Reset on new/resumed session and immediately repopulate the legend.
	pi.on("session_switch", async (_event, ctx) => {
		resetSessionState(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		resetSessionState(ctx);
	});

	pi.events.on(HANDOFF_SESSION_STARTED_EVENT, () => {
		resetSessionState(undefined, { freshSession: true });
	});
}
