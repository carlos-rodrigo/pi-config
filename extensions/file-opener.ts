
import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { highlightCode, getLanguageFromPath, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Markdown, Text, matchesKey, Key, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { diffLines, Change } from "diff";


function getGitOriginalContent(filePath: string): string | undefined {
  try {
    const dir = path.dirname(filePath);
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const relativePath = path.relative(gitRoot, filePath);
    return execSync(`git show HEAD:${relativePath}`, {
      cwd: gitRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return undefined;
  }
}

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
  private diffLines: string[] = [];
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
  private diffMode: boolean = false;
  private hasDiff: boolean = false;
  private rawContent: string;

  constructor(
    filePath: string,
    content: string,
    theme: Theme,
    onClose: () => void,
    onEdit?: () => void,
    startInDiffMode: boolean = false,
  ) {
    this.filePath = filePath;
    this.theme = theme;
    this.onClose = onClose;
    this.onEdit = onEdit;
    this.isMarkdown = /\.md$/i.test(filePath);
    this.rawContent = content;

    // Check for differences against git HEAD
    const original = getGitOriginalContent(filePath);
    if (original !== undefined && original !== content) {
      this.hasDiff = true;
      this.buildDiffLines(original, content);
    }

    // Only enable diff mode if there are actual diffs to show
    this.diffMode = startInDiffMode && this.hasDiff;

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

  private buildDiffLines(original: string, current: string): void {
    const CONTEXT = 3;
    const changes = diffLines(original, current);
    const th = this.theme;

    // Build flat list of all lines with type and dual line numbers
    type DiffLine = { type: "ctx" | "add" | "del"; text: string; oldNum?: number; newNum?: number };
    const all: DiffLine[] = [];
    let oldN = 0;
    let newN = 0;

    for (const change of changes) {
      const cls = change.value.split("\n");
      if (cls.length > 0 && cls[cls.length - 1] === "") cls.pop();
      for (const line of cls) {
        if (change.added) {
          newN++;
          all.push({ type: "add", text: line, newNum: newN });
        } else if (change.removed) {
          oldN++;
          all.push({ type: "del", text: line, oldNum: oldN });
        } else {
          oldN++;
          newN++;
          all.push({ type: "ctx", text: line, oldNum: oldN, newNum: newN });
        }
      }
    }

    // Find changed indices and group into hunks with context
    const changed: number[] = [];
    for (let i = 0; i < all.length; i++) {
      if (all[i].type !== "ctx") changed.push(i);
    }
    if (changed.length === 0) return;

    type Hunk = { start: number; end: number };
    const hunks: Hunk[] = [];
    let cur: Hunk | null = null;
    for (const idx of changed) {
      const s = Math.max(0, idx - CONTEXT);
      const e = Math.min(all.length - 1, idx + CONTEXT);
      if (cur && s <= cur.end + 1) {
        cur.end = e;
      } else {
        if (cur) hunks.push(cur);
        cur = { start: s, end: e };
      }
    }
    if (cur) hunks.push(cur);

    // Stats
    let adds = 0;
    let dels = 0;
    for (const dl of all) {
      if (dl.type === "add") adds++;
      if (dl.type === "del") dels++;
    }

    const numW = String(Math.max(oldN, newN)).length;
    const out: string[] = [];

    // Summary header
    out.push(
      th.fg("success", `+${adds}`) + th.fg("dim", " / ") + th.fg("error", `-${dels}`) + th.fg("dim", ` (${adds + dels} lines changed)`),
    );
    out.push("");

    for (let h = 0; h < hunks.length; h++) {
      const hunk = hunks[h];

      // Collapsed indicator
      if (h === 0 && hunk.start > 0) {
        out.push(th.fg("dim", `  ⋯ ${hunk.start} unchanged lines ⋯`));
        out.push("");
      } else if (h > 0) {
        const gap = hunk.start - hunks[h - 1].end - 1;
        if (gap > 0) {
          out.push("");
          out.push(th.fg("dim", `  ⋯ ${gap} unchanged lines ⋯`));
          out.push("");
        }
      }

      // Hunk header
      const hunkSlice = all.slice(hunk.start, hunk.end + 1);
      const firstOld = hunkSlice.find((l) => l.oldNum)?.oldNum ?? 1;
      const firstNew = hunkSlice.find((l) => l.newNum)?.newNum ?? 1;
      const oldCount = hunkSlice.filter((l) => l.type !== "add").length;
      const newCount = hunkSlice.filter((l) => l.type !== "del").length;
      out.push(th.fg("info", `@@ -${firstOld},${oldCount} +${firstNew},${newCount} @@`));

      // Hunk lines with dual line numbers
      for (let i = hunk.start; i <= hunk.end; i++) {
        const dl = all[i];
        const oStr = dl.oldNum != null ? String(dl.oldNum).padStart(numW) : " ".repeat(numW);
        const nStr = dl.newNum != null ? String(dl.newNum).padStart(numW) : " ".repeat(numW);
        const nums = th.fg("dim", oStr + "  " + nStr);
        const sep = th.fg("dim", " │ ");

        if (dl.type === "add") {
          out.push(nums + sep + th.fg("success", "+ " + dl.text));
        } else if (dl.type === "del") {
          out.push(nums + sep + th.fg("error", "- " + dl.text));
        } else {
          out.push(nums + sep + "  " + dl.text);
        }
      }
    }

    // Trailing hidden lines
    const lastEnd = hunks[hunks.length - 1].end;
    if (lastEnd < all.length - 1) {
      out.push("");
      out.push(th.fg("dim", `  ⋯ ${all.length - 1 - lastEnd} unchanged lines ⋯`));
    }

    this.diffLines = out;
  }

  toggleDiffMode(): void {
    if (this.hasDiff) {
      this.diffMode = !this.diffMode;
      this.scrollOffset = 0;
      this.invalidate();
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
    if (matchesKey(data, "d") && this.hasDiff) {
      this.toggleDiffMode();
      return;
    }

    const lines = this.diffMode ? this.diffLines : this.contentLines;
    const maxScroll = Math.max(0, lines.length - this.viewHeight());

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

    const displayLines = this.diffMode ? this.diffLines : this.contentLines;
    const totalLines = displayLines.length;
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
    const modeIndicator = this.diffMode ? " [DIFF]" : "";
    const rightInfo = `${lineRange}  ${posText}`;

    // Top border with title
    output.push(drawTopBorder(modalWidth, fileName + modeIndicator, rightInfo, th));

    // Subtitle line (directory path)
    const dirLine = th.fg("muted", dirName);
    output.push(wrapContentLine(dirLine, innerWidth, th));

    // Separator
    output.push(drawSeparator(modalWidth, th));

    // Content area
    const visibleLines = displayLines.slice(this.scrollOffset, this.scrollOffset + vh);
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
    const diffHint = this.hasDiff ? ` d:${this.diffMode ? "view" : "diff"}` : "";
    const helpText = `↑↓/jk:scroll  g/G:top/bottom${diffHint}${editHint}  q:close`;
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
    description: "Open a file in an overlay viewer (usage: /open <file> [--diff])",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/open requires interactive mode", "error");
        return;
      }

      // Parse --diff flag
      const diffMode = args.includes("--diff");
      const filePath = args.replace("--diff", "").trim();
      if (!filePath) {
        ctx.ui.notify("Usage: /open <file> [--diff]", "warning");
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
      await showFileOverlay(resolved, content, ctx, diffMode);
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
      mode: StringEnum(["view", "edit", "diff"] as const, {
        description: "How to open: 'view' shows in modal, 'edit' opens in nvim, 'diff' shows changes since last commit",
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

      // View or diff mode
      if (stat.size > 1_000_000) {
        return {
          content: [{ type: "text", text: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB) for modal view.` }],
          isError: true,
        };
      }

      const content = fs.readFileSync(resolved, "utf-8");
      const lineCount = content.split("\n").length;
      const startInDiff = params.mode === "diff";

      if (ctx.hasUI) {
        await showFileOverlay(resolved, content, ctx, startInDiff);
      }

      const modeText = startInDiff ? "diff" : "view";
      return {
        content: [{ type: "text", text: `Showed ${path.basename(resolved)} (${lineCount} lines) in ${modeText} mode.` }],
        details: { path: resolved, mode: params.mode, lines: lineCount },
      };
    },

    renderCall(args, theme) {
      let mode: string;
      if (args.mode === "edit") {
        mode = theme.fg("warning", "nvim");
      } else if (args.mode === "diff") {
        mode = theme.fg("info", "diff");
      } else {
        mode = theme.fg("accent", "view");
      }
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

  async function showFileOverlay(resolved: string, content: string, ctx: { hasUI: boolean; cwd: string; ui: any }, startInDiffMode: boolean = false) {
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
          startInDiffMode,
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
