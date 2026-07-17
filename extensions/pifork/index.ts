import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type PiforkSplitMode = "horizontal" | "vertical" | "window" | "popup";

export type PiforkArgs = {
  split: PiforkSplitMode;
  prompt?: string;
};

const DEFAULT_SPLIT: PiforkSplitMode = "horizontal";

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function parsePiforkArgs(args: string): PiforkArgs {
  let rest = args.trim();
  let split: PiforkSplitMode = DEFAULT_SPLIT;

  const splitMatch = rest.match(/(?:^|\s)--split\s+(horizontal|vertical|window|popup)(?=\s|$)/i);
  if (splitMatch) {
    split = splitMatch[1]!.toLowerCase() as PiforkSplitMode;
    const start = splitMatch.index ?? 0;
    rest = `${rest.slice(0, start)} ${rest.slice(start + splitMatch[0].length)}`.trim();
  }

  return { split, prompt: rest || undefined };
}

export function buildPiForkShellCommand(sessionFile: string, prompt?: string, sessionId?: string): string {
  const sessionIdPart = sessionId ? ` --session-id ${shellQuote(sessionId)}` : "";
  const promptPart = prompt ? ` -p ${shellQuote(prompt)}` : "";
  return `pi --fork ${shellQuote(sessionFile)}${sessionIdPart}${promptPart}`;
}

export function buildPaneShellCommand(sessionFile: string, prompt?: string, sessionId?: string): string {
  const piCommand = buildPiForkShellCommand(sessionFile, prompt, sessionId);
  if (!prompt) return `exec ${piCommand}`;

  if (!sessionId) {
    return [
      "set -e",
      piCommand,
      "status=$?",
      "echo",
      "echo '[pifork] request finished. Press Enter to close this pane.'",
      "read -r _",
      "exit $status",
    ].join("; ");
  }

  return [
    piCommand,
    "status=$?",
    `if [ $status -eq 0 ]; then exec pi --session ${shellQuote(sessionId)}; fi`,
    "echo",
    "echo '[pifork] request failed. Press Enter to close this pane.'",
    "read -r _",
    "exit $status",
  ].join("; ");
}

export function buildTmuxPiforkArgs(sessionFile: string, cwd: string, split: PiforkSplitMode = DEFAULT_SPLIT, prompt?: string, sessionId?: string): string[] {
  const piCommand = `bash -lc ${shellQuote(buildPaneShellCommand(sessionFile, prompt, sessionId))}`;

  switch (split) {
    case "vertical":
      return ["split-window", "-v", "-c", cwd, piCommand];
    case "window":
      return ["new-window", "-c", cwd, "-n", "pifork", piCommand];
    case "popup":
      return ["popup", "-E", "-w", "90%", "-h", "90%", "-d", cwd, piCommand];
    case "horizontal":
    default:
      return ["split-window", "-h", "-c", cwd, piCommand];
  }
}

export function buildTmuxPiforkCommand(sessionFile: string, cwd: string, split: PiforkSplitMode = DEFAULT_SPLIT, prompt?: string, sessionId?: string): string {
  return ["tmux", ...buildTmuxPiforkArgs(sessionFile, cwd, split, prompt, sessionId).map(shellQuote)].join(" ");
}

export type PersistedPiforkState = {
  dir: string;
  sessionFilePath: string;
  scriptPath: string;
};

export function buildOpenForkScript(): string {
  return `#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SESSION_FILE="$(cat "$SCRIPT_DIR/current-session")"

if [[ -z "\${TMUX:-}" ]]; then
  echo "pifork: not inside tmux" >&2
  exit 1
fi

if [[ -z "$SESSION_FILE" || ! -f "$SESSION_FILE" ]]; then
  echo "pifork: saved session file is missing: $SESSION_FILE" >&2
  exit 1
fi

exec if [[ $# -gt 0 ]]; then
  FORK_SESSION_ID="$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)"
  exec tmux split-window -h -c "$PROJECT_ROOT" "bash -lc 'pi --fork $(printf '%q' "$SESSION_FILE") --session-id $(printf '%q' "$FORK_SESSION_ID") -p $(printf '%q' "$*"); status=\$?; if [ \$status -eq 0 ]; then exec pi --session $(printf '%q' "$FORK_SESSION_ID"); fi; echo; echo \"[pifork] request failed. Press Enter to close this pane.\"; read -r _; exit \$status'"
else
  exec tmux split-window -h -c "$PROJECT_ROOT" "exec pi --fork $(printf '%q' "$SESSION_FILE")"
fi
`;
}

export function persistPiforkState(cwd: string, sessionFile: string | undefined | null): PersistedPiforkState | undefined {
  if (!sessionFile) return undefined;

  const dir = path.join(cwd, ".pi", "pifork");
  const sessionFilePath = path.join(dir, "current-session");
  const scriptPath = path.join(dir, "open-fork.sh");

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sessionFilePath, `${sessionFile}\n`, "utf8");
  fs.writeFileSync(scriptPath, buildOpenForkScript(), { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(scriptPath, 0o755);

  return { dir, sessionFilePath, scriptPath };
}

function isInsideTmux(): boolean {
  return !!process.env.TMUX;
}

export default function piforkExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    persistPiforkState(ctx.cwd, ctx.sessionManager.getSessionFile());
  });

  pi.registerCommand("pifork", {
    description: "Open a fork of the current Pi session in a new tmux pane (usage: /pifork [--split horizontal|vertical|window|popup] [prompt])",
    handler: async (args, ctx) => {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("Cannot fork an ephemeral session; start Pi with session saving enabled", "error");
        return;
      }

      const persisted = persistPiforkState(ctx.cwd, sessionFile);
      const parsed = parsePiforkArgs(args ?? "");

      if (!isInsideTmux()) {
        const script = persisted?.scriptPath ?? path.join(ctx.cwd, ".pi", "pifork", "open-fork.sh");
        ctx.ui.notify(`Not inside tmux. From a tmux pane, run: ${script}`, "error");
        return;
      }

      const forkSessionId = parsed.prompt ? randomUUID() : undefined;
      await pi.exec("tmux", buildTmuxPiforkArgs(sessionFile, ctx.cwd, parsed.split, parsed.prompt, forkSessionId));
      const where = parsed.split === "window" ? "window" : parsed.split === "popup" ? "popup" : "pane";
      ctx.ui.notify(`Opened forked Pi session in tmux ${where}`, "info");
    },
  });
}
