import test from "node:test";
import assert from "node:assert/strict";

import {
  launchLazygitInHerdr,
  parseHerdrTabCreated,
  parseLazygitCommandArgs,
} from "./index.ts";

test("parseLazygitCommandArgs accepts an optional path", () => {
  assert.deepEqual(parseLazygitCommandArgs(""), {});
  assert.deepEqual(parseLazygitCommandArgs("src"), { path: "src" });
});

test("parseLazygitCommandArgs tolerates the legacy split flag", () => {
  assert.deepEqual(parseLazygitCommandArgs("src --split vertical"), { path: "src" });
  assert.deepEqual(parseLazygitCommandArgs("--split window packages/app"), { path: "packages/app" });
});

test("parseHerdrTabCreated extracts the hidden tab and pane ids", () => {
  const created = parseHerdrTabCreated(JSON.stringify({
    result: {
      root_pane: { pane_id: "w3:p7" },
      tab: { tab_id: "w3:t2" },
      type: "tab_created",
    },
  }));

  assert.deepEqual(created, { tabId: "w3:t2", paneId: "w3:p7" });
});

test("parseHerdrTabCreated rejects malformed responses", () => {
  assert.throws(() => parseHerdrTabCreated("{}"), /tab creation response/i);
  assert.throws(() => parseHerdrTabCreated("not json"), /tab creation response/i);
});

test("launchLazygitInHerdr creates a hidden tab and starts lazygit", async () => {
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const pi = {
    exec: async (command: string, args: string[], options?: { cwd?: string }) => {
      calls.push({ command, args, cwd: options?.cwd });
      if (args[0] === "tab" && args[1] === "create") {
        return {
          stdout: JSON.stringify({ result: { root_pane: { pane_id: "w3:p7" }, tab: { tab_id: "w3:t2" } } }),
          stderr: "",
          code: 0,
          killed: false,
        };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
  } as any;

  const launched = await launchLazygitInHerdr(pi, "/tmp/repo", "w3");

  assert.deepEqual(launched, { tabId: "w3:t2", paneId: "w3:p7" });
  assert.deepEqual(calls, [
    {
      command: "herdr",
      args: ["tab", "create", "--workspace", "w3", "--cwd", "/tmp/repo", "--label", "lazygit", "--no-focus"],
      cwd: undefined,
    },
    {
      command: "herdr",
      args: ["pane", "run", "w3:p7", "lazygit"],
      cwd: undefined,
    },
  ]);
});

test("launchLazygitInHerdr closes the hidden tab when startup fails", async () => {
  const calls: string[][] = [];
  const pi = {
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "tab" && args[1] === "create") {
        return {
          stdout: JSON.stringify({ result: { root_pane: { pane_id: "w3:p7" }, tab: { tab_id: "w3:t2" } } }),
          stderr: "",
          code: 0,
          killed: false,
        };
      }
      if (args[0] === "pane" && args[1] === "run") {
        return { stdout: "", stderr: "run failed", code: 1, killed: false };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
  } as any;

  await assert.rejects(launchLazygitInHerdr(pi, "/tmp/repo", "w3"), /run failed/);
  assert.deepEqual(calls.at(-1), ["tab", "close", "w3:t2"]);
});
