import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import worktreeManagerExtension from "./index.ts";
import { copyWorktreeEnvironment, createFeatureWorktree } from "./lib/worktree.ts";

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

test("copyWorktreeEnvironment creates a complete local development environment without runtime history", async () => {
  const root = mkdtempSync(join(tmpdir(), "worktree-local-environment-"));
  const source = join(root, "source");
  const target = join(root, "target");
  mkdirSync(source);
  mkdirSync(target);

  try {
    mkdirSync(join(source, ".claude", "skills", "review"), { recursive: true });
    mkdirSync(join(source, ".features", "checkout", "tasks"), { recursive: true });
    mkdirSync(join(source, ".pi", "semantic-search"), { recursive: true });
    mkdirSync(join(source, ".pi", "agent-jobs", "old-job"), { recursive: true });
    mkdirSync(join(target, ".claude"), { recursive: true });

    writeFileSync(join(source, ".env.local"), "SECRET=value\n", "utf8");
    writeFileSync(join(source, ".claude", "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    writeFileSync(join(source, ".features", "checkout", "tasks", "001.md"), "# Task\n", "utf8");
    writeFileSync(join(source, ".pi", "semantic-search", "index.json"), '{"cwd":"/source"}\n', "utf8");
    writeFileSync(join(source, ".pi", "semantic-search", "rebuild.log"), "stale log\n", "utf8");
    writeFileSync(join(source, ".pi", "agent-jobs", "old-job", "events.jsonl"), "history\n", "utf8");
    writeFileSync(join(source, "local-notes.txt"), "not hidden\n", "utf8");
    writeFileSync(join(target, ".claude", "settings.json"), "tracked target\n", "utf8");
    writeFileSync(join(source, ".claude", "settings.json"), "dirty source\n", "utf8");
    symlinkSync(".env.local", join(source, ".env.current"));

    const result = await copyWorktreeEnvironment(source, target);

    assert.equal(readFileSync(join(target, ".env.local"), "utf8"), "SECRET=value\n");
    assert.equal(readFileSync(join(target, ".claude", "skills", "review", "SKILL.md"), "utf8"), "# Review\n");
    assert.equal(readFileSync(join(target, ".features", "checkout", "tasks", "001.md"), "utf8"), "# Task\n");
    assert.equal(readFileSync(join(target, ".pi", "semantic-search", "index.json"), "utf8"), '{"cwd":"/source"}\n');
    assert.equal(readFileSync(join(target, ".claude", "settings.json"), "utf8"), "tracked target\n");
    assert.equal(lstatSync(join(target, ".env.current")).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(target, ".env.current")), ".env.local");
    assert.equal(existsSync(join(target, ".pi", "semantic-search", "rebuild.log")), false);
    assert.equal(existsSync(join(target, ".pi", "agent-jobs")), false);
    assert.equal(existsSync(join(target, "local-notes.txt")), false);
    assert.ok(result.copied.some((entry) => entry === ".env.local"));
    assert.deepEqual(result.warnings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createFeatureWorktree prefers the invoking worktree environment and fills gaps from primary", async () => {
  const root = mkdtempSync(join(tmpdir(), "worktree-create-local-environment-"));
  const primary = join(root, "repo");
  const linked = join(root, "repo-existing-feature");
  mkdirSync(primary);
  mkdirSync(linked);
  writeFileSync(join(primary, ".env.local"), "SECRET=primary\n", "utf8");
  writeFileSync(join(primary, ".env.primary"), "PRIMARY_ONLY=true\n", "utf8");
  mkdirSync(join(linked, ".features", "current"), { recursive: true });
  mkdirSync(join(primary, ".pi", "semantic-search"), { recursive: true });
  mkdirSync(join(linked, ".pi", "semantic-search"), { recursive: true });
  writeFileSync(join(linked, ".env.local"), "SECRET=current\n", "utf8");
  writeFileSync(join(linked, ".features", "current", "task.md"), "# Current task\n", "utf8");
  writeFileSync(join(primary, ".pi", "semantic-search", "index.json"), "primary index\n", "utf8");
  writeFileSync(join(linked, ".pi", "semantic-search", "index.json"), "current feature index\n", "utf8");

  const pi = {
    async exec(_command: string, args: string[]) {
      const gitArgs = args.slice(2);
      if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--show-toplevel") {
        return { stdout: `${linked}\n`, stderr: "", code: 0, killed: false };
      }
      if (gitArgs[0] === "worktree" && gitArgs[1] === "list") {
        return {
          stdout: `worktree ${primary}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${linked}\nHEAD def\nbranch refs/heads/feat/existing\n`,
          stderr: "",
          code: 0,
          killed: false,
        };
      }
      if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--verify") {
        return { stdout: "abc\n", stderr: "", code: 0, killed: false };
      }
      if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--git-path") {
        return { stdout: ".git/info/exclude\n", stderr: "", code: 0, killed: false };
      }
      if (gitArgs[0] === "show-ref") {
        return { stdout: "", stderr: "", code: 1, killed: false };
      }
      if (gitArgs[0] === "worktree" && gitArgs[1] === "add") {
        mkdirSync(gitArgs[4]!, { recursive: true });
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      throw new Error(`Unexpected git args: ${gitArgs.join(" ")}`);
    },
  } as any;

  try {
    const result = await createFeatureWorktree(pi, linked, "copy local setup");

    assert.equal(result.ok, true);
    assert.equal(result.repoContext?.gitRoot, primary);
    assert.equal(result.repoContext?.currentRoot, linked);
    assert.equal(result.worktreePath, join(root, "repo-copy-local-setup"));
    assert.equal(readFileSync(join(result.worktreePath, ".env.local"), "utf8"), "SECRET=current\n");
    assert.equal(readFileSync(join(result.worktreePath, ".env.primary"), "utf8"), "PRIMARY_ONLY=true\n");
    assert.equal(readFileSync(join(result.worktreePath, ".features", "current", "task.md"), "utf8"), "# Current task\n");
    assert.equal(readFileSync(join(result.worktreePath, ".pi", "semantic-search", "index.json"), "utf8"), "primary index\n");
    assert.ok(result.environmentCopy?.copied.includes(".env.local"));
    assert.match(readFileSync(join(primary, ".git", "info", "exclude"), "utf8"), /^\/\.env\.local$/m);
    assert.deepEqual(result.environmentCopy?.warnings, []);

    const isolated = await createFeatureWorktree(pi, linked, "isolated scratch", { copyLocalEnvironment: false });
    assert.equal(isolated.ok, true);
    assert.equal(isolated.environmentCopy, undefined);
    assert.equal(existsSync(join(isolated.worktreePath, ".env.local")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktree_manage prepares legacy copyEnv arguments for resumed sessions", () => {
  const tool = registeredTool();
  assert.deepEqual(
    tool.prepareArguments({ action: "new", target: "legacy", copyEnv: false }),
    { action: "new", target: "legacy", copyLocal: false },
  );
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
