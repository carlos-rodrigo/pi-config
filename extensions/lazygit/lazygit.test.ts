import test from "node:test";
import assert from "node:assert/strict";

import { buildTmuxLazygitCommand, openLazygitInTmux, parseLazygitCommandArgs } from "./index.ts";

test("parseLazygitCommandArgs defaults to popup when no args", () => {
  const parsed = parseLazygitCommandArgs("");
  assert.equal(parsed.path, undefined);
  assert.equal(parsed.split, "popup");
});

test("parseLazygitCommandArgs extracts path and split mode", () => {
  const parsed = parseLazygitCommandArgs("src --split vertical");
  assert.equal(parsed.path, "src");
  assert.equal(parsed.split, "vertical");
});

test("parseLazygitCommandArgs supports split flag before path", () => {
  const parsed = parseLazygitCommandArgs("--split window packages/app");
  assert.equal(parsed.path, "packages/app");
  assert.equal(parsed.split, "window");
});

test("buildTmuxLazygitCommand uses popup command", () => {
  const cmd = buildTmuxLazygitCommand("/tmp/repo", "popup");
  assert.match(cmd, /^tmux popup -E -w 90% -h 90% -d '\/tmp\/repo' \"lazygit\"$/);
});

test("buildTmuxLazygitCommand escapes single quotes in path", () => {
  const cmd = buildTmuxLazygitCommand("/tmp/it's-repo", "window");
  assert.match(cmd, /'\/tmp\/it'"'"'s-repo'/);
  assert.match(cmd, /^tmux new-window/);
});

test("openLazygitInTmux rejects nonzero tmux exits", async () => {
  const pi = {
    exec: async () => ({ stdout: "", stderr: "tmux failed", code: 1, killed: false }),
  } as any;

  await assert.rejects(openLazygitInTmux(pi, "/tmp/repo", "window"), /tmux failed/);
});
