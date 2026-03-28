import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { highlightCode, getLanguageFromPath } from "@mariozechner/pi-coding-agent";
import { Text, matchesKey, Key, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

// ── Constants ──────────────────────────────────────────────────────────────

const MODAL_WIDTH_PERCENT = "90%";
const MODAL_HEIGHT_PERCENT = "85%";
const FALLBACK_MODAL_WIDTH = 140;
const FALLBACK_MODAL_HEIGHT = 40;
const MODAL_FRAME_LINES = 4;
const INNER_PADDING_X = 1;
const TAB_REPLACEMENT = "   ";

const BOX = {
  tl: "╭",
  tr: "╮",
  bl: "╰",
  br: "╯",
  h: "─",
  v: "│",
};

// ── Types ──────────────────────────────────────────────────────────────────

interface BlameLine {
  hash: string;
  author: string;
  date: string;
  lineNum: number;
  content: string;
  isCommitBoundary: boolean;
}

// ── Git helpers ────────────────────────────────────────────────────────────

function getGitBlame(filePath: string): BlameLine[] | undefined {
  try {
    const dir = path.dirname(filePath);
    
    // Check if file is in a git repo
    execSync("git rev-parse --git-dir", {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    
    // Get blame with porcelain format for easy parsing
    const blameOutput = execSync(
      `git blame --line-porcelain "${path.basename(filePath)}"`,
      {
        cwd: dir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large files
      }
    );
    
    return parseBlame(blameOutput);
  } catch {
    return undefined;
  }
}

function parseBlame(output: string): BlameLine[] {
  const lines: BlameLine[] = [];
  const chunks = output.split(/(?=^[a-f0-9]{40} )/m);
  
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    
    const chunkLines = chunk.split("\n");
    const headerMatch = chunkLines[0]?.match(/^([a-f0-9]{40}) (\d+) (\d+)/);
    if (!headerMatch) continue;
    
    const hash = headerMatch[1];
    const lineNum = parseInt(headerMatch[3], 10);
    
    let author = "Unknown";
    let date = "";
    let content = "";
    let isCommitBoundary = false;
    
    for (let i = 1; i < chunkLines.length; i++) {
      const line = chunkLines[i];
      if (line.startsWith("author ")) {
        author = line.slice(7);
      } else if (line.startsWith("author-time ")) {
        const timestamp = parseInt(line.slice(12), 10);
        const d = new Date(timestamp * 1000);
        date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      } else if (line.startsWith("boundary")) {
        isCommitBoundary = true;
      } else if (line.startsWith("\t")) {
        content = line.slice(1);
      }
    }
    
    lines.push({ hash, author, date, lineNum, content, isCommitBoundary });
  }
  
  return lines;
}

function getCommitInfo(hash: string, cwd: string): string | undefined {
  if (hash.startsWith("0000000")) return undefined;
  
  try {
    return execSync(
      `git show --no-patch --format="%H%n%an%n%ae%n%ai%n%s%n%b" ${hash}`,
      {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
  } catch {
    return undefined;
  }
}

// ── Border helpers ─────────────────────────────────────────────────────────

function drawTopBorder(width: number, title: string, rightText: string, theme: Theme): string {
  const borderColor = (s: string) => theme.fg("borderAccent", s);
  const titleStyled = " " + theme.fg("accent", theme.bold(title)) + " ";
  const rightStyled = rightText ? " " + theme.fg("dim", rightText) + " " : "";

  const titleWidth = visibleWidth(titleStyled);
  const rightWidth = visibleWidth(rightStyled);
  const fillLeft = 2;
  const fillRight = Math.max(1, width - fillLeft - titleWidth - rightWidth - 2);

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

// ── Blame viewer component ─────────────────────────────────────────────────

class BlameViewerComponent {
  private blameLines: BlameLine[] = [];
  private highlightedContent: string[] = [];
  private scrollOffset = 0;
  private selectedLine = 0;
  private filePath: string;
  private theme: Theme;
  private onClose: () => void;
  private cachedWidth?: number;
  private cachedHeight?: number;
  private cachedRender?: string[];
  private currentViewHeight = FALLBACK_MODAL_HEIGHT - MODAL_FRAME_LINES;
  private showCommitDetail = false;
  private commitDetailLines: string[] = [];
  
  // For coloring by commit
  private commitColors: Map<string, string> = new Map();
  private colorPalette = ["cyan", "magenta", "yellow", "blue", "green"];
  private colorIndex = 0;

  constructor(
    filePath: string,
    blameLines: BlameLine[],
    theme: Theme,
    onClose: () => void,
  ) {
    this.filePath = filePath;
    this.blameLines = blameLines;
    this.theme = theme;
    this.onClose = onClose;

    // Highlight the code content
    const lang = getLanguageFromPath(filePath);
    const content = blameLines.map(l => l.content).join("\n");
    this.highlightedContent = highlightCode(content, lang);
    
    // Assign colors to commits
    const seenHashes = new Set<string>();
    for (const line of blameLines) {
      if (!seenHashes.has(line.hash) && !line.hash.startsWith("0000000")) {
        seenHashes.add(line.hash);
        this.commitColors.set(line.hash, this.colorPalette[this.colorIndex % this.colorPalette.length]);
        this.colorIndex++;
      }
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedHeight = undefined;
    this.cachedRender = undefined;
  }

  render(termWidth: number): string[] {
    const modalWidth = Math.min(
      Math.max(FALLBACK_MODAL_WIDTH, Math.floor(termWidth * 0.9)),
      termWidth - 4
    );
    const innerWidth = modalWidth - 2;

    // Read terminal height from process.stdout if available
    const termHeight = (process.stdout as any).rows || 50;
    const modalHeight = Math.min(
      Math.floor(termHeight * 0.85),
      termHeight - 4
    );
    this.currentViewHeight = modalHeight - MODAL_FRAME_LINES;

    if (
      this.cachedRender &&
      this.cachedWidth === modalWidth &&
      this.cachedHeight === modalHeight
    ) {
      return this.cachedRender;
    }

    const th = this.theme;
    const out: string[] = [];

    // Title and info
    const fileName = path.basename(this.filePath);
    const lineInfo = `${this.blameLines.length} lines`;
    out.push(drawTopBorder(modalWidth, `Git Blame: ${fileName}`, lineInfo, th));

    // Subtitle with current position
    const currentLine = this.blameLines[this.selectedLine];
    let subtitle = "";
    if (currentLine) {
      const shortHash = currentLine.hash.slice(0, 8);
      const author = truncateToWidth(currentLine.author, 20, "…");
      subtitle = `${th.fg("accent", shortHash)} ${th.fg("dim", "by")} ${th.fg("info", author)} ${th.fg("dim", "on")} ${th.fg("muted", currentLine.date)}`;
    }
    out.push(wrapContentLine(subtitle, innerWidth, th));
    out.push(drawSeparator(modalWidth, th));

    // Calculate column widths
    const maxLineNum = String(this.blameLines.length).length;
    const hashWidth = 8;
    const authorWidth = 15;
    const dateWidth = 10;
    const metaWidth = hashWidth + 1 + authorWidth + 1 + dateWidth + 1 + maxLineNum + 3;
    const codeWidth = innerWidth - INNER_PADDING_X * 2 - metaWidth;

    // Content lines
    const visibleLines = this.currentViewHeight;
    const start = this.scrollOffset;
    const end = Math.min(start + visibleLines, this.blameLines.length);

    for (let i = start; i < end; i++) {
      const blame = this.blameLines[i];
      const highlighted = this.highlightedContent[i] || blame.content;
      const isSelected = i === this.selectedLine;
      
      // Get commit color
      const commitColor = this.commitColors.get(blame.hash) || "dim";
      
      // Format blame info
      const shortHash = blame.hash.startsWith("0000000") 
        ? th.fg("dim", "uncommit") 
        : th.fg(commitColor as any, blame.hash.slice(0, hashWidth));
      const author = truncateToWidth(blame.author, authorWidth, "…");
      const authorStyled = th.fg("muted", author.padEnd(authorWidth));
      const dateStyled = th.fg("dim", blame.date);
      const lineNum = th.fg("dim", String(blame.lineNum).padStart(maxLineNum));
      
      // Code content
      const codeTruncated = truncateToWidth(highlighted, codeWidth, "");
      
      // Build the line
      let line = `${shortHash} ${authorStyled} ${dateStyled} ${lineNum} │ ${codeTruncated}`;
      
      // Highlight selected line
      if (isSelected) {
        line = th.bg("selection", line);
      }
      
      out.push(wrapContentLine(line, innerWidth, th));
    }

    // Pad remaining space
    const renderedLines = end - start;
    for (let i = renderedLines; i < visibleLines; i++) {
      out.push(emptyLine(innerWidth, th));
    }

    // Help text
    const helpText = "↑/↓ navigate • Enter commit detail • q/Esc close";
    out.push(drawBottomBorder(modalWidth, helpText, th));

    this.cachedWidth = modalWidth;
    this.cachedHeight = modalHeight;
    this.cachedRender = out;
    return out;
  }

  handleInput(data: string): void {
    this.invalidate();

    if (matchesKey(data, Key.Escape) || data === "q") {
      if (this.showCommitDetail) {
        this.showCommitDetail = false;
      } else {
        this.onClose();
      }
      return;
    }

    if (matchesKey(data, Key.Up) || data === "k") {
      if (this.selectedLine > 0) {
        this.selectedLine--;
        if (this.selectedLine < this.scrollOffset) {
          this.scrollOffset = this.selectedLine;
        }
      }
      return;
    }

    if (matchesKey(data, Key.Down) || data === "j") {
      if (this.selectedLine < this.blameLines.length - 1) {
        this.selectedLine++;
        if (this.selectedLine >= this.scrollOffset + this.currentViewHeight) {
          this.scrollOffset = this.selectedLine - this.currentViewHeight + 1;
        }
      }
      return;
    }

    if (matchesKey(data, Key.PageUp)) {
      this.selectedLine = Math.max(0, this.selectedLine - this.currentViewHeight);
      this.scrollOffset = Math.max(0, this.scrollOffset - this.currentViewHeight);
      return;
    }

    if (matchesKey(data, Key.PageDown)) {
      this.selectedLine = Math.min(
        this.blameLines.length - 1,
        this.selectedLine + this.currentViewHeight
      );
      this.scrollOffset = Math.min(
        Math.max(0, this.blameLines.length - this.currentViewHeight),
        this.scrollOffset + this.currentViewHeight
      );
      return;
    }

    if (data === "g") {
      this.selectedLine = 0;
      this.scrollOffset = 0;
      return;
    }

    if (data === "G") {
      this.selectedLine = this.blameLines.length - 1;
      this.scrollOffset = Math.max(0, this.blameLines.length - this.currentViewHeight);
      return;
    }
  }
}

// ── Extension ──────────────────────────────────────────────────────────────

export default function gitBlameExtension(pi: ExtensionAPI) {
  // ── Command ────────────────────────────────────────────────────────────────
  
  pi.registerCommand("blame", {
    description: "Show git blame for the current or specified file",
    handler: async (args, ctx) => {
      let filePath = args?.trim();
      
      if (!filePath) {
        ctx.ui.notify("No file specified. Use /blame <path>", "error");
        return;
      }
      
      const resolved = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(ctx.cwd, filePath);
      
      if (!fs.existsSync(resolved)) {
        ctx.ui.notify(`File not found: ${filePath}`, "error");
        return;
      }
      
      const blameLines = getGitBlame(resolved);
      if (!blameLines) {
        ctx.ui.notify("File is not tracked by git", "error");
        return;
      }
      
      await showBlameOverlay(resolved, blameLines, ctx);
    },
  });

  // ── Tool ───────────────────────────────────────────────────────────────────
  
  pi.registerTool({
    name: "git_blame",
    label: "Git Blame",
    description: "Show git blame for a file in an interactive modal. Displays who modified each line, when, and the commit hash. Use to understand code history and authorship.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file (relative to cwd or absolute)" }),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const filePath = params.path.replace(/^@/, "");
      const resolved = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(ctx.cwd, filePath);

      if (!fs.existsSync(resolved)) {
        throw new Error(`File not found: ${params.path}`);
      }

      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        throw new Error(`Path is a directory: ${params.path}`);
      }

      // Max 5MB for blame
      if (stat.size > 5 * 1024 * 1024) {
        throw new Error(`File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB) for blame view.`);
      }

      const blameLines = getGitBlame(resolved);
      if (!blameLines) {
        throw new Error(`File is not tracked by git or git blame failed.`);
      }

      if (ctx.hasUI) {
        await showBlameOverlay(resolved, blameLines, ctx);
      }

      // Summary for non-UI context
      const authors = new Map<string, number>();
      for (const line of blameLines) {
        authors.set(line.author, (authors.get(line.author) || 0) + 1);
      }
      const topAuthors = [...authors.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => `${name}: ${count} lines`)
        .join(", ");

      return {
        content: [{ type: "text", text: `Showed blame for ${path.basename(resolved)} (${blameLines.length} lines). Top authors: ${topAuthors}` }],
        details: { path: resolved, lines: blameLines.length, authors: Object.fromEntries(authors) },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("git_blame "));
      text += theme.fg("muted", args.path);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      if (result.isError) {
        const msg = result.content[0];
        return new Text(theme.fg("error", msg?.type === "text" ? msg.text : "Error"), 0, 0);
      }

      const details = result.details as { path: string; lines: number; authors: Record<string, number> } | undefined;
      if (!details) {
        const msg = result.content[0];
        return new Text(msg?.type === "text" ? msg.text : "", 0, 0);
      }

      const fileName = path.basename(details.path);
      let text = `📜 ${theme.fg("success", fileName)} ${theme.fg("dim", `(${details.lines} lines)`)}`;

      if (expanded && details.authors) {
        const authorList = Object.entries(details.authors)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([name, count]) => `${name}: ${count}`)
          .join(", ");
        text += "\n" + theme.fg("muted", `  Authors: ${authorList}`);
      }

      return new Text(text, 0, 0);
    },
  });

  async function showBlameOverlay(
    resolved: string,
    blameLines: BlameLine[],
    ctx: { hasUI: boolean; cwd: string; ui: any }
  ) {
    await ctx.ui.custom<void>(
      (tui: any, theme: Theme, _kb: any, done: (v: void) => void) => {
        const viewer = new BlameViewerComponent(
          resolved,
          blameLines,
          theme,
          () => done(),
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
}
