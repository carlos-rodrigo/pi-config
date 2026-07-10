import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fileOpenerExtension, { getGitOriginalContent } from "./index.ts";

function registeredOpenFile(execImpl: (...args: any[]) => Promise<any> = async () => ({ stdout: "", stderr: "", code: 0, killed: false })) {
  let tool: any;
  fileOpenerExtension({
    registerCommand() {},
    registerTool(definition: any) {
      if (definition.name === "open_file") tool = definition;
    },
    exec: execImpl,
  } as any);
  assert.ok(tool);
  return tool;
}

test("open_file rejects missing paths as tool failures", async () => {
  const tool = registeredOpenFile();
  await assert.rejects(
    tool.execute("call-1", { path: "/definitely/missing/pi-config-file", mode: "view" }, undefined, undefined, {
      cwd: process.cwd(),
      mode: "tui",
      hasUI: true,
      ui: {},
    }),
    /File not found/,
  );
});

test("open_file passes apostrophe paths to tmux without an outer shell", async () => {
  const dir = mkdtempSync(join(tmpdir(), "file-opener-"));
  const file = join(dir, "it's.ts");
  writeFileSync(file, "export const value = 1;\n", "utf8");
  const calls: Array<{ command: string; args: string[] }> = [];
  const previousTmux = process.env.TMUX;
  process.env.TMUX = "/tmp/tmux-test";
  try {
    const tool = registeredOpenFile(async (command, args) => {
      calls.push({ command, args });
      return { stdout: "", stderr: "", code: 0, killed: false };
    });
    await tool.execute("call-2", { path: file, mode: "edit", line: 7 }, undefined, undefined, {
      cwd: dir,
      mode: "tui",
      hasUI: true,
      ui: {},
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, "tmux");
    assert.deepEqual(calls[0]?.args.slice(0, 2), ["split-window", "-h"]);
    assert.match(calls[0]?.args[2] ?? "", /nvim \+7 -- '\/.*it'\"'\"'s\.ts'/);
  } finally {
    if (previousTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = previousTmux;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("open_file view mode requires the interactive TUI", async () => {
  const dir = mkdtempSync(join(tmpdir(), "file-opener-rpc-"));
  const file = join(dir, "view.ts");
  writeFileSync(file, "export const value = 1;\n", "utf8");
  try {
    const tool = registeredOpenFile();
    await assert.rejects(
      tool.execute("call-rpc", { path: file, mode: "view" }, undefined, undefined, {
        cwd: dir,
        mode: "rpc",
        hasUI: true,
        ui: { custom: async () => undefined },
      }),
      /interactive Pi TUI/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git original lookup supports shell-significant file names", async () => {
  const dir = mkdtempSync(join(tmpdir(), "file-opener-git-"));
  const file = join(dir, "it's.ts");
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    writeFileSync(file, "before\n", "utf8");
    execFileSync("git", ["add", "--", "it's.ts"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir });
    writeFileSync(file, "after\n", "utf8");

    assert.equal(await getGitOriginalContent(file), "before\n");
    assert.equal(readFileSync(file, "utf8"), "after\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
