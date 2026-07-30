import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execChecked } from "../lib/process.ts";

export interface HerdrLazygitTab {
  tabId: string;
  paneId: string;
}

const POLL_INTERVAL_MS = 200;
const STARTUP_IDLE_POLLS = 25;

async function isGitRepo(pi: Pick<ExtensionAPI, "exec">, dir: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const result = await pi.exec("git", ["rev-parse", "--git-dir"], { cwd: dir, signal, timeout: 5_000 });
    return result.code === 0;
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
}

async function hasLazygit(pi: Pick<ExtensionAPI, "exec">, signal?: AbortSignal): Promise<boolean> {
  try {
    const result = await pi.exec("lazygit", ["--version"], { signal, timeout: 5_000 });
    return result.code === 0;
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
}

function herdrWorkspaceId(): string | undefined {
  return process.env.HERDR_WORKSPACE_ID?.trim() || undefined;
}

export function parseLazygitCommandArgs(args: string): { path?: string } {
  const withoutLegacySplit = args
    .trim()
    .replace(/(?:^|\s)--split\s+(?:horizontal|vertical|window|popup)(?=\s|$)/gi, " ")
    .trim();
  return withoutLegacySplit ? { path: withoutLegacySplit } : {};
}

export function parseHerdrTabCreated(output: string): HerdrLazygitTab {
  try {
    const parsed = JSON.parse(output) as {
      result?: { root_pane?: { pane_id?: unknown }; tab?: { tab_id?: unknown } };
    };
    const paneId = parsed.result?.root_pane?.pane_id;
    const tabId = parsed.result?.tab?.tab_id;
    if (typeof paneId === "string" && typeof tabId === "string") return { tabId, paneId };
  } catch {
    // Report one stable error below.
  }
  throw new Error("Invalid Herdr tab creation response");
}

async function closeHerdrTab(pi: Pick<ExtensionAPI, "exec">, tabId: string): Promise<void> {
  await pi.exec("herdr", ["tab", "close", tabId]).catch(() => undefined);
}

export async function launchLazygitInHerdr(
  pi: Pick<ExtensionAPI, "exec">,
  targetDir: string,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<HerdrLazygitTab> {
  const created = await execChecked(pi, "herdr", [
    "tab",
    "create",
    "--workspace",
    workspaceId,
    "--cwd",
    targetDir,
    "--label",
    "lazygit",
    "--no-focus",
  ], { signal, timeout: 5_000 });
  const tab = parseHerdrTabCreated(created.stdout);

  try {
    await execChecked(pi, "herdr", ["pane", "run", tab.paneId, "lazygit"], { signal, timeout: 5_000 });
    return tab;
  } catch (error) {
    await closeHerdrTab(pi, tab.tabId);
    throw error;
  }
}

function capturedScreen(output: string): string[] {
  const lines = output.replace(/\r/g, "").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function foregroundRunsLazygit(output: string): boolean | undefined {
  try {
    const parsed = JSON.parse(output) as {
      result?: { process_info?: { foreground_processes?: Array<{ name?: unknown; argv0?: unknown }> } };
    };
    const processes = parsed.result?.process_info?.foreground_processes;
    if (!Array.isArray(processes)) return undefined;
    return processes.some((process) =>
      [process.name, process.argv0].some((value) => typeof value === "string" && /(^|\/)lazygit$/.test(value)),
    );
  } catch {
    return undefined;
  }
}

async function resolveTargetDir(cwd: string, requestedPath?: string): Promise<string> {
  if (!requestedPath) return cwd;
  const normalized = requestedPath.replace(/^@/, "");
  const resolved = path.isAbsolute(normalized) ? normalized : path.resolve(cwd, normalized);
  try {
    const stat = await fs.promises.stat(resolved);
    return stat.isDirectory() ? resolved : path.dirname(resolved);
  } catch {
    throw new Error(`Path not found: ${requestedPath}`);
  }
}

async function showLazygitModal(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  targetDir: string,
  signal?: AbortSignal,
): Promise<void> {
  if (ctx.mode !== "tui") throw new Error("The LazyGit modal requires Pi TUI mode");
  const workspaceId = herdrWorkspaceId();
  if (!workspaceId || process.env.HERDR_ENV !== "1") {
    throw new Error("The LazyGit modal requires Pi to run inside Herdr");
  }

  const tab = await launchLazygitInHerdr(pi, targetDir, workspaceId, signal);

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    let lines = [theme.fg("dim", "Opening LazyGit…")];
    let pollTimer: NodeJS.Timeout | undefined;
    let polling = false;
    let finished = false;
    let lazygitStarted = false;
    let idlePolls = 0;
    let inputQueue = Promise.resolve();

    const finish = () => {
      if (finished) return;
      finished = true;
      if (pollTimer) clearInterval(pollTimer);
      void closeHerdrTab(pi, tab.tabId).finally(() => done(undefined));
    };

    const poll = async () => {
      if (polling || finished) return;
      polling = true;
      try {
        const [screen, processInfo] = await Promise.all([
          pi.exec("herdr", ["pane", "read", tab.paneId, "--ansi"], { timeout: 2_000 }),
          pi.exec("herdr", ["pane", "process-info", "--pane", tab.paneId], { timeout: 2_000 }),
        ]);
        if (screen.code !== 0) {
          finish();
          return;
        }

        lines = capturedScreen(screen.stdout);
        const running = processInfo.code === 0 ? foregroundRunsLazygit(processInfo.stdout) : undefined;
        if (running === true) {
          lazygitStarted = true;
          idlePolls = 0;
        } else if (running === false) {
          idlePolls += 1;
          if (lazygitStarted || idlePolls >= STARTUP_IDLE_POLLS) {
            finish();
            return;
          }
        }
        tui.requestRender();
      } catch {
        finish();
      } finally {
        polling = false;
      }
    };

    pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    void poll();

    return {
      render(width: number): string[] {
        const safeWidth = Math.max(1, width);
        return (lines.length > 0 ? lines : [""]).map((line) => truncateToWidth(line, safeWidth, ""));
      },
      handleInput(data: string): void {
        if (matchesKey(data, "ctrl+q")) {
          finish();
          return;
        }
        inputQueue = inputQueue.then(async () => {
          if (finished) return;
          await pi.exec("herdr", ["pane", "send-text", tab.paneId, data], { timeout: 2_000 });
        }).catch(() => undefined);
      },
      invalidate(): void {},
    };
  }, {
    overlay: true,
    overlayOptions: {
      anchor: "center",
      width: "96%",
      maxHeight: "96%",
      margin: 1,
    },
  });
}

async function validateAndOpen(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  requestedPath?: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!(await hasLazygit(pi, signal))) {
    throw new Error("LazyGit is not installed. Install it with: brew install lazygit");
  }
  const targetDir = await resolveTargetDir(ctx.cwd, requestedPath);
  if (!(await isGitRepo(pi, targetDir, signal))) throw new Error(`Not a git repository: ${targetDir}`);
  await showLazygitModal(pi, ctx, targetDir, signal);
  return targetDir;
}

export default function lazygitExtension(pi: ExtensionAPI) {
  pi.registerCommand("lazygit", {
    description: "Open LazyGit in a modal Pi component backed by Herdr (usage: /lazygit [path])",
    handler: async (args, ctx) => {
      try {
        const parsed = parseLazygitCommandArgs(args ?? "");
        await validateAndOpen(pi, ctx, parsed.path);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "lazygit",
    label: "LazyGit",
    description: "Open LazyGit in an interactive modal Pi overlay backed by a hidden Herdr tab. Requires Herdr, Pi TUI mode, and LazyGit.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({
        description: "Directory to open LazyGit in (defaults to cwd). A file path uses its parent directory.",
      })),
      split: Type.Optional(StringEnum(["horizontal", "vertical", "window", "popup"] as const, {
        description: "Deprecated compatibility option. LazyGit always opens in the Herdr-backed modal.",
      })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const targetDir = await validateAndOpen(pi, ctx, params.path, signal);
      return {
        content: [{ type: "text", text: `Closed LazyGit for ${path.basename(targetDir)}.` }],
        details: { path: targetDir, mode: "herdr-modal" },
      };
    },
    renderCall(args, theme) {
      const target = args.path ? theme.fg("muted", args.path) : theme.fg("dim", "(cwd)");
      return new Text(`${theme.fg("toolTitle", theme.bold("lazygit "))}${target}`, 0, 0);
    },
    renderResult(result, _options, theme, context) {
      const message = result.content[0];
      const text = message?.type === "text" ? message.text : "";
      return new Text(context.isError ? theme.fg("error", text) : theme.fg("success", text), 0, 0);
    },
  });
}
