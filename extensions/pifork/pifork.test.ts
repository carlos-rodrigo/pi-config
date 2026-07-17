import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import piforkExtension, {
  buildOpenForkScript,
  buildPaneShellCommand,
  buildPiForkShellCommand,
  buildTmuxPiforkArgs,
  buildTmuxPiforkCommand,
  parsePiforkArgs,
  persistPiforkState,
  shellQuote,
} from "./index.ts";

type CommandDefinition = { description: string; handler: (args: string, ctx: any) => Promise<void> };

function createPiHarness() {
  const commands = new Map<string, CommandDefinition>();
  const eventHandlers = new Map<string, Array<(event: any, ctx: any) => Promise<void>>>();
  const execCalls: Array<{ command: string; args: string[] }> = [];

  return {
    commands,
    eventHandlers,
    execCalls,
    pi: {
      registerCommand(name: string, definition: CommandDefinition) {
        commands.set(name, definition);
      },
      on(name: string, handler: (event: any, ctx: any) => Promise<void>) {
        const handlers = eventHandlers.get(name) ?? [];
        handlers.push(handler);
        eventHandlers.set(name, handlers);
      },
      async exec(command: string, args: string[]) {
        execCalls.push({ command, args });
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  };
}

function createContext(options?: { cwd?: string; sessionFile?: string | undefined }) {
  const notifications: Array<{ message: string; level: string }> = [];
  return {
    notifications,
    ctx: {
      cwd: options?.cwd ?? "/repo",
      sessionManager: {
        getSessionFile() {
          return options?.sessionFile;
        },
      },
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    },
  };
}

test("shellQuote escapes single quotes safely", () => {
  assert.equal(shellQuote("/tmp/that's-it/session.jsonl"), "'/tmp/that'\"'\"'s-it/session.jsonl'");
});

test("parsePiforkArgs defaults to a horizontal split and keeps prompt text", () => {
  assert.deepEqual(parsePiforkArgs(""), { split: "horizontal", prompt: undefined });
  assert.deepEqual(parsePiforkArgs("--split window"), { split: "window", prompt: undefined });
  assert.deepEqual(parsePiforkArgs("--split POPUP explain this"), { split: "popup", prompt: "explain this" });
  assert.deepEqual(parsePiforkArgs("explain this --split vertical"), { split: "vertical", prompt: "explain this" });
});

test("buildTmuxPiforkArgs opens pi --fork in the requested tmux target", () => {
  assert.equal(buildPiForkShellCommand("/tmp/session.jsonl"), "pi --fork '/tmp/session.jsonl'");
  assert.equal(
    buildPiForkShellCommand("/tmp/session.jsonl", "what's next?", "fork-id"),
    "pi --fork '/tmp/session.jsonl' --session-id 'fork-id' -p 'what'\"'\"'s next?'",
  );
  assert.equal(buildPaneShellCommand("/tmp/session.jsonl"), "exec pi --fork '/tmp/session.jsonl'");
  assert.match(buildPaneShellCommand("/tmp/session.jsonl", "what's next?", "fork-id"), /exec pi --session 'fork-id'/);

  const interactiveShell = `bash -lc ${shellQuote("exec pi --fork '/tmp/session.jsonl'")}`;
  assert.deepEqual(buildTmuxPiforkArgs("/tmp/session.jsonl", "/repo", "horizontal"), [
    "split-window",
    "-h",
    "-c",
    "/repo",
    interactiveShell,
  ]);
  assert.deepEqual(buildTmuxPiforkArgs("/tmp/session.jsonl", "/repo", "window"), [
    "new-window",
    "-c",
    "/repo",
    "-n",
    "pifork",
    interactiveShell,
  ]);
  assert.equal(
    buildTmuxPiforkCommand("/tmp/session.jsonl", "/repo", "window"),
    `tmux ${shellQuote("new-window")} ${shellQuote("-c")} ${shellQuote("/repo")} ${shellQuote("-n")} ${shellQuote("pifork")} ${shellQuote(interactiveShell)}`,
  );
});

test("persistPiforkState writes the current session pointer and helper script", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pifork-test-"));
  const state = persistPiforkState(cwd, "/tmp/session.jsonl");

  assert.ok(state);
  assert.equal(fs.readFileSync(state.sessionFilePath, "utf8"), "/tmp/session.jsonl\n");
  assert.equal(fs.readFileSync(state.scriptPath, "utf8"), buildOpenForkScript());
  assert.equal(fs.statSync(state.scriptPath).mode & 0o777, 0o755);
});

test("session_start persists the current session path", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pifork-start-"));
  const harness = createPiHarness();
  piforkExtension(harness.pi as any);

  const handlers = harness.eventHandlers.get("session_start");
  assert.ok(handlers);
  await handlers[0]!({}, createContext({ cwd, sessionFile: "/tmp/current.jsonl" }).ctx);

  assert.equal(fs.readFileSync(path.join(cwd, ".pi", "pifork", "current-session"), "utf8"), "/tmp/current.jsonl\n");
});

test("/pifork opens a forked session in tmux", async () => {
  const previousTmux = process.env.TMUX;
  process.env.TMUX = "/tmp/tmux-1";
  try {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pifork-command-"));
    const harness = createPiHarness();
    piforkExtension(harness.pi as any);
    const command = harness.commands.get("pifork");
    assert.ok(command);

    const context = createContext({ cwd, sessionFile: "/tmp/current.jsonl" });
    await command.handler("--split popup what should I do next?", context.ctx);

    assert.equal(harness.execCalls.length, 1);
    assert.equal(harness.execCalls[0]?.command, "tmux");
    const args = harness.execCalls[0]?.args ?? [];
    assert.deepEqual(args.slice(0, 8), ["popup", "-E", "-w", "90%", "-h", "90%", "-d", cwd]);
    assert.match(args[8] ?? "", /--session-id .*?[0-9a-f]{8}-[0-9a-f-]+/);
    assert.match(args[8] ?? "", /-p .*?what should I do next\?/);
    assert.match(args[8] ?? "", /exec pi --session .*?[0-9a-f]{8}-[0-9a-f-]+/);
    assert.deepEqual(context.notifications.at(-1), {
      message: "Opened forked Pi session in tmux popup",
      level: "info",
    });
  } finally {
    if (previousTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = previousTmux;
  }
});

test("/pifork reports ephemeral sessions instead of launching tmux", async () => {
  const harness = createPiHarness();
  piforkExtension(harness.pi as any);
  const command = harness.commands.get("pifork");
  assert.ok(command);

  const context = createContext({ sessionFile: undefined });
  await command.handler("", context.ctx);

  assert.deepEqual(harness.execCalls, []);
  assert.deepEqual(context.notifications.at(-1), {
    message: "Cannot fork an ephemeral session; start Pi with session saving enabled",
    level: "error",
  });
});
