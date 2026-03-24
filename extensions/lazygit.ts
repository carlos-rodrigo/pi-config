import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import * as path from "node:path";
import * as fs from "node:fs";
import { execSync } from "node:child_process";

export type LazygitOpenMode = "horizontal" | "vertical" | "window" | "popup";

// ── Helpers ────────────────────────────────────────────────────────────────

async function isInsideTmux(): Promise<boolean> {
  return !!process.env.TMUX;
}

function isGitRepo(dir: string): boolean {
  try {
    execSync("git rev-parse --git-dir", {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function hasLazygit(): boolean {
  try {
    execSync("which lazygit", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildTmuxLazygitCommand(targetDir: string, splitType: LazygitOpenMode): string {
  const quotedDir = shellQuote(targetDir);

  switch (splitType) {
    case "vertical":
      return `tmux split-window -v -c ${quotedDir} \"lazygit\"`;
    case "horizontal":
      return `tmux split-window -h -c ${quotedDir} \"lazygit\"`;
    case "window":
      return `tmux new-window -c ${quotedDir} -n \"lazygit\" \"lazygit\"`;
    case "popup":
    default:
      return `tmux popup -E -w 90% -h 90% -d ${quotedDir} \"lazygit\"`;
  }
}

export function parseLazygitCommandArgs(args: string): { path?: string; split: LazygitOpenMode } {
  const normalized = args.trim();
  if (!normalized) return { split: "popup" };

  let split: LazygitOpenMode = "popup";
  let rest = normalized;

  const splitMatch = rest.match(/(?:^|\s)--split\s+(horizontal|vertical|window|popup)(?=\s|$)/i);
  if (splitMatch) {
    split = splitMatch[1]!.toLowerCase() as LazygitOpenMode;
    const start = splitMatch.index ?? 0;
    rest = `${rest.slice(0, start)} ${rest.slice(start + splitMatch[0].length)}`.trim();
  }

  return {
    path: rest || undefined,
    split,
  };
}

function isPopupUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /popup/i.test(message) && /unknown|unsupported|invalid/i.test(message);
}

async function openLazygitInTmux(pi: ExtensionAPI, targetDir: string, splitType: LazygitOpenMode): Promise<LazygitOpenMode> {
  try {
    await pi.exec("bash", ["-c", buildTmuxLazygitCommand(targetDir, splitType)]);
    return splitType;
  } catch (error) {
    if (splitType === "popup" && isPopupUnsupportedError(error)) {
      await pi.exec("bash", ["-c", buildTmuxLazygitCommand(targetDir, "window")]);
      return "window";
    }
    throw error;
  }
}

// ── Extension ──────────────────────────────────────────────────────────────

export default function lazygitExtension(pi: ExtensionAPI) {
  // ── Command ────────────────────────────────────────────────────────────────

  pi.registerCommand("lazygit", {
    description: "Open LazyGit in a tmux popup (usage: /lazygit [path] [--split horizontal|vertical|window|popup])",
    handler: async (args, ctx) => {
      if (!hasLazygit()) {
        ctx.ui.notify("LazyGit is not installed", "error");
        return;
      }
      if (!(await isInsideTmux())) {
        ctx.ui.notify("Not inside tmux", "error");
        return;
      }

      const parsed = parseLazygitCommandArgs(args ?? "");

      let targetDir = ctx.cwd;
      const targetPath = parsed.path?.trim();
      if (targetPath) {
        const resolved = path.isAbsolute(targetPath)
          ? targetPath
          : path.resolve(ctx.cwd, targetPath);
        try {
          const stat = fs.statSync(resolved);
          targetDir = stat.isDirectory() ? resolved : path.dirname(resolved);
        } catch {
          ctx.ui.notify(`Path not found: ${targetPath}`, "error");
          return;
        }
      }

      if (!isGitRepo(targetDir)) {
        ctx.ui.notify("Not a git repository", "error");
        return;
      }

      const usedSplit = await openLazygitInTmux(pi, targetDir, parsed.split);
      const splitLabel = usedSplit === "window" ? "window" : usedSplit === "popup" ? "popup" : "split";
      ctx.ui.notify(`LazyGit opened for ${path.basename(targetDir)} (${splitLabel})`, "info");
    },
  });

  // ── Tool ───────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "lazygit",
    label: "LazyGit",
    description: "Open LazyGit in a tmux popup, split, or window. LazyGit is a terminal UI for git that makes it easy to stage, commit, push, manage branches, resolve conflicts, and more. Requires tmux.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({
        description: "Directory to open lazygit in (defaults to cwd). Can be a file path - will use its parent directory."
      })),
      split: Type.Optional(StringEnum(["horizontal", "vertical", "window", "popup"] as const, {
        description: "Tmux launch mode: 'popup' (default), 'horizontal', 'vertical', or 'window'.",
      })),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Check lazygit is installed
      if (!hasLazygit()) {
        throw new Error("LazyGit is not installed. Install with: pacman -S lazygit (Arch) or brew install lazygit (macOS)");
      }

      // Check tmux
      if (!(await isInsideTmux())) {
        throw new Error("Not inside tmux — cannot open lazygit. Run pi inside tmux first.");
      }

      // Resolve directory
      let targetDir = ctx.cwd;
      if (params.path) {
        const filePath = params.path.replace(/^@/, "");
        const resolved = path.isAbsolute(filePath)
          ? filePath
          : path.resolve(ctx.cwd, filePath);

        // If it's a file, use parent directory
        try {
          const stat = fs.statSync(resolved);
          targetDir = stat.isDirectory() ? resolved : path.dirname(resolved);
        } catch {
          throw new Error(`Path not found: ${params.path}`);
        }
      }

      // Check it's a git repo
      if (!isGitRepo(targetDir)) {
        throw new Error(`Not a git repository: ${targetDir}`);
      }

      const requestedSplit = params.split || "popup";
      const usedSplit = await openLazygitInTmux(pi, targetDir, requestedSplit);

      const dirName = path.basename(targetDir);
      const where = usedSplit === "window" ? "window" : usedSplit === "popup" ? "popup" : "split";
      return {
        content: [{ type: "text", text: `Opened LazyGit for ${dirName} in tmux ${where}.` }],
        details: { path: targetDir, split: usedSplit },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("lazygit "));
      if (args.path) {
        text += theme.fg("muted", args.path);
      } else {
        text += theme.fg("dim", "(cwd)");
      }
      if (args.split && args.split !== "popup") {
        text += theme.fg("dim", ` [${args.split}]`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      if (result.isError) {
        const msg = result.content[0];
        return new Text(theme.fg("error", msg?.type === "text" ? msg.text : "Error"), 0, 0);
      }

      const details = result.details as { path: string; split: LazygitOpenMode } | undefined;
      if (!details) {
        const msg = result.content[0];
        return new Text(msg?.type === "text" ? msg.text : "", 0, 0);
      }

      const dirName = path.basename(details.path);
      const where = details.split === "window" ? "window" : details.split === "popup" ? "popup" : "split";
      let text = `🦥 ${theme.fg("success", "LazyGit")} ${theme.fg("dim", "opened for")} ${theme.fg("accent", dirName)} ${theme.fg("muted", `(${where})`)}`;

      if (expanded) {
        text += "\n" + theme.fg("muted", `  ${details.path}`);
      }

      return new Text(text, 0, 0);
    },
  });
}
