import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import * as path from "node:path";
import { execSync } from "node:child_process";

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

// ── Extension ──────────────────────────────────────────────────────────────

export default function lazygitExtension(pi: ExtensionAPI) {
  // ── Slash command ──────────────────────────────────────────────────────────
  
  pi.addSlashCommand({
    name: "lazygit",
    description: "Open LazyGit in a tmux window",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Directory to open (defaults to cwd)" })),
    }),
    async handler(params, ctx) {
      if (!hasLazygit()) {
        ctx.ui.notify("LazyGit is not installed", "error");
        return;
      }
      if (!(await isInsideTmux())) {
        ctx.ui.notify("Not inside tmux", "error");
        return;
      }
      
      let targetDir = ctx.cwd;
      if (params.path) {
        const resolved = path.isAbsolute(params.path)
          ? params.path
          : path.resolve(ctx.cwd, params.path);
        try {
          const stat = require("node:fs").statSync(resolved);
          targetDir = stat.isDirectory() ? resolved : path.dirname(resolved);
        } catch {
          ctx.ui.notify(`Path not found: ${params.path}`, "error");
          return;
        }
      }
      
      if (!isGitRepo(targetDir)) {
        ctx.ui.notify("Not a git repository", "error");
        return;
      }
      
      await pi.exec("bash", ["-c", `tmux new-window -c "${targetDir}" -n "lazygit" "lazygit"`]);
      ctx.ui.notify(`LazyGit opened for ${path.basename(targetDir)}`, "info");
    },
  });

  // ── Tool ───────────────────────────────────────────────────────────────────
  
  pi.addTool({
    name: "lazygit",
    description: "Open LazyGit in a tmux split. LazyGit is a terminal UI for git that makes it easy to stage, commit, push, manage branches, resolve conflicts, and more. Requires tmux.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ 
        description: "Directory to open lazygit in (defaults to cwd). Can be a file path - will use its parent directory." 
      })),
      split: Type.Optional(Type.String({
        description: "Tmux split direction: 'horizontal' (default), 'vertical', or 'window' for new window",
        enum: ["horizontal", "vertical", "window"],
      })),
    }),

    async call(params, ctx) {
      // Check lazygit is installed
      if (!hasLazygit()) {
        return {
          content: [{ type: "text", text: "LazyGit is not installed. Install with: pacman -S lazygit (Arch) or brew install lazygit (macOS)" }],
          isError: true,
        };
      }

      // Check tmux
      if (!(await isInsideTmux())) {
        return {
          content: [{ type: "text", text: "Not inside tmux — cannot open lazygit in a split. Run pi inside tmux first." }],
          isError: true,
        };
      }

      // Resolve directory
      let targetDir = ctx.cwd;
      if (params.path) {
        const resolved = path.isAbsolute(params.path)
          ? params.path
          : path.resolve(ctx.cwd, params.path);
        
        // If it's a file, use parent directory
        try {
          const stat = require("node:fs").statSync(resolved);
          targetDir = stat.isDirectory() ? resolved : path.dirname(resolved);
        } catch {
          return {
            content: [{ type: "text", text: `Path not found: ${params.path}` }],
            isError: true,
          };
        }
      }

      // Check it's a git repo
      if (!isGitRepo(targetDir)) {
        return {
          content: [{ type: "text", text: `Not a git repository: ${targetDir}` }],
          isError: true,
        };
      }

      // Build tmux command
      const splitType = params.split || "window";
      let tmuxCmd: string;
      
      switch (splitType) {
        case "vertical":
          tmuxCmd = `tmux split-window -v -c "${targetDir}" "lazygit"`;
          break;
        case "horizontal":
          tmuxCmd = `tmux split-window -h -c "${targetDir}" "lazygit"`;
          break;
        case "window":
        default:
          tmuxCmd = `tmux new-window -c "${targetDir}" -n "lazygit" "lazygit"`;
          break;
      }

      // Execute
      await pi.exec("bash", ["-c", tmuxCmd]);

      const dirName = path.basename(targetDir);
      return {
        content: [{ type: "text", text: `Opened LazyGit for ${dirName} in tmux ${splitType === "window" ? "window" : "split"}.` }],
        details: { path: targetDir, split: splitType },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("lazygit "));
      if (args.path) {
        text += theme.fg("muted", args.path);
      } else {
        text += theme.fg("dim", "(cwd)");
      }
      if (args.split && args.split !== "horizontal") {
        text += theme.fg("dim", ` [${args.split}]`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      if (result.isError) {
        const msg = result.content[0];
        return new Text(theme.fg("error", msg?.type === "text" ? msg.text : "Error"), 0, 0);
      }

      const details = result.details as { path: string; split: string } | undefined;
      if (!details) {
        const msg = result.content[0];
        return new Text(msg?.type === "text" ? msg.text : "", 0, 0);
      }

      const dirName = path.basename(details.path);
      let text = `🦥 ${theme.fg("success", "LazyGit")} ${theme.fg("dim", "opened for")} ${theme.fg("accent", dirName)}`;

      if (expanded) {
        text += "\n" + theme.fg("muted", `  ${details.path}`);
      }

      return new Text(text, 0, 0);
    },
  });
}
