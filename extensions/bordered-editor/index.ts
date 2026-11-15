/**
 * Bordered Editor — compact input box with operational status
 * and project context.
 *
 * ╭─ mode:smart ───────────── GPT-6 Astra · medium ─╮
 * │   ▌Implement the error handling changes                │
 * ╰─ 42% of 200k · 1.2M burned · $1.14 ─ ~/project (main) ─╯
 *
 * Top border: workflow mode and live model · thinking level.
 * Bottom left:  context% of Nk · cumulative tokens burned · $cost - active status
 * Bottom right: cwd plus git state — branch (main checkout) or worktree info
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";

const ANSI_SGR = /\x1b\[[0-9;]*m/g;
const PADDING_X = 2;

function shouldShowPrimaryExtensionStatus(key: string, status: string): boolean {
	const value = status.trim();
	// The mode already appears in the top border.
	if (key === "workflow-mode") return false;
	// Background semantic index rebuilds have a dedicated compact indicator on the
	// right border. Suppress the mirrored extension status to avoid duplicate
	// `idx: ...` labels while keeping foreground semantic-search statuses visible.
	return !(key === "semantic-search" && value.startsWith("idx:"));
}

export function pickPrimaryExtensionStatus(statuses: ReadonlyMap<string, string>): string | null {
	const highPriorityKeys = ["review", "semantic-search"];
	for (const key of highPriorityKeys) {
		const status = statuses.get(key);
		if (status && shouldShowPrimaryExtensionStatus(key, status)) return status;
	}

	for (const [key, value] of statuses) {
		if (shouldShowPrimaryExtensionStatus(key, value)) return value;
	}

	return null;
}

const THINKING_COLORS = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
} as const;

function modeColor(mode: string | null) {
	if (mode === "max") return "thinkingMax";
	if (mode === "deep") return "thinkingXhigh";
	return "thinkingMedium";
}

export function formatTokenCount(count: number): string {
	if (!Number.isFinite(count) || count <= 0) return "0";
	if (count < 1000) return Math.round(count).toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function numberFrom(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function objectFrom(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

export function getAssistantUsageTotals(entries: readonly unknown[]): {
	cost: number;
	tokensBurned: number;
} {
	let cost = 0;
	let tokensBurned = 0;

	for (const entryValue of entries) {
		const entry = objectFrom(entryValue);
		if (entry?.type !== "message") continue;
		const message = objectFrom(entry.message);
		if (message?.role !== "assistant") continue;
		const usage = objectFrom(message.usage);
		if (!usage) continue;

		cost += numberFrom(objectFrom(usage.cost)?.total);
		const input = numberFrom(usage.input);
		const cacheRead = numberFrom(usage.cacheRead);
		const explicitTotal = numberFrom(usage.totalTokens);
		tokensBurned += explicitTotal || input + numberFrom(usage.output) + cacheRead + numberFrom(usage.cacheWrite);
	}

	return { cost, tokensBurned };
}

export function formatBottomLeftUsage(
	usage: { percent?: number; tokens: number; contextWindow: number } | undefined,
	session: { cost: number; tokensBurned: number },
): string {
	const pct = usage?.percent != null ? `${Math.round(usage.percent)}%` : "—";
	const ctxWin = usage ? `${Math.round(usage.contextWindow / 1000)}k` : "—";
	return `${pct} of ${ctxWin} · ${formatTokenCount(session.tokensBurned)} burned · $${session.cost.toFixed(2)}`;
}

interface WorktreeEntry {
	path: string;
	branch?: string;
}

function runGit(cwd: string, args: string[]): string | null {
	try {
		return execFileSync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

function normalizePath(p: string, base: string): string {
	const absolute = path.isAbsolute(p) ? p : path.resolve(base, p);
	try {
		return fs.realpathSync(absolute);
	} catch {
		return path.resolve(absolute);
	}
}

function parseWorktreeListPorcelain(output: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	let current: Partial<WorktreeEntry> | null = null;

	const push = () => {
		if (!current?.path) return;
		entries.push({ path: current.path, branch: current.branch });
	};

	for (const line of output.split("\n")) {
		if (line.trim().length === 0) {
			push();
			current = null;
			continue;
		}

		if (line.startsWith("worktree ")) {
			push();
			current = { path: line.slice("worktree ".length).trim() };
			continue;
		}

		if (!current) continue;
		if (line.startsWith("branch ")) {
			const ref = line.slice("branch ".length).trim();
			current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
		}
	}

	push();
	return entries;
}

function getLinkedWorktreeLabel(cwd: string, fallbackBranch: string | null): string | null {
	const topLevel = runGit(cwd, ["rev-parse", "--show-toplevel"]);
	const gitDirRaw = runGit(cwd, ["rev-parse", "--git-dir"]);
	const commonDirRaw = runGit(cwd, ["rev-parse", "--git-common-dir"]);
	if (!topLevel || !gitDirRaw || !commonDirRaw) return null;

	const gitDir = normalizePath(gitDirRaw, cwd);
	const commonDir = normalizePath(commonDirRaw, cwd);
	const isLinkedWorktree = gitDir !== commonDir;
	if (!isLinkedWorktree) return null;

	const topLevelNormalized = normalizePath(topLevel, cwd);
	const worktreeName = path.basename(topLevelNormalized);
	let branch = fallbackBranch ?? undefined;

	const listing = runGit(cwd, ["worktree", "list", "--porcelain"]);
	if (listing) {
		const entries = parseWorktreeListPorcelain(listing);
		const current = entries.find((entry) => normalizePath(entry.path, cwd) === topLevelNormalized);
		if (current?.branch) branch = current.branch;
	}

	return branch ? `${worktreeName} · ${branch}` : worktreeName;
}

class BorderedEditor extends CustomEditor {
	private ctx?: ExtensionContext;
	private modeLabel: string | null = null;
	private getThinkingLevel: () => ReturnType<ExtensionAPI["getThinkingLevel"]> = () => "off";

	setModeLabel(label: string | null): void {
		this.modeLabel = label?.trim().toLowerCase() || null;
	}
	private getGitBranch: () => string | null = () => null;
	private getWorktreeInfo: () => string | null = () => null;
	private getExtensionStatus: () => string | null = () => null;
	private indexRebuildIndicator: string | null = null;

	setDataProviders(
		ctx: ExtensionContext,
		getGitBranch: () => string | null,
		getWorktreeInfo: () => string | null,
		getThinkingLevel: () => ReturnType<ExtensionAPI["getThinkingLevel"]>,
		getExtensionStatus: () => string | null,
	) {
		this.ctx = ctx;
		this.getGitBranch = getGitBranch;
		this.getWorktreeInfo = getWorktreeInfo;
		this.getThinkingLevel = getThinkingLevel;
		this.getExtensionStatus = getExtensionStatus;
		this.borderColor = (s: string) => ctx.ui.theme.fg(this.modeLabel ? modeColor(this.modeLabel) : "border", s);
	}

	setIndexRebuildIndicator(indicator: string | null): void {
		this.indexRebuildIndicator = indicator?.trim() || null;
	}

	// --- Rendering ---

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

		let topLeft = "";
		if (this.modeLabel && theme) {
			topLeft = theme.fg("dim", "mode:") + theme.fg(modeColor(this.modeLabel), theme.bold(this.modeLabel));
		}
		let topRight = "";
		if (this.ctx?.model && theme) {
			const level = this.getThinkingLevel();
			topRight = theme.fg("muted", this.ctx.model.name || this.ctx.model.id)
				+ theme.fg("dim", " · ") + theme.fg(THINKING_COLORS[level], theme.bold(level));
		}

		// --- Bottom-left: context · tokens burned · cost - primary extension status ---
		let bottomLeft = "";
		if (this.ctx && theme) {
			const usage = this.ctx.getContextUsage();
			const sessionUsage = getAssistantUsageTotals(this.ctx.sessionManager.getBranch());
			bottomLeft = theme.fg("muted", formatBottomLeftUsage(usage, sessionUsage));
			const extensionStatus = this.getExtensionStatus();
			if (extensionStatus) {
				bottomLeft += theme.fg("dim", " - ") + extensionStatus;
			}
		}

		// --- Bottom-right: path (branch or linked-worktree info) ---
		let bottomRight = "";
		if (this.ctx && theme) {
			const home = process.env.HOME || process.env.USERPROFILE || "";
			const cwd = home
				? this.ctx.cwd.replace(home, "~")
				: this.ctx.cwd;
			const branch = this.getGitBranch();
			const worktreeInfo = this.getWorktreeInfo();
			const activityIndicator = this.indexRebuildIndicator;
			bottomRight = activityIndicator ? theme.fg("accent", activityIndicator) + theme.fg("dim", " · ") : "";
			bottomRight += theme.fg("muted", cwd);
			if (worktreeInfo) {
				bottomRight += theme.fg("dim", " ") + theme.fg("accent", `[WT ${worktreeInfo}]`);
			} else if (branch) {
				bottomRight += theme.fg("dim", " ") + theme.fg("accent", `(${branch})`);
			}
		}

		return lines.map((line, i) => {
			if (i === 0)
				return this.buildBorder(width, "╭", "╮", bc, topLeft, topRight);
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

		if (fill < 0 && lw > 0) {
			const availableLabelWidth = Math.max(0, inner - 3);
			const truncatedLeft = truncateToWidth(leftLabel, availableLabelWidth);
			const truncatedWidth = visibleWidth(truncatedLeft);
			const fallbackFill = Math.max(0, inner - truncatedWidth - 3);
			return bc(leftCorner) + bc("─ ") + truncatedLeft + " " + bc("─".repeat(fallbackFill)) + bc(rightCorner);
		}

		// Not enough room and no left label — plain border
		if (fill < 0) return bc(leftCorner + "─".repeat(inner) + rightCorner);

		let line = "";

		if (lw > 0) line += bc("─ ") + leftLabel + " ";

		line += bc("─".repeat(fill));

		if (rw > 0) line += " " + rightLabel + bc(" ─");

		return bc(leftCorner) + line + bc(rightCorner);
	}
}

export default function (pi: ExtensionAPI) {
	let editorInstance: BorderedEditor | undefined;
	let requestRender: (() => void) | undefined;
	let indexRebuildIndicator: string | null = null;

	pi.events.on("workflow:mode", (data) => {
		const { mode, label } = data as { mode?: string; label?: string };
		editorInstance?.setModeLabel(label ?? mode ?? null);
		requestRender?.();
	});

	pi.events.on("semantic-search:rebuild-status", (data) => {
		const { indicator } = data as { indicator?: unknown };
		indexRebuildIndicator = typeof indicator === "string" ? indicator : null;
		if (editorInstance) {
			editorInstance.setIndexRebuildIndicator(indexRebuildIndicator);
			requestRender?.();
		}
	});

	// --- Session lifecycle ---

	pi.on("session_start", (_event, ctx) => {
		let gitBranch: string | null = null;
		let linkedWorktreeLabel: string | null = getLinkedWorktreeLabel(ctx.cwd, gitBranch);
		let getExtensionStatus: () => string | null = () => null;

		const refreshWorktreeLabel = () => {
			linkedWorktreeLabel = getLinkedWorktreeLabel(ctx.cwd, gitBranch);
		};

		// Replace default footer — all its info now lives in the editor borders
		ctx.ui.setFooter((tui, _theme, footerData) => {
			gitBranch = footerData.getGitBranch();
			refreshWorktreeLabel();
			getExtensionStatus = () => pickPrimaryExtensionStatus(footerData.getExtensionStatuses());
			const unsub = footerData.onBranchChange(() => {
				gitBranch = footerData.getGitBranch();
				refreshWorktreeLabel();
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
			requestRender = () => tui.requestRender();
			const editor = new BorderedEditor(tui, theme, kb, { paddingX: PADDING_X });
			editor.setIndexRebuildIndicator(indexRebuildIndicator);
			editor.setDataProviders(
				ctx,
				() => gitBranch,
				() => linkedWorktreeLabel,
				() => pi.getThinkingLevel(),
				getExtensionStatus,
			);

			editorInstance = editor;
			pi.events.emit("workflow:request-mode", {});

			return editor;
		});
	});
}
