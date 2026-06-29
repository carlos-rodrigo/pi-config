import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import checkpointRollbackExtension, {
	createCheckpoint,
	formatCheckpointList,
	parseCheckpointArgs,
	rollbackCheckpoint,
	selectCheckpoint,
} from "./index.ts";

type CommandDefinition = { description: string; handler: (...args: any[]) => unknown };
type ExecResult = { code: number; stdout: string; stderr: string };

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function makeGitRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-rollback-"));
	git(root, ["init", "-q"]);
	git(root, ["config", "user.email", "pi@example.test"]);
	git(root, ["config", "user.name", "Pi Test"]);
	fs.writeFileSync(path.join(root, "notes.txt"), "base\n", "utf8");
	git(root, ["add", "notes.txt"]);
	git(root, ["commit", "-q", "-m", "initial"]);
	return {
		root,
		cleanup() {
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

function createRealRunner() {
	return {
		async exec(command: string, args: string[]): Promise<ExecResult> {
			try {
				const stdout = execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
				return { code: 0, stdout, stderr: "" };
			} catch (error) {
				const failure = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
				return {
					code: failure.status ?? 1,
					stdout: Buffer.isBuffer(failure.stdout) ? failure.stdout.toString("utf8") : failure.stdout ?? "",
					stderr: Buffer.isBuffer(failure.stderr) ? failure.stderr.toString("utf8") : failure.stderr ?? failure.message ?? "",
				};
			}
		},
	};
}

function createHarness() {
	const commands = new Map<string, CommandDefinition>();
	const tools = new Map<string, any>();
	const runner = createRealRunner();
	const pi = {
		registerCommand(name: string, definition: CommandDefinition) {
			commands.set(name, definition);
		},
		registerTool(definition: any) {
			tools.set(definition.name, definition);
		},
		exec: runner.exec,
	};
	checkpointRollbackExtension(pi as any);
	return { commands, tools };
}

function createContext(cwd: string) {
	const notifications: Array<{ message: string; level: string }> = [];
	const editorWrites: string[] = [];
	return {
		notifications,
		editorWrites,
		ctx: {
			cwd,
			hasUI: true,
			ui: {
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
				setEditorText(text: string) {
					editorWrites.push(text);
				},
			},
		},
	};
}

test("parseCheckpointArgs requires confirmation for rollback but not preview", () => {
	assert.deepEqual(parseCheckpointArgs("create before risky edit"), {
		action: "create",
		label: "before risky edit",
		confirm: false,
		force: false,
	});
	assert.deepEqual(parseCheckpointArgs("rollback last --confirm --force"), {
		action: "rollback",
		id: "last",
		confirm: true,
		force: true,
	});
	assert.deepEqual(parseCheckpointArgs("preview chk-123"), {
		action: "preview",
		id: "chk-123",
		confirm: false,
		force: false,
	});
});

test("createCheckpoint records HEAD, dirty patch, summary, and list output", async (t) => {
	const fixture = makeGitRepo();
	t.after(() => fixture.cleanup());
	fs.writeFileSync(path.join(fixture.root, "notes.txt"), "dirty before checkpoint\n", "utf8");

	const result = await createCheckpoint(createRealRunner(), fixture.root, "before agent");

	assert.equal(result.status, "created");
	assert.equal(result.checkpoint.label, "before agent");
	assert.match(result.checkpoint.headSha, /^[a-f0-9]{40}$/);
	assert.match(result.checkpoint.dirtySummary, /notes\.txt/);
	assert.ok(result.checkpoint.patchBytes > 0);
	assert.ok(fs.existsSync(path.join(fixture.root, result.checkpoint.patchFile)));
	assert.match(formatCheckpointList([result.checkpoint]), /before agent/);
	assert.equal(selectCheckpoint([result.checkpoint], "last").checkpoint?.id, result.checkpoint.id);
});

test("rollback preview is non-destructive and confirmed rollback restores a dirty checkpoint", async (t) => {
	const fixture = makeGitRepo();
	t.after(() => fixture.cleanup());
	const file = path.join(fixture.root, "notes.txt");
	fs.writeFileSync(file, "pre-existing dirty edit\n", "utf8");
	const runner = createRealRunner();
	const created = await createCheckpoint(runner, fixture.root, "before attempt");

	fs.writeFileSync(file, "agent attempt edit\n", "utf8");
	const preview = await rollbackCheckpoint(runner, fixture.root, { id: created.checkpoint.id, confirm: false, force: false });

	assert.equal(preview.status, "preview");
	assert.match(preview.report, /requires --confirm/);
	assert.equal(fs.readFileSync(file, "utf8"), "agent attempt edit\n");

	const rolledBack = await rollbackCheckpoint(runner, fixture.root, { id: created.checkpoint.id, confirm: true, force: false });
	assert.equal(rolledBack.status, "rolled-back");
	assert.equal(fs.readFileSync(file, "utf8"), "pre-existing dirty edit\n");
});

test("rollback refuses newly-created untracked files unless forced", async (t) => {
	const fixture = makeGitRepo();
	t.after(() => fixture.cleanup());
	const runner = createRealRunner();
	const created = await createCheckpoint(runner, fixture.root, "clean baseline");
	const generated = path.join(fixture.root, "generated.txt");
	fs.writeFileSync(generated, "agent output\n", "utf8");

	const refused = await rollbackCheckpoint(runner, fixture.root, { id: created.checkpoint.id, confirm: true, force: false });
	assert.equal(refused.status, "refused");
	assert.match(refused.report, /untracked files/);
	assert.equal(fs.existsSync(generated), true);

	const forced = await rollbackCheckpoint(runner, fixture.root, { id: created.checkpoint.id, confirm: true, force: true });
	assert.equal(forced.status, "rolled-back");
	assert.equal(fs.existsSync(generated), false);
});

test("rollback refuses a changed HEAD unless forced", async (t) => {
	const fixture = makeGitRepo();
	t.after(() => fixture.cleanup());
	const runner = createRealRunner();
	const created = await createCheckpoint(runner, fixture.root, "before new commit");
	const file = path.join(fixture.root, "notes.txt");
	fs.writeFileSync(file, "committed after checkpoint\n", "utf8");
	git(fixture.root, ["add", "notes.txt"]);
	git(fixture.root, ["commit", "-q", "-m", "after checkpoint"]);

	const refused = await rollbackCheckpoint(runner, fixture.root, { id: created.checkpoint.id, confirm: true, force: false });

	assert.equal(refused.status, "refused");
	assert.match(refused.report, /HEAD differs/);
	assert.equal(fs.readFileSync(file, "utf8"), "committed after checkpoint\n");
});

test("not-a-git-repo returns a helpful error without destructive action", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-not-git-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.writeFileSync(path.join(root, "notes.txt"), "keep me\n", "utf8");

	await assert.rejects(() => createCheckpoint(createRealRunner(), root, "no repo"), /Not inside a git repository/);
	assert.equal(fs.readFileSync(path.join(root, "notes.txt"), "utf8"), "keep me\n");
});

test("/checkpoint command creates, lists, previews, and confirms rollback", async (t) => {
	const fixture = makeGitRepo();
	t.after(() => fixture.cleanup());
	const file = path.join(fixture.root, "notes.txt");
	const harness = createHarness();
	const command = harness.commands.get("checkpoint");
	assert.ok(command);
	const context = createContext(fixture.root);

	fs.writeFileSync(file, "checkpoint state\n", "utf8");
	await command.handler("create before command rollback", context.ctx as any);
	assert.match(context.editorWrites.at(-1) ?? "", /Checkpoint created/);

	fs.writeFileSync(file, "changed after checkpoint\n", "utf8");
	await command.handler("list", context.ctx as any);
	assert.match(context.editorWrites.at(-1) ?? "", /before command rollback/);

	await command.handler("rollback last", context.ctx as any);
	assert.match(context.editorWrites.at(-1) ?? "", /requires --confirm/);
	assert.equal(fs.readFileSync(file, "utf8"), "changed after checkpoint\n");

	await command.handler("rollback last --confirm", context.ctx as any);
	assert.equal(fs.readFileSync(file, "utf8"), "checkpoint state\n");
	assert.deepEqual(context.notifications.at(-1), { message: "Rollback complete", level: "info" });
});

test("checkpoint_rollback tool creates checkpoints and previews rollback without confirmation", async (t) => {
	const fixture = makeGitRepo();
	t.after(() => fixture.cleanup());
	const file = path.join(fixture.root, "notes.txt");
	const harness = createHarness();
	const tool = harness.tools.get("checkpoint_rollback");
	assert.ok(tool);
	const context = createContext(fixture.root);

	fs.writeFileSync(file, "tool checkpoint state\n", "utf8");
	const created = await tool.execute("tool-1", { action: "create", label: "tool checkpoint" }, undefined, undefined, context.ctx as any);
	assert.match(created.content[0].text, /Checkpoint created/);

	fs.writeFileSync(file, "tool changed state\n", "utf8");
	const preview = await tool.execute("tool-2", { action: "rollback" }, undefined, undefined, context.ctx as any);
	assert.match(preview.content[0].text, /requires --confirm/);
	assert.equal(fs.readFileSync(file, "utf8"), "tool changed state\n");
});
