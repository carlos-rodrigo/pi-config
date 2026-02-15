/**
 * File Opener Extension
 *
 * Two capabilities:
 *   1. `/open <file>` command — opens file in an overlay modal with syntax highlighting
 *   2. `open_file` tool — LLM can call it to either:
 *      - "view" → show file in overlay modal (markdown rendered, code highlighted)
 *      - "edit" → open file in nvim via tmux split
 *
 * Features:
 *   - Markdown files rendered with formatted headings, bold, code blocks, etc.
 *   - Code files shown with syntax highlighting and line numbers
 *   - Bordered modal with responsive dimensions and inner padding
 *   - Vim-style scrolling (j/k, g/G, Ctrl+D/U)
 *   - Press "e" to jump to nvim from the viewer
 *
 * Requirements:
 *   - tmux (for opening nvim in a split pane)
 */

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { highlightCode, getLanguageFromPath, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Markdown, Text, matchesKey, Key, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Constants ──────────────────────────────────────────────────────────────

// Modal target size: 80% of terminal (roughly 10% margin on each side).
const MODAL_SIZE_RATIO = 0.8;
const MODAL_WIDTH_PERCENT = "80%";
const MODAL_HEIGHT_PERCENT = "80%";
const FALLBACK_MODAL_WIDTH = 120;
const FALLBACK_MODAL_HEIGHT = 40;
const MODAL_FRAME_LINES = 4; // top border + subtitle + separator + bottom border
const INNER_PADDING_X = 2;
// pi-tui normalizes tabs to 3 spaces in visibleWidth()/Text/Markdown.
// Keep custom renderer consistent to avoid overlay compositing width drift.
const TAB_REPLACEMENT = "   ";

// Box-drawing characters
const BOX = {
	tl: "╭",
	tr: "╮",
	bl: "╰",
	br: "╯",
	h: "─",
	v: "│",
};

// ── Border helpers ─────────────────────────────────────────────────────────

function drawTopBorder(width: number, title: string, rightText: string, theme: Theme): string {
	const borderColor = (s: string) => theme.fg("borderAccent", s);
	const titleStyled = " " + theme.fg("accent", theme.bold(title)) + " ";
	const rightStyled = rightText ? " " + theme.fg("dim", rightText) + " " : "";

	const titleWidth = visibleWidth(titleStyled);
	const rightWidth = visibleWidth(rightStyled);
	const fillLeft = 2;
	const fillRight = Math.max(1, width - fillLeft - titleWidth - rightWidth - 2); // -2 for corners

	return (
		borderColor(BOX.tl) +
		borderColor(BOX.h.repeat(fillLeft)) +
		titleStyled +
		borderColor(BOX.h.repeat(fillRight)) +
		rightStyled +
		borderColor(BOX.tr)
	);
}

function drawBottomBorder(width: number, helpText: string, theme: Theme): string {
	const borderColor = (s: string) => theme.fg("borderAccent", s);
	const helpStyled = " " + theme.fg("dim", helpText) + " ";
	const helpWidth = visibleWidth(helpStyled);
	const fillLeft = 2;
	const fillRight = Math.max(1, width - fillLeft - helpWidth - 2);

	return (
		borderColor(BOX.bl) +
		borderColor(BOX.h.repeat(fillLeft)) +
		helpStyled +
		borderColor(BOX.h.repeat(fillRight)) +
		borderColor(BOX.br)
	);
}

function drawSeparator(width: number, theme: Theme): string {
	const borderColor = (s: string) => theme.fg("borderMuted", s);
	return borderColor("├") + borderColor(BOX.h.repeat(width - 2)) + borderColor("┤");
}

function wrapContentLine(line: string, innerWidth: number, theme: Theme): string {
	const borderColor = (s: string) => theme.fg("borderAccent", s);
	const pad = " ".repeat(INNER_PADDING_X);
	const contentWidth = innerWidth - INNER_PADDING_X * 2;
	const normalized = line.includes("\t") ? line.replace(/\t/g, TAB_REPLACEMENT) : line;
	const truncated = truncateToWidth(normalized, contentWidth, "");
	const visible = visibleWidth(truncated);
	const rightPad = " ".repeat(Math.max(0, contentWidth - visible));
	return borderColor(BOX.v) + pad + truncated + rightPad + pad + borderColor(BOX.v);
}

function emptyLine(innerWidth: number, theme: Theme): string {
	const borderColor = (s: string) => theme.fg("borderAccent", s);
	return borderColor(BOX.v) + " ".repeat(innerWidth) + borderColor(BOX.v);
}

// ── File viewer component ──────────────────────────────────────────────────

class FileViewerComponent {
	private contentLines: string[] = [];
	private scrollOffset = 0;
	private filePath: string;
	private theme: Theme;
	private onClose: () => void;
	private onEdit: (() => void) | undefined;
	private cachedWidth?: number;
	private cachedHeight?: number;
	private cachedRender?: string[];
	private isMarkdown: boolean;
	private currentViewHeight = FALLBACK_MODAL_HEIGHT - MODAL_FRAME_LINES;

	constructor(
		filePath: string,
		content: string,
		theme: Theme,
		onClose: () => void,
		onEdit?: () => void,
	) {
		this.filePath = filePath;
		this.theme = theme;
		this.onClose = onClose;
		this.onEdit = onEdit;
		this.isMarkdown = /\.md$/i.test(filePath);

		if (this.isMarkdown) {
			// Pre-render markdown — we'll use it once we know width
			// Store raw content, render on first render() call
			this.contentLines = [content];
		} else {
			const lang = getLanguageFromPath(filePath);
			const highlighted = highlightCode(content, lang);

			// Add line numbers
			const maxNum = String(highlighted.length).length;
			this.contentLines = highlighted.map((line, i) => {
				const num = theme.fg("dim", String(i + 1).padStart(maxNum, " "));
				const sep = theme.fg("dim", " │ ");
				return num + sep + line;
			});
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
			this.onClose();
			return;
		}
		if (matchesKey(data, "e") && this.onEdit) {
			this.onEdit();
			return;
		}

		const maxScroll = Math.max(0, this.contentLines.length - this.viewHeight());

		if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			this.scrollOffset = Math.min(this.scrollOffset + 1, maxScroll);
			this.invalidate();
		} else if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			this.scrollOffset = Math.max(this.scrollOffset - 1, 0);
			this.invalidate();
		} else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
			this.scrollOffset = Math.min(this.scrollOffset + this.viewHeight(), maxScroll);
			this.invalidate();
		} else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
			this.scrollOffset = Math.max(this.scrollOffset - this.viewHeight(), 0);
			this.invalidate();
		} else if (matchesKey(data, "g")) {
			this.scrollOffset = 0;
			this.invalidate();
		} else if (data === "G") {
			this.scrollOffset = maxScroll;
			this.invalidate();
		}
	}

	/** Visible content lines (modal height minus borders/header/footer rows). */
	private viewHeight(): number {
		return this.currentViewHeight;
	}

	private computeModalHeight(): number {
		const rows = process.stdout.rows;
		if (!rows || rows <= 0) return FALLBACK_MODAL_HEIGHT;
		return Math.max(1, Math.floor(rows * MODAL_SIZE_RATIO));
	}

	render(width: number): string[] {
		const modalWidth = Math.max(1, width || FALLBACK_MODAL_WIDTH);
		const modalHeight = this.computeModalHeight();

		if (this.cachedRender && this.cachedWidth === modalWidth && this.cachedHeight === modalHeight) {
			return this.cachedRender;
		}

		const innerWidth = Math.max(1, modalWidth - 2); // subtract left/right border chars
		const th = this.theme;

		// For markdown, render on first call (needs width)
		if (this.isMarkdown && this.contentLines.length === 1 && this.contentLines[0]!.includes("\n")) {
			const mdTheme = getMarkdownTheme();
			const md = new Markdown(this.contentLines[0]!, 0, 0, mdTheme);
			const contentWidth = innerWidth - INNER_PADDING_X * 2;
			this.contentLines = md.render(contentWidth);
		}

		const totalLines = this.contentLines.length;
		const vh = Math.max(1, modalHeight - MODAL_FRAME_LINES);
		this.currentViewHeight = vh;

		// Clamp scroll
		const maxScroll = Math.max(0, totalLines - vh);
		if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;

		// Scroll position indicator
		const scrollPct = totalLines <= vh ? 100 : Math.round((this.scrollOffset / maxScroll) * 100);
		const posText = totalLines <= vh ? "All" : `${scrollPct}%`;
		const lineRange = `${this.scrollOffset + 1}–${Math.min(this.scrollOffset + vh, totalLines)}/${totalLines}`;

		// ── Build output ──
		const output: string[] = [];

		// File info
		const fileName = path.basename(this.filePath);
		const dirName = path.dirname(this.filePath);
		const rightInfo = `${lineRange}  ${posText}`;

		// Top border with title
		output.push(drawTopBorder(modalWidth, fileName, rightInfo, th));

		// Subtitle line (directory path)
		const dirLine = th.fg("muted", dirName);
		output.push(wrapContentLine(dirLine, innerWidth, th));

		// Separator
		output.push(drawSeparator(modalWidth, th));

		// Content area
		const visibleLines = this.contentLines.slice(this.scrollOffset, this.scrollOffset + vh);
		for (let i = 0; i < vh; i++) {
			if (i < visibleLines.length) {
				output.push(wrapContentLine(visibleLines[i]!, innerWidth, th));
			} else {
				// Fill remaining space with empty lines to keep fixed height
				output.push(emptyLine(innerWidth, th));
			}
		}

		// Bottom border with help text
		const editHint = this.onEdit ? " e:nvim" : "";
		const helpText = `↑↓/jk:scroll  g/G:top/bottom  PgUp/PgDn${editHint}  q:close`;
		output.push(drawBottomBorder(modalWidth, helpText, th));

		this.cachedWidth = modalWidth;
		this.cachedHeight = modalHeight;
		this.cachedRender = output;
		return output;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedHeight = undefined;
		this.cachedRender = undefined;
	}
}

// ── Helpers ────────────────────────────────────────────────────────────────

function resolveFilePath(filePath: string, cwd: string): string {
	const cleaned = filePath.startsWith("@") ? filePath.slice(1) : filePath;
	return path.isAbsolute(cleaned) ? cleaned : path.resolve(cwd, cleaned);
}

async function isInsideTmux(): Promise<boolean> {
	return !!process.env.TMUX;
}

// ── Extension entry point ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── /open command ────────────────────────────────────────────────────────

	pi.registerCommand("open", {
		description: "Open a file in an overlay viewer (usage: /open <file>)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/open requires interactive mode", "error");
				return;
			}

			const filePath = args.trim();
			if (!filePath) {
				ctx.ui.notify("Usage: /open <file>", "warning");
				return;
			}

			const resolved = resolveFilePath(filePath, ctx.cwd);

			if (!fs.existsSync(resolved)) {
				ctx.ui.notify(`File not found: ${resolved}`, "error");
				return;
			}

			const stat = fs.statSync(resolved);
			if (stat.isDirectory()) {
				ctx.ui.notify(`Cannot open directory: ${resolved}`, "error");
				return;
			}

			if (stat.size > 1_000_000) {
				ctx.ui.notify(`File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Opening in nvim instead.`, "warning");
				await openInNvim(resolved, ctx);
				return;
			}

			const content = fs.readFileSync(resolved, "utf-8");
			await showFileOverlay(resolved, content, ctx);
		},
	});

	// ── open_file tool (LLM-callable) ────────────────────────────────────────

	pi.registerTool({
		name: "open_file",
		label: "Open File",
		description:
			"Open a file for the user. Use mode 'view' to show it in an overlay modal with syntax highlighting, or 'edit' to open it in nvim via tmux.",
		parameters: Type.Object({
			path: Type.String({ description: "File path to open" }),
			mode: StringEnum(["view", "edit"] as const, {
				description: "How to open: 'view' shows in modal, 'edit' opens in nvim",
			}),
			line: Type.Optional(Type.Number({ description: "Line number to jump to (for edit mode)" })),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const resolved = resolveFilePath(params.path, ctx.cwd);

			if (!fs.existsSync(resolved)) {
				return {
					content: [{ type: "text", text: `File not found: ${resolved}` }],
					isError: true,
				};
			}

			const stat = fs.statSync(resolved);
			if (stat.isDirectory()) {
				return {
					content: [{ type: "text", text: `Cannot open directory: ${resolved}` }],
					isError: true,
				};
			}

			if (params.mode === "edit") {
				const inTmux = await isInsideTmux();
				if (!inTmux) {
					return {
						content: [{ type: "text", text: "Cannot open nvim: not inside a tmux session. Use mode 'view' instead." }],
						isError: true,
					};
				}

				const nvimArgs = params.line ? `+${params.line}` : "";
				const cmd = nvimArgs
					? `tmux split-window -h "nvim ${nvimArgs} '${resolved}'"`
					: `tmux split-window -h "nvim '${resolved}'"`;

				await pi.exec("bash", ["-c", cmd]);

				return {
					content: [{ type: "text", text: `Opened ${path.basename(resolved)} in nvim (tmux split)` }],
					details: { path: resolved, mode: "edit", line: params.line },
				};
			}

			// View mode
			if (stat.size > 1_000_000) {
				return {
					content: [{ type: "text", text: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB) for modal view.` }],
					isError: true,
				};
			}

			const content = fs.readFileSync(resolved, "utf-8");
			const lineCount = content.split("\n").length;

			if (ctx.hasUI) {
				await showFileOverlay(resolved, content, ctx);
			}

			return {
				content: [{ type: "text", text: `Showed ${path.basename(resolved)} (${lineCount} lines) in viewer overlay.` }],
				details: { path: resolved, mode: "view", lines: lineCount },
			};
		},

		renderCall(args, theme) {
			const mode = args.mode === "edit" ? theme.fg("warning", "nvim") : theme.fg("accent", "view");
			let text = theme.fg("toolTitle", theme.bold("open_file "));
			text += mode + " ";
			text += theme.fg("muted", args.path);
			if (args.line) text += theme.fg("dim", `:${args.line}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			if (result.isError) {
				const msg = result.content[0];
				return new Text(theme.fg("error", msg?.type === "text" ? msg.text : "Error"), 0, 0);
			}

			const details = result.details as { path: string; mode: string; line?: number; lines?: number } | undefined;
			if (!details) {
				const msg = result.content[0];
				return new Text(msg?.type === "text" ? msg.text : "", 0, 0);
			}

			const icon = details.mode === "edit" ? "✏️" : "👁";
			const fileName = path.basename(details.path);
			let text = `${icon} ${theme.fg("success", fileName)}`;

			if (details.mode === "edit") {
				text += theme.fg("dim", " opened in nvim");
				if (details.line) text += theme.fg("dim", ` at line ${details.line}`);
			} else {
				text += theme.fg("dim", ` (${details.lines} lines)`);
			}

			if (expanded) {
				text += "\n" + theme.fg("muted", `  ${details.path}`);
			}

			return new Text(text, 0, 0);
		},
	});

	// ── Shared overlay display ───────────────────────────────────────────────

	async function showFileOverlay(resolved: string, content: string, ctx: { hasUI: boolean; cwd: string; ui: any }) {
		await ctx.ui.custom<void>(
			(tui: any, theme: Theme, _kb: any, done: (v: void) => void) => {
				const viewer = new FileViewerComponent(
					resolved,
					content,
					theme,
					() => done(),
					async () => {
						if (await isInsideTmux()) {
							await pi.exec("bash", ["-c", `tmux split-window -h "nvim '${resolved}'"`]);
							done();
						}
					},
				);
				return {
					render: (w: number) => viewer.render(w),
					invalidate: () => viewer.invalidate(),
					handleInput: (data: string) => {
						viewer.handleInput(data);
						tui.requestRender();
					},
				};
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center" as const,
					width: MODAL_WIDTH_PERCENT,
					minWidth: FALLBACK_MODAL_WIDTH,
					maxHeight: MODAL_HEIGHT_PERCENT,
				},
			},
		);
	}

	// ── Nvim helper ──────────────────────────────────────────────────────────

	async function openInNvim(resolved: string, ctx: { ui: any }) {
		if (await isInsideTmux()) {
			await pi.exec("bash", ["-c", `tmux split-window -h "nvim '${resolved}'"`]);
		} else {
			ctx.ui.notify("Not inside tmux — cannot open nvim in a split", "error");
		}
	}
}
