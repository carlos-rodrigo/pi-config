import test from "node:test";
import assert from "node:assert/strict";

import branchSwitcherExtension, {
	buildSwitchArgs,
	formatBranchChoice,
	formatBranchList,
	getVisibleBranches,
	parseBranchList,
	resolveRequestedBranch,
} from "./index.ts";

type CommandDefinition = { description: string; handler: (...args: any[]) => unknown };

type ExecResult = { code: number; stdout: string; stderr: string };

function createPiHarness(execResults: ExecResult[]) {
	const commands = new Map<string, CommandDefinition>();
	const execCalls: Array<{ command: string; args: string[] }> = [];

	return {
		commands,
		execCalls,
		pi: {
			registerCommand(name: string, definition: CommandDefinition) {
				commands.set(name, definition);
			},
			async exec(command: string, args: string[]) {
				execCalls.push({ command, args });
				const result = execResults.shift();
				assert.ok(result, `Unexpected exec call: ${command} ${args.join(" ")}`);
				return result;
			},
		},
	};
}

function createContext(options?: { hasUI?: boolean; selectResult?: string | undefined; cwd?: string }) {
	const notifications: Array<{ message: string; level: string }> = [];
	const editorWrites: string[] = [];
	const selects: Array<{ title: string; items: string[] }> = [];
	let waitForIdleCalls = 0;

	return {
		notifications,
		editorWrites,
		selects,
		getWaitForIdleCalls: () => waitForIdleCalls,
		ctx: {
			cwd: options?.cwd ?? "/repo",
			hasUI: options?.hasUI ?? true,
			async waitForIdle() {
				waitForIdleCalls += 1;
			},
			ui: {
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
				setEditorText(text: string) {
					editorWrites.push(text);
				},
				async select(title: string, items: string[]) {
					selects.push({ title, items });
					return options?.selectResult;
				},
			},
		},
	};
}

function sampleBranchOutput(): string {
	return [
		"refs/heads/main\tmain\t*",
		"refs/heads/feature/login\tfeature/login\t",
		"refs/remotes/origin/HEAD\torigin/HEAD\t",
		"refs/remotes/origin/feature/login\torigin/feature/login\t",
		"refs/remotes/origin/feature/remote-only\torigin/feature/remote-only\t",
	].join("\n");
}

test("parseBranchList reads local and remote refs and ignores remote HEAD", () => {
	const branches = parseBranchList(sampleBranchOutput());

	assert.deepEqual(
		branches.map((branch) => ({ shortName: branch.shortName, kind: branch.kind, current: branch.isCurrent, localName: branch.localName })),
		[
			{ shortName: "main", kind: "local", current: true, localName: "main" },
			{ shortName: "feature/login", kind: "local", current: false, localName: "feature/login" },
			{ shortName: "origin/feature/login", kind: "remote", current: false, localName: "feature/login" },
			{ shortName: "origin/feature/remote-only", kind: "remote", current: false, localName: "feature/remote-only" },
		],
	);
});

test("getVisibleBranches hides remote duplicates when a local branch exists", () => {
	const visible = getVisibleBranches(parseBranchList(sampleBranchOutput()));
	assert.deepEqual(visible.map((branch) => branch.shortName), ["main", "feature/login", "origin/feature/remote-only"]);
});

test("resolveRequestedBranch matches a unique remote by its local branch name", () => {
	const result = resolveRequestedBranch("feature/remote-only", parseBranchList(sampleBranchOutput()));
	assert.equal(result.branch?.shortName, "origin/feature/remote-only");
	assert.equal(result.error, undefined);
});

test("buildSwitchArgs uses tracking for remote branches", () => {
	const remoteBranch = resolveRequestedBranch("origin/feature/remote-only", parseBranchList(sampleBranchOutput())).branch;
	assert.ok(remoteBranch);
	assert.deepEqual(buildSwitchArgs(remoteBranch), ["switch", "--track", "origin/feature/remote-only"]);
});

test("formatBranchChoice marks current and remote branches", () => {
	const [current, , remote] = getVisibleBranches(parseBranchList(sampleBranchOutput()));
	assert.equal(formatBranchChoice(current), "main · current");
	assert.equal(formatBranchChoice(remote), "origin/feature/remote-only · remote");
});

test("/branch without args opens a picker and switches to the selected branch", async () => {
	const harness = createPiHarness([
		{ code: 0, stdout: sampleBranchOutput(), stderr: "" },
		{ code: 0, stdout: "", stderr: "" },
	]);
	branchSwitcherExtension(harness.pi as any);

	const choice = formatBranchChoice(getVisibleBranches(parseBranchList(sampleBranchOutput()))[1]!);
	const context = createContext({ selectResult: choice });
	const command = harness.commands.get("branch");
	assert.ok(command);

	await command.handler("", context.ctx as any);

	assert.equal(context.getWaitForIdleCalls(), 1);
	assert.equal(context.selects[0]?.title, "Switch branch");
	assert.deepEqual(harness.execCalls[1], {
		command: "git",
		args: ["-C", "/repo", "switch", "feature/login"],
	});
	assert.deepEqual(context.notifications.at(-1), { message: "Switched to feature/login", level: "info" });
});

test("/branch switches to a unique remote branch with --track", async () => {
	const harness = createPiHarness([
		{ code: 0, stdout: sampleBranchOutput(), stderr: "" },
		{ code: 0, stdout: "", stderr: "" },
	]);
	branchSwitcherExtension(harness.pi as any);
	const context = createContext();
	const command = harness.commands.get("branch");
	assert.ok(command);

	await command.handler("feature/remote-only", context.ctx as any);

	assert.deepEqual(harness.execCalls[1], {
		command: "git",
		args: ["-C", "/repo", "switch", "--track", "origin/feature/remote-only"],
	});
	assert.deepEqual(context.notifications.at(-1), { message: "Switched to feature/remote-only", level: "info" });
});

test("/branch list writes switchable branches to the editor", async () => {
	const harness = createPiHarness([{ code: 0, stdout: sampleBranchOutput(), stderr: "" }]);
	branchSwitcherExtension(harness.pi as any);
	const context = createContext();
	const command = harness.commands.get("branch");
	assert.ok(command);

	await command.handler("list", context.ctx as any);

	assert.equal(context.editorWrites[0], formatBranchList(getVisibleBranches(parseBranchList(sampleBranchOutput()))));
	assert.deepEqual(context.notifications.at(-1), { message: "Listed 3 branches", level: "info" });
});

test("/branch reports when the current directory is not a git repository", async () => {
	const harness = createPiHarness([{ code: 128, stdout: "", stderr: "fatal: not a git repository" }]);
	branchSwitcherExtension(harness.pi as any);
	const context = createContext();
	const command = harness.commands.get("branch");
	assert.ok(command);

	await command.handler("list", context.ctx as any);

	assert.deepEqual(context.notifications.at(-1), { message: "Not inside a git repository", level: "error" });
});
