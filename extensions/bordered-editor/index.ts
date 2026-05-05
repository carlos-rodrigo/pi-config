/**
 * Bordered Editor — input box with rounded borders, embedded status info,
 * agent mode label, and ghost text support for Auto Prompt suggestions.
 *
 * ╭─ mode:smart ──────────────── claude-opus-4-6 · high ─╮
 * │   ▌Implement the error handling changes                │  ← gray ghost text
 * ╰─ 42% of 200k · $1.14 ───────────── ~/project (main) ─╯
 *
 * Top left:     agent mode (Smart in green, Deep¹/²/³ in red, Fast in yellow)
 * Top right:    model · thinking-level (level in green)
 * Bottom left:  context% of Nk . $cost - status
 * Bottom right: cwd plus git state — branch (main checkout) or worktree info
 *
 * Ghost text: appears when editor is empty, right arrow accepts, any key dismisses.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, Key, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";

const ANSI_SGR = /\x1b\[[0-9;]*m/g;
const GHOST_COLOR = "\x1b[90m"; // bright black (gray)
const ANSI_RESET = "\x1b[0m";
const PADDING_X = 2;

export function pickPrimaryExtensionStatus(statuses: ReadonlyMap<string, string>): string | null {
	const highPriorityKeys = ["auto-prompt", "review"];
	for (const key of highPriorityKeys) {
		const status = statuses.get(key);
		if (status) return status;
	}

	for (const [key, value] of statuses) {
		if (key !== "dumb-zone" && key !== "workflow-mode") return value;
	}

	return statuses.get("dumb-zone") ?? statuses.get("workflow-mode") ?? statuses.values().next().value ?? null;
}

export type WorkflowModeColor = "success" | "error" | "warning";

export function formatWorkflowModeLabel(rawMode: string | null | undefined): string | null {
	const value = rawMode?.trim();
	if (!value) return null;

	const normalized = value.toLowerCase();
	if (["smart", "s"].includes(normalized)) return "Smart";
	if (["deep1", "deep¹", "d1"].includes(normalized)) return "Deep¹";
	if (["deep", "deep2", "deep²", "d", "d2"].includes(normalized)) return "Deep²";
	if (["deep3", "deep³", "d3"].includes(normalized)) return "Deep³";
	if (["fast", "f", "rush", "r"].includes(normalized)) return "Fast";
	return value;
}

export function getWorkflowModeColor(label: string | null | undefined): WorkflowModeColor {
	const normalized = label?.toLowerCase() ?? "";
	if (normalized.startsWith("deep")) return "error";
	if (normalized === "fast") return "warning";
	return "success";
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
	private getGitBranch: () => string | null = () => null;
	private getWorktreeInfo: () => string | null = () => null;
	private getThinkingLevel: () => string = () => "off";
	private getExtensionStatus: () => string | null = () => null;

	// --- Mode label state ---
	private modeLabel: string | null = null;
	private modeColor: "success" | "error" | "warning" = "success";

	// --- Ghost text state ---
	private ghostText: string | null = null;
	onGhostAccepted?: (text: string) => void;
	onGhostDismissed?: () => void;

	setDataProviders(
		ctx: ExtensionContext,
		getGitBranch: () => string | null,
		getWorktreeInfo: () => string | null,
		getThinkingLevel: () => string,
		getExtensionStatus: () => string | null,
	) {
		this.ctx = ctx;
		this.getGitBranch = getGitBranch;
		this.getWorktreeInfo = getWorktreeInfo;
		this.getThinkingLevel = getThinkingLevel;
		this.getExtensionStatus = getExtensionStatus;
		// Apply initial border color from mode
		this.borderColor = (s: string) => ctx.ui.theme.fg(this.modeColor, s);
	}

	setModeLabel(label: string | null): void {
		this.modeLabel = formatWorkflowModeLabel(label);
		if (this.modeLabel && this.ctx) {
			this.modeColor = getWorkflowModeColor(this.modeLabel);
			this.borderColor = (s: string) => this.ctx!.ui.theme.fg(this.modeColor, s);
		}
	}

	setGhostText(text: string | null): void {
		if (text && this.getText().length > 0) {
			// Don't show ghost when editor has content
			return;
		}
		this.ghostText = text;
	}

	clearGhostText(): void {
		this.ghostText = null;
	}

	// --- Input handling for ghost text ---

	handleInput(data: string): void {
		if (this.ghostText && this.getText().length === 0) {
			if (matchesKey(data, Key.right)) {
				// Accept: fill editor with ghost text
				const text = this.ghostText;
				this.ghostText = null;
				this.ctx?.ui.setEditorText(text);
				this.onGhostAccepted?.(text);
				return;
			}

			// Any other input: dismiss ghost first
			this.ghostText = null;
			this.onGhostDismissed?.();

			// Escape just dismisses ghost — don't pass through (avoids agent abort flicker)
			if (matchesKey(data, Key.escape)) return;

			// Backspace on empty editor — nothing to delete, just dismiss
			if (matchesKey(data, Key.backspace)) return;

			// Everything else (printable chars, ctrl combos, etc.) — pass through
			super.handleInput(data);
			return;
		}

		super.handleInput(data);
	}

	// --- Rendering ---

	render(width: number): string[] {
		if (width < 10) return super.render(width);

		const innerWidth = width - 2;
		const lines = super.render(innerWidth);
		const bc = this.borderColor;
		const theme = this.ctx?.ui.theme;

		// If ghost text is active and editor is empty, replace the cursor line
		if (this.ghostText && this.getText().length === 0) {
			this.replaceWithGhostLine(lines, innerWidth);
		}

		// Find bottom border: last line that starts with ─ after stripping ANSI
		let bottomIdx = 0;
		for (let i = lines.length - 1; i >= 1; i--) {
			if (lines[i].replace(ANSI_SGR, "").startsWith("─")) {
				bottomIdx = i;
				break;
			}
		}

		// --- Top left: agent mode ---
		let topLeft = "";
		if (this.modeLabel && theme) {
			const mode = this.modeLabel.toLowerCase();
			topLeft = theme.fg("dim", "mode:") + theme.fg(getWorkflowModeColor(this.modeLabel), mode);
		}

		// --- Top right: model · level ---
		let topRight = "";
		if (this.ctx?.model && theme) {
			const name = this.ctx.model.name || this.ctx.model.id;
			const level = this.getThinkingLevel();
			topRight =
				theme.fg("muted", name) +
				theme.fg("dim", " · ") +
				theme.fg("success", level);
		}

		// --- Bottom-left: context . cost - primary extension status ---
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
				`${pct} of ${ctxWin} . $${cost.toFixed(2)}`,
			);
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
			bottomRight = theme.fg("muted", cwd);
			if (worktreeInfo) {
				bottomRight += theme.fg("dim", " ") + theme.fg("thinkingHigh", `[WT ${worktreeInfo}]`);
			} else if (branch) {
				bottomRight += theme.fg("dim", " ") + theme.fg("thinkingHigh", `(${branch})`);
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

	/** Replace the first content line with ghost text when editor is empty. */
	private replaceWithGhostLine(lines: string[], innerWidth: number): void {
		if (!this.ghostText) return;

		// Find the first content line (between inner top and bottom borders).
		// Content lines are those between the ─ borders.
		let firstContentIdx = -1;
		for (let i = 1; i < lines.length; i++) {
			if (!lines[i].replace(ANSI_SGR, "").startsWith("─")) {
				firstContentIdx = i;
				break;
			}
		}
		if (firstContentIdx < 0) return;

		const padding = " ".repeat(PADDING_X);
		const maxGhostWidth = innerWidth - PADDING_X;
		const gt = truncateToWidth(this.ghostText, maxGhostWidth);
		const gtVW = visibleWidth(gt);
		const fill = " ".repeat(Math.max(0, maxGhostWidth - gtVW));

		// CURSOR_MARKER positions the hardware cursor; only emit when focused
		const marker = this.focused ? CURSOR_MARKER : "";
		lines[firstContentIdx] = padding + marker + GHOST_COLOR + gt + ANSI_RESET + fill;
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
	let editorInstance: BorderedEditor | undefined;
	let requestRender: (() => void) | undefined;

	// --- Agent mode events ---

	pi.events.on("workflow:mode", (data) => {
		const { mode, label } = data as { mode?: string; label?: string };
		if (editorInstance) {
			editorInstance.setModeLabel(label ?? mode ?? null);
			requestRender?.();
		}
	});

	// --- Auto Prompt ghost text events ---

	pi.events.on("auto-prompt:suggest", (data) => {
		const { text } = data as { text: string };
		if (editorInstance) {
			editorInstance.setGhostText(text);
			requestRender?.();
		}
	});

	pi.events.on("auto-prompt:clear", () => {
		if (editorInstance) {
			editorInstance.clearGhostText();
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

		// Install bordered editor with ghost text support
		ctx.ui.setEditorComponent((tui, theme, kb) => {
			requestRender = () => tui.requestRender();
			const editor = new BorderedEditor(tui, theme, kb, { paddingX: PADDING_X });
			editor.setDataProviders(
				ctx,
				() => gitBranch,
				() => linkedWorktreeLabel,
				() => pi.getThinkingLevel(),
				getExtensionStatus,
			);

			// Wire ghost text callbacks → events
			editor.onGhostAccepted = (text) => {
				pi.events.emit("auto-prompt:accepted", { text });
			};
			editor.onGhostDismissed = () => {
				pi.events.emit("auto-prompt:dismissed", {});
			};

			editorInstance = editor;

			// Request current agent mode (if workflow-modes extension is loaded)
			pi.events.emit("workflow:request-mode", {});

			return editor;
		});
	});
}
