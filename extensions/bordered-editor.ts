/**
 * Bordered Editor — input box with rounded borders and embedded status info.
 *
 * ╭─ claude-opus-4-6 · xhigh ─────────────────────────────╮
 * │   your prompt here                                      │
 * ╰─ 42% of 200k · $1.14 ──────────── ~/project (main) ─╯
 *
 * Top left:     model · thinking-level (level in green)
 * Bottom left:  context% of Nk · $cost
 * Bottom right: cwd (git-branch) — branch in violet
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";

const ANSI_SGR = /\x1b\[[0-9;]*m/g;

class BorderedEditor extends CustomEditor {
	private ctx?: ExtensionContext;
	private getGitBranch: () => string | null = () => null;
	private getThinkingLevel: () => string = () => "off";

	setDataProviders(
		ctx: ExtensionContext,
		getGitBranch: () => string | null,
		getThinkingLevel: () => string,
	) {
		this.ctx = ctx;
		this.getGitBranch = getGitBranch;
		this.getThinkingLevel = getThinkingLevel;
	}

	render(width: number): string[] {
		if (width < 10) return super.render(width);

		const innerWidth = width - 2;
		const lines = super.render(innerWidth);
		const bc = this.borderColor;
		const theme = this.ctx?.ui.theme;

		// Find bottom border: last line that starts with ─ after stripping ANSI
		let bottomIdx = 0;
		for (let i = lines.length - 1; i >= 1; i--) {
			if (lines[i].replace(ANSI_SGR, "").startsWith("─")) {
				bottomIdx = i;
				break;
			}
		}

		// --- Top labels: model · level ---
		let topLeft = "";
		if (this.ctx?.model && theme) {
			const name = this.ctx.model.name || this.ctx.model.id;
			const level = this.getThinkingLevel();
			topLeft =
				theme.fg("muted", name) +
				theme.fg("dim", " · ") +
				theme.fg("success", level);
		}

		// --- Bottom-left: context · cost ---
		let bottomLeft = "";
		if (this.ctx && theme) {
			const usage = this.ctx.getContextUsage();
			let cost = 0;
			for (const e of this.ctx.sessionManager.getBranch()) {
				if (e.type === "message" && e.message.role === "assistant") {
					cost += (e.message as AssistantMessage).usage.cost.total;
				}
			}
			const pct =
				usage?.percent != null ? `${Math.round(usage.percent)}%` : "—";
			const ctxWin = usage
				? `${Math.round(usage.contextWindow / 1000)}k`
				: "—";
			bottomLeft = theme.fg(
				"muted",
				`${pct} of ${ctxWin} · $${cost.toFixed(2)}`,
			);
		}

		// --- Bottom-right: path (branch) ---
		let bottomRight = "";
		if (this.ctx && theme) {
			const home = process.env.HOME || process.env.USERPROFILE || "";
			const cwd = home
				? this.ctx.cwd.replace(home, "~")
				: this.ctx.cwd;
			const branch = this.getGitBranch();
			bottomRight = theme.fg("muted", cwd);
			if (branch) {
				bottomRight += theme.fg("dim", " ") + theme.fg("thinkingHigh", `(${branch})`);
			}
		}

		return lines.map((line, i) => {
			if (i === 0)
				return this.buildBorder(width, "╭", "╮", bc, topLeft, "");
			if (i === bottomIdx)
				return this.buildBorder(
					width,
					"╰",
					"╯",
					bc,
					bottomLeft,
					bottomRight,
				);
			if (i < bottomIdx) return bc("│") + line + bc("│");
			// Autocomplete rows below the box
			return " " + line + " ";
		});
	}

	/** Build a border line with optional left/right labels embedded in ─ */
	private buildBorder(
		width: number,
		leftCorner: string,
		rightCorner: string,
		bc: (s: string) => string,
		leftLabel: string,
		rightLabel: string,
	): string {
		const inner = width - 2; // space between corners

		const lw = visibleWidth(leftLabel);
		const rw = visibleWidth(rightLabel);

		// overhead: "─ " + label + " " per side
		const leftOH = lw > 0 ? lw + 3 : 0;
		const rightOH = rw > 0 ? rw + 3 : 0;
		const fill = inner - leftOH - rightOH;

		// Not enough room — plain border
		if (fill < 0) return bc(leftCorner + "─".repeat(inner) + rightCorner);

		let line = "";

		if (lw > 0) line += bc("─ ") + leftLabel + " ";

		line += bc("─".repeat(fill));

		if (rw > 0) line += " " + rightLabel + bc(" ─");

		return bc(leftCorner) + line + bc(rightCorner);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		let gitBranch: string | null = null;

		// Replace default footer — all its info now lives in the editor borders
		ctx.ui.setFooter((tui, _theme, footerData) => {
			gitBranch = footerData.getGitBranch();
			const unsub = footerData.onBranchChange(() => {
				gitBranch = footerData.getGitBranch();
				tui.requestRender();
			});

			return {
				dispose: unsub,
				invalidate() {},
				render(): string[] {
					return []; // empty — info is in the editor
				},
			};
		});

		// Install bordered editor
		ctx.ui.setEditorComponent((tui, theme, kb) => {
			const editor = new BorderedEditor(tui, theme, kb, { paddingX: 2 });
			editor.setDataProviders(
				ctx,
				() => gitBranch,
				() => pi.getThinkingLevel(),
			);
			return editor;
		});
	});
}
