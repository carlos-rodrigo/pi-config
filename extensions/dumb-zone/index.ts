/**
 * Dumb Zone Detector
 *
 * Monitors context window usage and forces a handoff before the agent
 * enters the "dumb zone" — where reasoning quality degrades due to
 * context length.
 *
 * Thresholds:
 *   🟢  0–30%  — smart (green)
 *   🟡 30–45%  — caution (orange) — user can /handoff manually
 *   🔴 45%+    — dumb (red) → auto-triggers handoff
 *
 * The bordered editor appends the single active zone label to the
 * context readout, e.g. `31% of 272k . $3.36 - smart`.
 *
 * Based on: https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const CAUTION_PCT = 30;
const HANDOFF_PCT = 45;

export function getContextPercent(usage: { percent?: number; tokens: number; contextWindow: number }): number {
	return typeof usage.percent === "number"
		? usage.percent
		: Math.round((usage.tokens / usage.contextWindow) * 100);
}

export function getZoneLabel(pct: number): "smart" | "caution" | "dumb" {
	if (pct >= HANDOFF_PCT) return "dumb";
	if (pct >= CAUTION_PCT) return "caution";
	return "smart";
}

const ZONE_COLORS: Record<string, string> = {
	smart: "success",
	caution: "syntaxNumber",
	dumb: "error",
};

export function getZoneStatus(pct: number, theme: { fg(color: string, text: string): string }): string {
	const label = getZoneLabel(pct);
	return theme.fg(ZONE_COLORS[label], label);
}

export default function (pi: ExtensionAPI) {
	let handoffFired = false;

	function updateStatus(ctx: { ui: { theme: { fg(color: string, text: string): string }; setStatus: (key: string, value: string | undefined) => void }; getContextUsage: () => any }) {
		const usage = ctx.getContextUsage();
		const pct = usage ? getContextPercent(usage) : 0;
		ctx.ui.setStatus("dumb-zone", getZoneStatus(pct, ctx.ui.theme));
	}

	// Check after every turn
	pi.on("turn_end", async (_event, ctx) => {
		updateStatus(ctx);

		if (handoffFired) return;

		const usage = ctx.getContextUsage();
		if (!usage) return;

		const pct = getContextPercent(usage);

		if (pct >= HANDOFF_PCT) {
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
		updateStatus(ctx);
	});

	// Recalculate when the model changes (different context window size).
	pi.on("model_select", async (_event, ctx) => {
		const usage = ctx.getContextUsage();
		const pct = usage ? getContextPercent(usage) : 0;

		// Reset handoff gate when new model drops below threshold
		if (pct < HANDOFF_PCT) handoffFired = false;

		updateStatus(ctx);
	});

	// Reset on new/resumed session and immediately repopulate the legend.
	pi.on("session_switch", async (_event, ctx) => {
		handoffFired = false;
		updateStatus(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		handoffFired = false;
		updateStatus(ctx);
	});
}
