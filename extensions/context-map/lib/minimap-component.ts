/**
 * Context Minimap TUI Component
 *
 * Renders session context as stacked color-coded blocks.
 * Supports multi-session chain view, vim navigation, and drill-down.
 *
 * Views:
 *   - Chain view:   sessions side by side, j/k moves between sessions, Enter drills in
 *   - Session view: blocks in one session, j/k moves between blocks, Enter shows detail
 *   - Detail view:  full detail of one block, Backspace goes back
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, Key, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { SessionMap, Block, BlockKind } from "./parse-session.js";

// ── Types ──────────────────────────────────────────────────────────────────

type View = "chain" | "session" | "detail";

export interface MinimapState {
	view: View;
	sessions: SessionMap[];
	selectedSession: number;  // index into sessions[]
	selectedBlock: number;    // index into current session's blocks[]
	scrollOffset: number;     // for scrolling within a view
}

// ── Colors ─────────────────────────────────────────────────────────────────

const KIND_COLORS: Record<BlockKind, string> = {
	system: "info",
	user: "success",
	assistant: "warning",
	thinking: "dim",
	"tool-call": "accent",
	"tool-result": "accent",
	compaction: "syntaxNumber",
	"branch-summary": "syntaxNumber",
	custom: "muted",
	meta: "dim",
};

const KIND_BG: Record<BlockKind, string> = {
	system: "\x1b[48;2;40;60;90m",
	user: "\x1b[48;2;30;70;30m",
	assistant: "\x1b[48;2;80;70;20m",
	thinking: "\x1b[48;2;50;50;50m",
	"tool-call": "\x1b[48;2;50;40;80m",
	"tool-result": "\x1b[48;2;60;45;85m",
	compaction: "\x1b[48;2;80;55;20m",
	"branch-summary": "\x1b[48;2;80;55;20m",
	custom: "\x1b[48;2;45;45;45m",
	meta: "\x1b[48;2;35;35;35m",
};

const BG_RESET = "\x1b[49m";
const BG_SELECTED = "\x1b[48;2;60;60;90m";

// ── Box drawing ────────────────────────────────────────────────────────────

const BOX = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };

// ── Component ──────────────────────────────────────────────────────────────

export class MinimapComponent {
	private state: MinimapState;
	private theme: Theme;
	private onClose: () => void;
	private cachedRender?: string[];
	private cachedWidth?: number;
	private cachedHeight?: number;
	private tui: any;

	constructor(sessions: SessionMap[], theme: Theme, onClose: () => void, tui: any) {
		this.theme = theme;
		this.onClose = onClose;
		this.tui = tui;
		this.state = {
			view: sessions.length > 1 ? "chain" : "session",
			sessions,
			selectedSession: sessions.length - 1, // start at current (last) session
			selectedBlock: 0,
			scrollOffset: 0,
		};
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
			this.onClose();
			return;
		}

		const s = this.state;

		switch (s.view) {
			case "chain":
				this.handleChainInput(data);
				break;
			case "session":
				this.handleSessionInput(data);
				break;
			case "detail":
				this.handleDetailInput(data);
				break;
		}

		this.invalidate();
		this.tui.requestRender();
	}

	private handleChainInput(data: string): void {
		const s = this.state;
		const max = s.sessions.length - 1;

		if (matchesKey(data, Key.down) || matchesKey(data, "j") || matchesKey(data, Key.right) || matchesKey(data, "l")) {
			s.selectedSession = Math.min(s.selectedSession + 1, max);
		} else if (matchesKey(data, Key.up) || matchesKey(data, "k") || matchesKey(data, Key.left) || matchesKey(data, "h")) {
			s.selectedSession = Math.max(s.selectedSession - 1, 0);
		} else if (matchesKey(data, Key.enter)) {
			s.view = "session";
			s.selectedBlock = 0;
			s.scrollOffset = 0;
		} else if (matchesKey(data, "g")) {
			s.selectedSession = 0;
		} else if (data === "G") {
			s.selectedSession = max;
		}
	}

	private handleSessionInput(data: string): void {
		const s = this.state;
		const session = s.sessions[s.selectedSession];
		if (!session) return;
		const max = session.blocks.length - 1;

		if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			s.selectedBlock = Math.min(s.selectedBlock + 1, max);
		} else if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			s.selectedBlock = Math.max(s.selectedBlock - 1, 0);
		} else if (matchesKey(data, Key.enter)) {
			s.view = "detail";
			s.scrollOffset = 0;
		} else if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
			if (s.sessions.length > 1) {
				s.view = "chain";
			}
		} else if (matchesKey(data, "g")) {
			s.selectedBlock = 0;
		} else if (data === "G") {
			s.selectedBlock = max;
		} else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
			s.selectedBlock = Math.min(s.selectedBlock + 10, max);
		} else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
			s.selectedBlock = Math.max(s.selectedBlock - 10, 0);
		}
	}

	private handleDetailInput(data: string): void {
		const s = this.state;
		const session = s.sessions[s.selectedSession];
		if (!session) return;

		if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete) || matchesKey(data, Key.enter)) {
			s.view = "session";
		} else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			s.scrollOffset++;
		} else if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			s.scrollOffset = Math.max(0, s.scrollOffset - 1);
		}
	}

	render(width: number): string[] {
		const modalHeight = this.computeModalHeight();
		if (this.cachedRender && this.cachedWidth === width && this.cachedHeight === modalHeight) {
			return this.cachedRender;
		}

		const th = this.theme;
		const s = this.state;
		const innerWidth = Math.max(1, width - 2);
		const viewHeight = Math.max(1, modalHeight - 4); // borders + title + footer

		let output: string[];
		switch (s.view) {
			case "chain":
				output = this.renderChainView(width, innerWidth, viewHeight, th);
				break;
			case "session":
				output = this.renderSessionView(width, innerWidth, viewHeight, th);
				break;
			case "detail":
				output = this.renderDetailView(width, innerWidth, viewHeight, th);
				break;
		}

		this.cachedWidth = width;
		this.cachedHeight = modalHeight;
		this.cachedRender = output;
		return output;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedHeight = undefined;
		this.cachedRender = undefined;
	}

	private computeModalHeight(): number {
		const rows = process.stdout.rows;
		if (!rows || rows <= 0) return 40;
		return Math.max(10, Math.floor(rows * 0.85));
	}

	// ── Chain view: sessions side by side ──────────────────────────────────

	private renderChainView(width: number, innerWidth: number, viewHeight: number, th: Theme): string[] {
		const s = this.state;
		const sessions = s.sessions;
		const out: string[] = [];

		// Title
		out.push(this.drawTop(width, "Context Map — Session Chain", `${sessions.length} sessions`, th));

		// Calculate column widths
		const colCount = sessions.length;
		const gap = 1;
		const availableWidth = innerWidth - 2; // padding
		const colWidth = Math.max(8, Math.floor((availableWidth - gap * (colCount - 1)) / colCount));

		// Session headers
		let headerLine = "";
		for (let i = 0; i < colCount; i++) {
			const sess = sessions[i]!;
			const isSelected = i === s.selectedSession;
			const label = sess.name || `Session ${i + 1}`;
			const truncLabel = truncateToWidth(label, colWidth - 1, "…");

			if (isSelected) {
				headerLine += th.fg("accent", th.bold("▸ " + truncLabel));
			} else {
				headerLine += th.fg("muted", "  " + truncLabel);
			}

			if (i < colCount - 1) headerLine += " ".repeat(gap);
		}
		out.push(this.wrapLine(headerLine, innerWidth, th));

		// Separator
		out.push(this.drawSep(width, th));

		// Minimap columns
		const mapHeight = viewHeight - 3; // header + sep + header line
		for (let row = 0; row < mapHeight; row++) {
			let line = "";
			for (let i = 0; i < colCount; i++) {
				const sess = sessions[i]!;
				const isSelected = i === s.selectedSession;
				const blockLine = this.renderMinimapRow(sess, row, mapHeight, colWidth, isSelected, th);
				line += blockLine;
				if (i < colCount - 1) line += " ".repeat(gap);
			}
			out.push(this.wrapLine(line, innerWidth, th));
		}

		// Pad remaining
		while (out.length < viewHeight + 2) {
			out.push(this.emptyLine(innerWidth, th));
		}

		// Footer
		const session = sessions[s.selectedSession];
		const blockCount = session ? session.blocks.length : 0;
		const tokens = session ? this.formatTokens(session.totalTokens) : "0";
		out.push(this.drawBottom(width, `←→/hl:select  ↵:drill in  ${blockCount} blocks  ${tokens} tokens  q:close`, th));

		return out;
	}

	private renderMinimapRow(
		session: SessionMap, row: number, totalRows: number,
		colWidth: number, isSelected: boolean, th: Theme,
	): string {
		const blocks = session.blocks;
		if (blocks.length === 0) return " ".repeat(colWidth);

		// Map row to block index based on proportional token count
		const totalTokens = Math.max(1, session.totalTokens);
		let tokenOffset = 0;
		const rowTokenThreshold = (row / totalRows) * totalTokens;
		const rowEndThreshold = ((row + 1) / totalRows) * totalTokens;

		// Find block(s) that fall in this row
		let blockIdx = -1;
		for (let i = 0; i < blocks.length; i++) {
			const blockStart = tokenOffset;
			tokenOffset += blocks[i]!.tokens;
			if (tokenOffset > rowTokenThreshold && blockStart < rowEndThreshold) {
				blockIdx = i;
				break;
			}
		}

		if (blockIdx < 0) return " ".repeat(colWidth);

		const block = blocks[blockIdx]!;
		const label = truncateToWidth(block.label, colWidth - 2, "…");
		const padRight = " ".repeat(Math.max(0, colWidth - visibleWidth(label) - 2));
		const bg = isSelected ? BG_SELECTED : KIND_BG[block.kind];
		const text = " " + label + padRight + " ";

		return bg + th.fg(KIND_COLORS[block.kind], text) + BG_RESET;
	}

	// ── Session view: blocks in one session ────────────────────────────────

	private renderSessionView(width: number, innerWidth: number, viewHeight: number, th: Theme): string[] {
		const s = this.state;
		const session = s.sessions[s.selectedSession];
		if (!session) return [this.drawTop(width, "No session", "", th)];

		const blocks = session.blocks;
		const out: string[] = [];

		// Title
		const title = session.name || `Session ${s.selectedSession + 1}`;
		const tokens = this.formatTokens(session.totalTokens);
		const cost = session.contextUsage?.cost != null ? ` $${session.contextUsage.cost.toFixed(2)}` : "";
		out.push(this.drawTop(width, `Context Map — ${title}`, `${blocks.length} blocks  ${tokens}${cost}`, th));

		// Separator
		out.push(this.drawSep(width, th));

		// Ensure selected block is visible
		const listHeight = viewHeight - 2;
		if (s.selectedBlock < s.scrollOffset) {
			s.scrollOffset = s.selectedBlock;
		} else if (s.selectedBlock >= s.scrollOffset + listHeight) {
			s.scrollOffset = s.selectedBlock - listHeight + 1;
		}

		// Render block list
		for (let i = 0; i < listHeight; i++) {
			const blockIdx = s.scrollOffset + i;
			if (blockIdx >= blocks.length) {
				out.push(this.emptyLine(innerWidth, th));
				continue;
			}

			const block = blocks[blockIdx]!;
			const isSelected = blockIdx === s.selectedBlock;
			const line = this.renderBlockLine(block, blockIdx, isSelected, innerWidth - 4, th);
			out.push(this.wrapLine(line, innerWidth, th));
		}

		// Footer
		const pos = blocks.length > 0 ? `${s.selectedBlock + 1}/${blocks.length}` : "empty";
		const backHint = s.sessions.length > 1 ? "⌫:back  " : "";
		out.push(this.drawBottom(width, `↑↓/jk:navigate  ↵:detail  ${backHint}${pos}  q:close`, th));

		return out;
	}

	private renderBlockLine(block: Block, _idx: number, isSelected: boolean, contentWidth: number, th: Theme): string {
		const color = KIND_COLORS[block.kind];
		const bg = isSelected ? BG_SELECTED : "";
		const bgEnd = isSelected ? BG_RESET : "";

		// Token bar width (proportional, min 1 char, max 20)
		const session = this.state.sessions[this.state.selectedSession]!;
		const maxTokens = Math.max(...session.blocks.map((b) => b.tokens));
		const barWidth = Math.max(1, Math.min(20, Math.round((block.tokens / Math.max(1, maxTokens)) * 20)));
		const bar = "█".repeat(barWidth);

		const cursor = isSelected ? th.fg("accent", "▸ ") : "  ";
		const label = th.fg(color, th.bold(truncateToWidth(block.label, 16, "…")));
		const labelPad = " ".repeat(Math.max(0, 18 - visibleWidth(block.label) - 2));
		const tokenStr = th.fg("dim", this.formatTokens(block.tokens).padStart(6));
		const barStr = th.fg(color, bar);
		const detail = th.fg("muted", truncateToWidth(block.detail, Math.max(10, contentWidth - 50), "…"));

		const errorMark = block.isError ? th.fg("error", " ✗") : "";

		return bg + cursor + label + labelPad + tokenStr + " " + barStr + errorMark + " " + detail + bgEnd;
	}

	// ── Detail view: one block expanded ────────────────────────────────────

	private renderDetailView(width: number, innerWidth: number, viewHeight: number, th: Theme): string[] {
		const s = this.state;
		const session = s.sessions[s.selectedSession];
		if (!session) return [];

		const block = session.blocks[s.selectedBlock];
		if (!block) return [];

		const out: string[] = [];

		// Title
		out.push(this.drawTop(width, `${block.label}`, `${this.formatTokens(block.tokens)} tokens`, th));
		out.push(this.drawSep(width, th));

		// Build detail lines
		const contentWidth = innerWidth - 4;
		const detailLines: string[] = [];

		detailLines.push(th.fg("accent", "Kind: ") + th.fg(KIND_COLORS[block.kind], block.kind));
		detailLines.push(th.fg("accent", "Tokens: ") + this.formatTokens(block.tokens));
		if (block.isError) detailLines.push(th.fg("error", "⚠ Error result"));
		detailLines.push("");
		detailLines.push(th.fg("accent", "Content:"));

		// Wrap detail text
		const detailText = block.detail;
		const words = detailText.split(/\s+/);
		let currentLine = "";
		for (const word of words) {
			if (visibleWidth(currentLine + " " + word) > contentWidth) {
				detailLines.push(currentLine);
				currentLine = word;
			} else {
				currentLine = currentLine ? currentLine + " " + word : word;
			}
		}
		if (currentLine) detailLines.push(currentLine);

		// Render with scroll
		const maxScroll = Math.max(0, detailLines.length - (viewHeight - 3));
		s.scrollOffset = Math.min(s.scrollOffset, maxScroll);

		const listHeight = viewHeight - 2;
		for (let i = 0; i < listHeight; i++) {
			const lineIdx = s.scrollOffset + i;
			if (lineIdx < detailLines.length) {
				const line = truncateToWidth(detailLines[lineIdx]!, contentWidth, "…");
				out.push(this.wrapLine("  " + line, innerWidth, th));
			} else {
				out.push(this.emptyLine(innerWidth, th));
			}
		}

		out.push(this.drawBottom(width, "⌫/↵:back  ↑↓/jk:scroll  q:close", th));
		return out;
	}

	// ── Drawing helpers ────────────────────────────────────────────────────

	private drawTop(width: number, title: string, right: string, th: Theme): string {
		const b = (s: string) => th.fg("borderAccent", s);
		const titleStyled = " " + th.fg("accent", th.bold(title)) + " ";
		const rightStyled = right ? " " + th.fg("dim", right) + " " : "";
		const titleW = visibleWidth(titleStyled);
		const rightW = visibleWidth(rightStyled);
		const fill = Math.max(1, width - 4 - titleW - rightW);
		return b(BOX.tl) + b(BOX.h.repeat(2)) + titleStyled + b(BOX.h.repeat(fill)) + rightStyled + b(BOX.tr);
	}

	private drawBottom(width: number, help: string, th: Theme): string {
		const b = (s: string) => th.fg("borderAccent", s);
		const helpStyled = " " + th.fg("dim", help) + " ";
		const helpW = visibleWidth(helpStyled);
		const fill = Math.max(1, width - 4 - helpW);
		return b(BOX.bl) + b(BOX.h.repeat(2)) + helpStyled + b(BOX.h.repeat(fill)) + b(BOX.br);
	}

	private drawSep(width: number, th: Theme): string {
		const b = (s: string) => th.fg("borderMuted", s);
		return b("├") + b(BOX.h.repeat(width - 2)) + b("┤");
	}

	private wrapLine(content: string, innerWidth: number, th: Theme): string {
		const b = (s: string) => th.fg("borderAccent", s);
		const truncated = truncateToWidth(content, innerWidth - 2, "");
		const vis = visibleWidth(truncated);
		const pad = " ".repeat(Math.max(0, innerWidth - 2 - vis));
		return b(BOX.v) + " " + truncated + pad + " " + b(BOX.v);
	}

	private emptyLine(innerWidth: number, th: Theme): string {
		const b = (s: string) => th.fg("borderAccent", s);
		return b(BOX.v) + " ".repeat(innerWidth) + b(BOX.v);
	}

	private formatTokens(n: number): string {
		if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
		if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
		return String(n);
	}
}
