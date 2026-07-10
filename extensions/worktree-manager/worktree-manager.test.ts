import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import worktreeManagerExtension from "./index.ts";
import { copyEnvFiles } from "./lib/worktree.ts";

function registeredTool() {
  let tool: any;
  worktreeManagerExtension({
    registerCommand() {},
    registerTool(definition: any) {
      if (definition.name === "worktree_manage") tool = definition;
    },
  } as any);
  assert.ok(tool);
  return tool;
}

test("copyEnvFiles copies env files only when explicitly invoked", async () => {
  const root = mkdtempSync(join(tmpdir(), "worktree-env-"));
  const source = join(root, "source");
  const target = join(root, "target");
  mkdirSync(source);
  mkdirSync(target);
  try {
    writeFileSync(join(source, ".env"), "SECRET=value\n", "utf8");
    await copyEnvFiles(source, target);
    assert.equal(readFileSync(join(target, ".env"), "utf8"), "SECRET=value\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktree_manage rejects missing required targets", async () => {
  const tool = registeredTool();
  await assert.rejects(
    tool.execute("call-1", { action: "new" }, undefined, undefined, { cwd: process.cwd() }),
    /target is required for action=new/,
  );
});

test("worktree_manage reports list outside a repository as a tool failure", async () => {
  let tool: any;
  worktreeManagerExtension({
    registerCommand() {},
    registerTool(definition: any) {
      if (definition.name === "worktree_manage") tool = definition;
    },
    exec: async () => ({ stdout: "", stderr: "not a repository", code: 128, killed: false }),
  } as any);

  await assert.rejects(
    tool.execute("call-1", { action: "list" }, undefined, undefined, { cwd: process.cwd() }),
    /Not inside a git repository/,
  );
});
