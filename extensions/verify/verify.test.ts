import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import verifyExtension from "./index.ts";

type PiEventHandler = (...args: any[]) => unknown;
type ExecCall = { command: string; args: string[]; options?: { cwd?: string; timeout?: number } };

function makeTempProject() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-extension-"));
	return {
		root,
		cleanup() {
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

function createHarness(
	execImpl?: (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<any>,
) {
	const eventHandlers = new Map<string, PiEventHandler>();
	const commands = new Map<string, { description: string; handler: (...args: any[]) => unknown }>();
	const sendUserMessages: Array<{ content: string; options: any }> = [];
	const execCalls: ExecCall[] = [];
	const eventBusHandlers = new Map<string, ((data: unknown) => void)[]>();

	const pi = {
		on(name: string, handler: PiEventHandler) {
			eventHandlers.set(name, handler);
		},
		registerCommand(name: string, definition: { description: string; handler: (...args: any[]) => unknown }) {
			commands.set(name, definition);
		},
		sendUserMessage(content: string, options?: any) {
			sendUserMessages.push({ content, options });
		},
		events: {
			emit(name: string, data: unknown) {
				for (const handler of eventBusHandlers.get(name) ?? []) {
					handler(data);
				}
			},
			on(name: string, handler: (data: unknown) => void) {
				const handlers = eventBusHandlers.get(name) ?? [];
				handlers.push(handler);
				eventBusHandlers.set(name, handlers);
				return () => {};
			},
		},
		async exec(command: string, args: string[], options?: { cwd?: string; timeout?: number }) {
			execCalls.push({ command, args, options });
			if (execImpl) return execImpl(command, args, options);
			return { stdout: "", stderr: "", code: 1, killed: false };
		},
	};

	verifyExtension(pi as any);

	return {
		eventHandlers,
		commands,
		sendUserMessages,
		execCalls,
		emit(name: string, data?: unknown) {
			for (const handler of eventBusHandlers.get(name) ?? []) {
				handler(data);
			}
		},
	};
}

function createCtx(cwd: string, options?: { idle?: boolean; hasUI?: boolean; sessionId?: string }) {
	const notifications: Array<{ message: string; level: string }> = [];
	const editorTexts: string[] = [];
	const idle = options?.idle ?? true;
	const hasUI = options?.hasUI ?? true;

	return {
		notifications,
		editorTexts,
		ctx: {
			cwd,
			hasUI,
			sessionManager: {
				getSessionId() {
					return options?.sessionId ?? "session-a";
				},
			},
			isIdle() {
				return idle;
			},
			ui: {
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
				setEditorText(text: string) {
					editorTexts.push(text);
				},
			},
		},
	};
}

test("agent_end verifies only the touched project root and stays silent on success", async (t) => {
	const fixture = makeTempProject();
	t.after(() => fixture.cleanup());

	fs.mkdirSync(path.join(fixture.root, "scripts"), { recursive: true });
	fs.writeFileSync(path.join(fixture.root, "scripts", "verify.sh"), "#!/bin/bash\nexit 0\n", "utf8");

	const { eventHandlers, execCalls, sendUserMessages } = createHarness(async (command, args, options) => {
		if (command === "bash" && args[0] === "scripts/verify.sh") {
			return { stdout: "", stderr: "", code: 0, killed: false };
		}
		return { stdout: "", stderr: "fatal: not a git repository", code: 1, killed: false };
	});
	const toolCall = eventHandlers.get("tool_call");
	const agentEnd = eventHandlers.get("agent_end");
	assert.ok(toolCall);
	assert.ok(agentEnd);

	await toolCall({ toolName: "edit", input: { path: path.join(fixture.root, "src", "index.ts") } }, createCtx("/tmp/elsewhere").ctx as any);
	await agentEnd({}, createCtx("/tmp/elsewhere").ctx as any);

	const verifyCall = execCalls.find((call) => call.command === "bash");
	assert.deepEqual(verifyCall, {
		command: "bash",
		args: ["scripts/verify.sh"],
		options: { cwd: fixture.root, timeout: 60_000 },
	});
	assert.equal(sendUserMessages.length, 0);
});

test("agent_end skips missing scripts/verify.sh even when a project root is detected", async (t) => {
	const fixture = makeTempProject();
	t.after(() => fixture.cleanup());

	fs.writeFileSync(path.join(fixture.root, "package.json"), JSON.stringify({ name: "fixture" }), "utf8");

	const { eventHandlers, execCalls, sendUserMessages } = createHarness(async () => {
		return { stdout: "", stderr: "fatal: not a git repository", code: 1, killed: false };
	});
	const toolCall = eventHandlers.get("tool_call");
	const agentEnd = eventHandlers.get("agent_end");
	assert.ok(toolCall);
	assert.ok(agentEnd);

	await toolCall({ toolName: "write", input: { path: path.join(fixture.root, "src", "index.ts") } }, createCtx("/tmp/elsewhere").ctx as any);
	await agentEnd({}, createCtx("/tmp/elsewhere").ctx as any);

	assert.equal(execCalls.some((call) => call.command === "bash" && call.args[0] === "scripts/verify.sh"), false);
	assert.equal(sendUserMessages.length, 0);
});

test("verification failure message points the agent at the correct repo root", async (t) => {
	const fixture = makeTempProject();
	t.after(() => fixture.cleanup());

	fs.mkdirSync(path.join(fixture.root, "scripts"), { recursive: true });
	fs.writeFileSync(path.join(fixture.root, "scripts", "verify.sh"), "#!/bin/bash\nexit 1\n", "utf8");

	const { eventHandlers, sendUserMessages } = createHarness(async (command, args) => {
		if (command === "bash" && args[0] === "scripts/verify.sh") {
			return { stdout: "", stderr: "tests failed", code: 2, killed: false };
		}
		return { stdout: "", stderr: "fatal: not a git repository", code: 1, killed: false };
	});
	const toolCall = eventHandlers.get("tool_call");
	const agentEnd = eventHandlers.get("agent_end");
	assert.ok(toolCall);
	assert.ok(agentEnd);

	await toolCall({ toolName: "edit", input: { path: path.join(fixture.root, "feature.ts") } }, createCtx("/Users/carlosrodrigo/agents").ctx as any);
	await agentEnd({}, createCtx("/Users/carlosrodrigo/agents").ctx as any);

	assert.equal(sendUserMessages.length, 1);
	assert.match(sendUserMessages[0].content, /tests failed/);
	assert.ok(sendUserMessages[0].content.includes(`cd '${fixture.root}' && bash scripts/verify.sh`));
	assert.deepEqual(sendUserMessages[0].options, { deliverAs: "followUp" });
});

test("handoff session-start event clears pending verification work", async (t) => {
	const fixture = makeTempProject();
	t.after(() => fixture.cleanup());

	fs.mkdirSync(path.join(fixture.root, "scripts"), { recursive: true });
	fs.writeFileSync(path.join(fixture.root, "scripts", "verify.sh"), "#!/bin/bash\nexit 1\n", "utf8");

	const { eventHandlers, execCalls, sendUserMessages, emit } = createHarness(async (command, args) => {
		if (command === "bash" && args[0] === "scripts/verify.sh") {
			return { stdout: "", stderr: "tests failed", code: 2, killed: false };
		}
		return { stdout: "", stderr: "fatal: not a git repository", code: 1, killed: false };
	});
	const toolCall = eventHandlers.get("tool_call");
	const agentEnd = eventHandlers.get("agent_end");
	assert.ok(toolCall);
	assert.ok(agentEnd);

	await toolCall({ toolName: "edit", input: { path: path.join(fixture.root, "feature.ts") } }, createCtx(fixture.root, { sessionId: "session-a" }).ctx as any);
	emit("handoff:session_started", { mode: "tool" });
	await agentEnd({}, createCtx(fixture.root, { sessionId: "session-a" }).ctx as any);

	assert.equal(execCalls.some((call) => call.command === "bash" && call.args[0] === "scripts/verify.sh"), false);
	assert.equal(sendUserMessages.length, 0);
});

test("session id drift clears touched paths even if no lifecycle event fired", async (t) => {
	const fixture = makeTempProject();
	t.after(() => fixture.cleanup());

	fs.mkdirSync(path.join(fixture.root, "scripts"), { recursive: true });
	fs.writeFileSync(path.join(fixture.root, "scripts", "verify.sh"), "#!/bin/bash\nexit 1\n", "utf8");

	const { eventHandlers, execCalls, sendUserMessages } = createHarness(async (command, args) => {
		if (command === "bash" && args[0] === "scripts/verify.sh") {
			return { stdout: "", stderr: "tests failed", code: 2, killed: false };
		}
		return { stdout: "", stderr: "fatal: not a git repository", code: 1, killed: false };
	});
	const toolCall = eventHandlers.get("tool_call");
	const agentEnd = eventHandlers.get("agent_end");
	assert.ok(toolCall);
	assert.ok(agentEnd);

	await toolCall({ toolName: "edit", input: { path: path.join(fixture.root, "feature.ts") } }, createCtx(fixture.root, { sessionId: "session-a" }).ctx as any);
	await agentEnd({}, createCtx(fixture.root, { sessionId: "session-b" }).ctx as any);

	assert.equal(execCalls.some((call) => call.command === "bash" && call.args[0] === "scripts/verify.sh"), false);
	assert.equal(sendUserMessages.length, 0);
});

test("/setup-verify scaffolds a node template, queues refinement, and marks the repo for verification", async (t) => {
	const fixture = makeTempProject();
	t.after(() => fixture.cleanup());

	fs.writeFileSync(path.join(fixture.root, "package.json"), JSON.stringify({ name: "fixture" }), "utf8");
	fs.writeFileSync(path.join(fixture.root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
	fs.mkdirSync(path.join(fixture.root, ".github", "workflows"), { recursive: true });

	const { commands, eventHandlers, sendUserMessages, execCalls } = createHarness(async (command, args, options) => {
		if (command === "bash" && args[0] === "scripts/verify.sh") {
			return { stdout: "", stderr: "", code: 0, killed: false };
		}
		return { stdout: "", stderr: "fatal: not a git repository", code: 1, killed: false };
	});
	const setupVerify = commands.get("setup-verify");
	const agentEnd = eventHandlers.get("agent_end");
	assert.ok(setupVerify);
	assert.ok(agentEnd);

	const context = createCtx(fixture.root);
	await setupVerify.handler("", context.ctx as any);

	const verifyScriptPath = path.join(fixture.root, "scripts", "verify.sh");
	const script = fs.readFileSync(verifyScriptPath, "utf8");
	assert.match(script, /pnpm test/);
	assert.match(script, /pnpm lint/);
	assert.match(script, /pnpm build/);
	assert.match(script, /--quick/);
	assert.ok((fs.statSync(verifyScriptPath).mode & 0o111) !== 0);

	assert.equal(sendUserMessages.length, 1);
	assert.match(sendUserMessages[0].content, /starter verification script was created/i);
	assert.match(sendUserMessages[0].content, /package\.json/);
	assert.match(sendUserMessages[0].content, /pnpm-lock\.yaml/);
	assert.match(sendUserMessages[0].content, /\.github\/workflows\//);
	assert.match(sendUserMessages[0].content, /bash scripts\/verify\.sh --quick/);

	await agentEnd({}, context.ctx as any);
	const verifyCall = execCalls.find((call) => call.command === "bash");
	assert.deepEqual(verifyCall, {
		command: "bash",
		args: ["scripts/verify.sh"],
		options: { cwd: fixture.root, timeout: 60_000 },
	});
});

test("/setup-verify preserves an existing script unless --reset is passed", async (t) => {
	const fixture = makeTempProject();
	t.after(() => fixture.cleanup());

	const verifyScriptPath = path.join(fixture.root, "scripts", "verify.sh");
	fs.mkdirSync(path.dirname(verifyScriptPath), { recursive: true });
	fs.writeFileSync(verifyScriptPath, "#!/bin/bash\necho existing\n", "utf8");

	const { commands, sendUserMessages } = createHarness(async () => {
		return { stdout: "", stderr: "fatal: not a git repository", code: 1, killed: false };
	});
	const setupVerify = commands.get("setup-verify");
	assert.ok(setupVerify);

	const context = createCtx(fixture.root);
	await setupVerify.handler("", context.ctx as any);
	assert.equal(fs.readFileSync(verifyScriptPath, "utf8"), "#!/bin/bash\necho existing\n");
	assert.match(sendUserMessages[0].content, /existing verification script was found/i);

	await setupVerify.handler("--reset", context.ctx as any);
	const resetScript = fs.readFileSync(verifyScriptPath, "utf8");
	assert.notEqual(resetScript, "#!/bin/bash\necho existing\n");
	assert.match(resetScript, /Starter verify script generated by \/setup-verify/);
});
