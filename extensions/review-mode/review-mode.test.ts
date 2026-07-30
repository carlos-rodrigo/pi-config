import test from "node:test";
import assert from "node:assert/strict";

import { visibleWidth } from "@earendil-works/pi-tui";

import registerReviewModeExtension, {
	buildReviewModeDiffHash,
	buildReviewModeGoalContext,
	buildReviewModeHelpText,
	buildReviewModeInjectionPrompt,
	collectReviewModeNotes,
	formatReviewModeChange,
	formatReviewModeNotes,
	handleReviewModeCommand,
	parseGitNameStatusOutput,
	parseReviewModeArgs,
	parseReviewModeDiffFiles,
	parseSemanticReviewResponse,
	ReviewModeWorkbench,
	styleReviewDiffLine,
	truncateReviewDiff,
} from "./index.ts";

type CommandDefinition = { description: string; handler: (...args: any[]) => unknown };
type ExecResult = { code: number; stdout: string; stderr: string };
type EventHandler = (...args: any[]) => unknown;

function createTheme() {
	return {
		fg(_color: string, text: string) {
			return text;
		},
		bg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	} as any;
}

function createTaggedTheme() {
	return {
		fg(color: string, text: string) {
			return `<${color}>${text}</${color}>`;
		},
		bg(color: string, text: string) {
			return `<bg:${color}>${text}</bg:${color}>`;
		},
		bold(text: string) {
			return `<bold>${text}</bold>`;
		},
	} as any;
}

function createAnsiBgTheme() {
	return {
		fg(_color: string, text: string) {
			return text;
		},
		bg(color: string, text: string) {
			if (color === "toolSuccessBg") return `\u001b[48;5;22m${text}\u001b[49m`;
			if (color === "toolErrorBg") return `\u001b[48;5;52m${text}\u001b[49m`;
			return text;
		},
		bold(text: string) {
			return text;
		},
	} as any;
}

function createPiHarness(execResults: ExecResult[]) {
	const commands = new Map<string, CommandDefinition>();
	const eventHandlers = new Map<string, EventHandler>();
	const execCalls: Array<{ command: string; args: string[] }> = [];
	const sendUserMessages: Array<{ content: string; options: any }> = [];
	const appendEntries: Array<{ customType: string; data: unknown }> = [];

	return {
		commands,
		eventHandlers,
		execCalls,
		sendUserMessages,
		appendEntries,
		pi: {
			registerCommand(name: string, definition: CommandDefinition) {
				commands.set(name, definition);
			},
			on(name: string, handler: EventHandler) {
				eventHandlers.set(name, handler);
			},
			appendEntry(customType: string, data: unknown) {
				appendEntries.push({ customType, data });
			},
			sendUserMessage(content: string, options?: any) {
				sendUserMessages.push({ content, options });
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

function createContext(options?: {
	hasUI?: boolean;
	mode?: "tui" | "rpc" | "json" | "print";
	cwd?: string;
	idle?: boolean;
	sessionId?: string;
	entries?: any[];
	simulateCustom?: (component: any) => void;
}) {
	const notifications: Array<{ message: string; level: string }> = [];
	const editorWrites: string[] = [];
	const customRenders: string[][] = [];
	const customOptions: any[] = [];
	let waitForIdleCalls = 0;
	let customCalls = 0;

	return {
		notifications,
		editorWrites,
		customRenders,
		customOptions,
		getWaitForIdleCalls: () => waitForIdleCalls,
		getCustomCalls: () => customCalls,
		ctx: {
			cwd: options?.cwd ?? "/repo",
			hasUI: options?.hasUI ?? true,
			mode: options?.mode ?? "tui",
			isIdle() {
				return options?.idle ?? true;
			},
			async waitForIdle() {
				waitForIdleCalls += 1;
			},
			sessionManager: {
				getSessionId() {
					return options?.sessionId ?? "session-1";
				},
				getEntries() {
					return options?.entries ?? [];
				},
			},
			ui: {
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
				setEditorText(text: string) {
					editorWrites.push(text);
				},
				async custom(factory: any, customOptionsArg?: any) {
					customCalls += 1;
					customOptions.push(customOptionsArg);
					let result: unknown;
					const component = factory(
						{ requestRender() {} } as any,
						createTheme(),
						{} as any,
						(value: unknown) => {
							result = value;
						},
					);
					customRenders.push(component.render(120));
					options?.simulateCustom?.(component);
					if (result === undefined) {
						component.handleInput?.("\u001b");
					}
					return result;
				},
			},
		},
	};
}

test("review mode rejects RPC mode before opening a custom overlay", async () => {
	const context = createContext({ mode: "rpc", hasUI: true });
	await handleReviewModeCommand({} as any, "", context.ctx as any);
	assert.equal(context.getCustomCalls(), 0);
	assert.match(context.notifications[0]?.message ?? "", /interactive Pi TUI/i);
});

const STAGED_NAME_STATUS = ["M\tREADME.md", "A\textensions/review-mode/index.ts"].join("\n");
const RENAME_NAME_STATUS = ["M\tREADME.md", "R100\told.ts\tnew.ts"].join("\n");
const LOCAL_NAME_STATUS = "M\tREADME.md";
const LOCAL_UNTRACKED = "notes.txt\n";
const STAGED_PATCH = [
	"diff --git a/README.md b/README.md",
	"index 1111111..2222222 100644",
	"--- a/README.md",
	"+++ b/README.md",
	"@@ -1 +1 @@",
	"-old",
	"+new",
	"@@ -10,2 +10,3 @@",
	" line",
	"-old detail",
	"+new detail",
	"+extra",
	"diff --git a/extensions/review-mode/index.ts b/extensions/review-mode/index.ts",
	"new file mode 100644",
	"--- /dev/null",
	"+++ b/extensions/review-mode/index.ts",
	"@@ -0,0 +1,10 @@",
	"+export {}",
	"+const reviewMode = true",
	"+const scope = 'all'",
	"+const lines = []",
	"+lines.push(scope)",
	"+lines.push('review')",
	"+void reviewMode",
	"+void lines",
	"+void scope",
	"+console.log('x')",
].join("\n");
const UNSTAGED_PATCH = [
	"diff --git a/src/app.ts b/src/app.ts",
	"index 1111111..3333333 100644",
	"--- a/src/app.ts",
	"+++ b/src/app.ts",
	"@@ -3 +3 @@",
	"-return oldValue",
	"+return newValue",
].join("\n");
const LOCAL_TRACKED_PATCH = [
	"diff --git a/README.md b/README.md",
	"index 1111111..4444444 100644",
	"--- a/README.md",
	"+++ b/README.md",
	"@@ -1 +1 @@",
	"-before",
	"+after",
].join("\n");
const LOCAL_UNTRACKED_PATCH = [
	"diff --git a/notes.txt b/notes.txt",
	"new file mode 100644",
	"index 0000000..5555555",
	"--- /dev/null",
	"+++ b/notes.txt",
	"@@ -0,0 +1 @@",
	"+draft note",
].join("\n");
const OUTGOING_PATCH = [
	"diff --git a/src/review.ts b/src/review.ts",
	"index 7777777..8888888 100644",
	"--- a/src/review.ts",
	"+++ b/src/review.ts",
	"@@ -5 +5 @@",
	"-return false",
	"+return true",
].join("\n");
function buildSemanticFiles(files: any[], fileDiffs: any[]) {
	return files.map((file: any) => {
		const fileDiff = fileDiffs.find((candidate: any) => candidate.path === file.path);
		return {
			path: file.path,
			summary: `This file changes ${file.path} so the current goal can use the updated behavior.`,
			hunks: (fileDiff?.hunks ?? []).map((hunk: any) => ({
				index: hunk.index,
				text: `This change enables the goal through hunk ${hunk.index} in ${file.path}.`,
			})),
		};
	});
}

function createSemanticAnalyzerStub(calls?: unknown[]) {
	return async (input: any) => {
		calls?.push(input);
		return buildSemanticFiles(input.files, input.fileDiffs);
	};
}

function reviewModeExtension(pi: any, options?: { analyzeSemanticReview?: any }) {
	return registerReviewModeExtension(pi, {
		analyzeSemanticReview: options?.analyzeSemanticReview ?? createSemanticAnalyzerStub(),
	});
}

const TABBED_PATCH = [
	"diff --git a/src/tabbed.ts b/src/tabbed.ts",
	"new file mode 100644",
	"--- /dev/null",
	"+++ b/src/tabbed.ts",
	"@@ -0,0 +1,3 @@",
	"+export function tabbed() {",
	"+\treturn true;",
	"+}",
].join("\n");

test("parseReviewModeArgs defaults to local and supports explicit source flags", () => {
	assert.deepEqual(parseReviewModeArgs(""), { source: "local", help: false });
	assert.deepEqual(parseReviewModeArgs("--local"), { source: "local", help: false });
	assert.deepEqual(parseReviewModeArgs("--staged"), { source: "staged", help: false });
	assert.deepEqual(parseReviewModeArgs("--unstaged"), { source: "unstaged", help: false });
	assert.deepEqual(parseReviewModeArgs("--outgoing"), { source: "outgoing", help: false });
	assert.deepEqual(parseReviewModeArgs("help"), { source: "local", help: true });
	assert.deepEqual(parseReviewModeArgs("--staged --outgoing"), {
		source: "staged",
		help: false,
		error: "Conflicting review-mode flags: --staged and --outgoing",
	});
});

test("parseGitNameStatusOutput keeps rename metadata and formats labels", () => {
	const parsed = parseGitNameStatusOutput(RENAME_NAME_STATUS);
	assert.deepEqual(parsed, [
		{ statusCode: "M", status: "M", path: "README.md" },
		{ statusCode: "R100", status: "R", previousPath: "old.ts", path: "new.ts" },
	]);
	assert.equal(formatReviewModeChange(parsed[1]!), "old.ts → new.ts");
});

test("parseReviewModeDiffFiles splits file patches into hunk entries", () => {
	const files = parseReviewModeDiffFiles(STAGED_PATCH);
	assert.equal(files.length, 2);
	assert.equal(files[0]?.path, "README.md");
	assert.equal(files[0]?.hunks.length, 2);
	assert.equal(files[0]?.hunks[1]?.heading, "@@ -10,2 +10,3 @@");
	assert.match(files[0]?.hunks[1]?.text ?? "", /\+extra/);
	assert.equal(files[1]?.path, "extensions/review-mode/index.ts");
	assert.equal(files[1]?.hunks.length, 1);
});

test("truncateReviewDiff caps long diffs and buildReviewModeInjectionPrompt reports hunk scope", () => {
	const longDiff = Array.from({ length: 800 }, (_, index) => `line-${index}-${"x".repeat(30)}`).join("\n");
	const truncated = truncateReviewDiff(longDiff, { maxLines: 3, maxChars: 18 });
	assert.equal(truncated.truncated, true);
	assert.equal(truncated.outputLines, 0);

	const prompt = buildReviewModeInjectionPrompt({
		source: "staged",
		scope: { kind: "hunk", filePath: "README.md", hunkIndex: 1, heading: "@@ -10,2 +10,3 @@" },
		files: parseGitNameStatusOutput(STAGED_NAME_STATUS),
		diff: longDiff,
	});
	assert.match(prompt, /Review mode scoped diff context:/);
	assert.match(prompt, /Selected hunk: README\.md :: @@ -10,2 \+10,3 @@/);
	assert.match(prompt, /Answer ONLY about the selected scope/);
	assert.match(prompt, /Keep the answer concise: aim for 2-5 short lines/);
	assert.match(prompt, /truncated/);
	assert.match(prompt, /README\.md/);
});


test("semantic review parsing requires one concise explanation per expected hunk", () => {
	const parsed = parseSemanticReviewResponse(
		JSON.stringify({
			summary: "This file exposes review context so the workbench can present it immediately.",
			hunks: [
				{ index: 0, text: "This change stores the context needed by the semantic pane." },
				{ index: 1, text: "This change renders the stored context beside its diff." },
			],
		}),
		"README.md",
		2,
	);
	assert.equal(parsed.hunks.length, 2);
	assert.throws(
		() => parseSemanticReviewResponse('{"summary":"Incomplete","hunks":[{"index":0,"text":"Only one"}]}', "README.md", 2),
		/covered 1\/2 hunks/,
	);
});

test("review goal context keeps recent substantive user requests", () => {
	const context = buildReviewModeGoalContext([
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "Build semantic review comments." }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Working on it." }] } },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "/review-mode" }] } },
	]);
	assert.equal(context, "Build semantic review comments.");
});

test("styleReviewDiffLine colors added, removed, and hunk metadata", () => {
	const theme = createTaggedTheme();
	assert.match(styleReviewDiffLine(theme, "+added line"), /toolDiffAdded/);
	assert.match(styleReviewDiffLine(theme, "-removed line"), /toolDiffRemoved/);
	assert.match(styleReviewDiffLine(theme, "@@ -1 +1 @@"), /<accent><bold>@@ -1 \+1 @@<\/bold><\/accent>/);
	assert.match(styleReviewDiffLine(theme, "diff --git a/a.ts b/a.ts"), /<accent><bold>diff --git/);
	assert.match(styleReviewDiffLine(theme, " context"), /toolDiffContext/);
});

test("ReviewModeWorkbench expands tabs so rendered lines stay within width", () => {
	const component = new ReviewModeWorkbench(createTheme(), {
		cwd: "/repo",
		source: "staged",
		files: parseGitNameStatusOutput("A\tsrc/tabbed.ts"),
		fileDiffs: parseReviewModeDiffFiles(TABBED_PATCH),
		fullDiff: TABBED_PATCH,
		initialNotes: [],
		requestRender() {},
		onAsk() {},
		onSaveNote() {
			return { source: "staged" as const, scope: { kind: "all" as const }, note: "", createdAt: 1, fileCount: 1 };
		},
		onClose() {},
	});

	for (const line of component.render(120)) {
		assert.ok(visibleWidth(line) <= 120, `Rendered line exceeds width 120: ${JSON.stringify(line)}`);
	}
});

test("ReviewModeWorkbench gives added and removed lines soft diff backgrounds like the open-file diff view", () => {
	const component = new ReviewModeWorkbench(createAnsiBgTheme(), {
		cwd: "/repo",
		source: "staged",
		files: parseGitNameStatusOutput(STAGED_NAME_STATUS),
		fileDiffs: parseReviewModeDiffFiles(STAGED_PATCH),
		fullDiff: STAGED_PATCH,
		initialNotes: [],
		requestRender() {},
		onAsk() {},
		onSaveNote() {
			return { source: "staged" as const, scope: { kind: "all" as const }, note: "", createdAt: 1, fileCount: 2 };
		},
		onClose() {},
	});

	const render = component.render(180).join("\n");
	assert.match(render, /-\u001b\[48;5;52m old\u001b\[49m/);
	assert.match(render, /\+\u001b\[48;5;22m new\u001b\[49m/);
});

test("ReviewModeWorkbench frames the modal and lets the composer scroll long answers", () => {
	const component = new ReviewModeWorkbench(createTheme(), {
		cwd: "/repo",
		source: "staged",
		files: parseGitNameStatusOutput(STAGED_NAME_STATUS),
		fileDiffs: parseReviewModeDiffFiles(STAGED_PATCH),
		fullDiff: STAGED_PATCH,
		initialNotes: [],
		requestRender() {},
		onAsk() {},
		onSaveNote() {
			return { source: "staged" as const, scope: { kind: "all" as const }, note: "", createdAt: 1, fileCount: 2 };
		},
		onClose() {},
	});

	const initial = component.render(180);
	assert.match(initial[0] ?? "", /^╭ Review Mode/);
	assert.match(initial.at(-1) ?? "", /^╰ /);

	component.startQuestion({ kind: "file", filePath: "README.md" }, "What does this enable?");
	component.finishAnswer(Array.from({ length: 40 }, (_value, index) => `answer line ${index + 1}`).join("\n"));
	const bottomAligned = component.render(180).join("\n");
	assert.doesNotMatch(bottomAligned, /answer line 1(?!\d)/);
	assert.match(bottomAligned, /answer line 40/);

	for (let i = 0; i < 40; i++) {
		component.handleInput("K");
	}
	const scrolledUp = component.render(180).join("\n");
	assert.match(scrolledUp, /answer line 1(?!\d)/);
	assert.match(scrolledUp, /Semantic Goal Context · 1-/);
});

test("ReviewModeWorkbench keeps explicit code-pane scrolling instead of snapping back to the cursor", () => {
	const longPatch = [
		"diff --git a/src/long.ts b/src/long.ts",
		"new file mode 100644",
		"--- /dev/null",
		"+++ b/src/long.ts",
		"@@ -0,0 +1,80 @@",
		...Array.from({ length: 80 }, (_value, index) => `+export const value${index + 1} = ${index + 1};`),
	].join("\n");
	const files = parseGitNameStatusOutput("A\tsrc/long.ts");
	const fileDiffs = parseReviewModeDiffFiles(longPatch);
	const component = new ReviewModeWorkbench(createTheme(), {
		cwd: "/repo",
		source: "staged",
		files,
		fileDiffs,
		fullDiff: longPatch,
		initialNotes: [],
		semanticFiles: buildSemanticFiles(files, fileDiffs),
		requestRender() {},
		onAsk() {},
		onSaveNote() {
			return { source: "staged" as const, scope: { kind: "all" as const }, note: "", createdAt: 1, fileCount: 1 };
		},
		onClose() {},
	});

	component.focusContent();
	const initial = component.render(120).join("\n");
	assert.match(initial, /value1 = 1/);

	component.handleInput("\u0004");
	const scrolled = component.render(120).join("\n");
	assert.doesNotMatch(scrolled, /value1 = 1/);
	assert.match(scrolled, /value(?:3[0-9]|4[0-9]) =/);
});

test("ReviewModeWorkbench supports vim-style navigation shortcuts", () => {
	const results: unknown[] = [];
	const component = new ReviewModeWorkbench(createTheme(), {
		cwd: "/repo",
		source: "staged",
		files: parseGitNameStatusOutput(STAGED_NAME_STATUS),
		fileDiffs: parseReviewModeDiffFiles(STAGED_PATCH),
		fullDiff: STAGED_PATCH,
		initialNotes: [],
		requestRender() {},
		onAsk(scope, text) {
			results.push({ action: "ask", scope, text });
		},
		onSaveNote() {
			return { source: "staged" as const, scope: { kind: "all" as const }, note: "", createdAt: 1, fileCount: 2 };
		},
		onClose() {},
	});

	assert.equal(component.getSelectedChange()?.path, "README.md");
	component.handleInput("j");
	assert.equal(component.getSelectedChange()?.path, "extensions/review-mode/index.ts");
	component.handleInput("k");
	assert.equal(component.getSelectedChange()?.path, "README.md");

	component.handleInput("\t");
	component.replaceDraft("Give me the big picture");
	assert.equal(component.submitDraft(), true);
	assert.deepEqual(results[0], {
		action: "ask",
		scope: { kind: "all" },
		text: "Give me the big picture",
	});
	component.finishAnswer("All set");

	component.handleInput("\u001b");
	component.handleInput("\r");
	component.handleInput("j");
	component.handleInput("B");
	component.handleInput("j");
	assert.match(component.render(180).join("\n"), /VISUAL 6-7/);
	component.handleInput("\r");
	component.replaceDraft("Explain these lines");
	assert.equal(component.submitDraft(), true);
	assert.deepEqual(results[1], {
		action: "ask",
		scope: {
			kind: "selection",
			filePath: "README.md",
			startLine: 6,
			endLine: 7,
			rawStartLine: 6,
			rawEndLine: 7,
		},
		text: "Explain these lines",
	});
});

test("ReviewModeWorkbench bounds invalid render widths instead of allocating unbounded strings", () => {
	const component = new ReviewModeWorkbench(createTheme(), {
		cwd: "/repo",
		source: "staged",
		files: parseGitNameStatusOutput(STAGED_NAME_STATUS),
		fileDiffs: parseReviewModeDiffFiles(STAGED_PATCH),
		fullDiff: STAGED_PATCH,
		initialNotes: [],
		requestRender() {},
		onAsk() {},
		onSaveNote() {
			return { source: "staged" as const, scope: { kind: "all" as const }, note: "", createdAt: 1, fileCount: 2 };
		},
		onClose() {},
	});

	assert.doesNotThrow(() => component.render(Number.POSITIVE_INFINITY));
	assert.doesNotThrow(() => component.render(Number.MAX_SAFE_INTEGER));
});

test("ReviewModeWorkbench renders thin file navigation beside equal code and semantic columns", () => {
	const files = parseGitNameStatusOutput(STAGED_NAME_STATUS);
	const fileDiffs = parseReviewModeDiffFiles(STAGED_PATCH);
	const component = new ReviewModeWorkbench(createTheme(), {
		cwd: "/repo",
		source: "staged",
		files,
		fileDiffs,
		fullDiff: STAGED_PATCH,
		initialNotes: [],
		semanticFiles: buildSemanticFiles(files, fileDiffs),
		requestRender() {},
		onAsk() {},
		onSaveNote() {
			return { source: "staged" as const, scope: { kind: "all" as const }, note: "", createdAt: 1, fileCount: 2 };
		},
		onClose() {},
	});

	const render = component.render(180);
	const paneHeader = render.find((line) => line.includes("Changed Files") && line.includes("Code Changes"));
	assert.ok(paneHeader);
	assert.match(paneHeader, /Semantic Goal Context/);
	const fileColumnEnd = paneHeader.indexOf("╮ ╭ Code Changes");
	const codeColumnStart = paneHeader.indexOf("╭ Code Changes");
	const semanticColumnStart = paneHeader.indexOf("╭ Semantic Goal Context");
	assert.ok(fileColumnEnd > 0 && codeColumnStart > 0 && semanticColumnStart > codeColumnStart);
	const fileWidth = fileColumnEnd + 1;
	const codeWidth = semanticColumnStart - codeColumnStart - 1;
	const semanticWidth = visibleWidth(paneHeader) - semanticColumnStart;
	assert.ok(fileWidth < codeWidth, `expected thin file column, got ${fileWidth} vs ${codeWidth}`);
	assert.ok(Math.abs(codeWidth - semanticWidth) <= 1, `expected equal main columns, got ${codeWidth} vs ${semanticWidth}`);
	assert.match(render.join("\n"), /This file changes README\.md/);
});

test("ReviewModeWorkbench requests concise semantic context for the selected hunk", () => {
	const results: Array<{ scope: unknown; text: string }> = [];
	const component = new ReviewModeWorkbench(createTheme(), {
		cwd: "/repo",
		source: "staged",
		files: parseGitNameStatusOutput(STAGED_NAME_STATUS),
		fileDiffs: parseReviewModeDiffFiles(STAGED_PATCH),
		fullDiff: STAGED_PATCH,
		initialNotes: [],
		requestRender() {},
		onAsk(scope, text) {
			results.push({ scope, text });
		},
		onSaveNote() {
			return { source: "staged" as const, scope: { kind: "all" as const }, note: "", createdAt: 1, fileCount: 2 };
		},
		onClose() {},
	});

	component.handleInput("\r");
	component.handleInput("e");

	assert.equal(results.length, 1);
	assert.deepEqual(results[0]?.scope, {
		kind: "hunk",
		filePath: "README.md",
		hunkIndex: 0,
		heading: "@@ -1 +1 @@",
	});
	assert.match(results[0]?.text ?? "", /advances the current goal/);
	assert.match(results[0]?.text ?? "", /what it enables/);
});

test("ReviewModeWorkbench supports file, selection, and all-change review flows", () => {
	const results: unknown[] = [];
	const files = parseGitNameStatusOutput(STAGED_NAME_STATUS);
	const fileDiffs = parseReviewModeDiffFiles(STAGED_PATCH);
	const component = new ReviewModeWorkbench(createTheme(), {
		cwd: "/repo",
		source: "staged",
		files,
		fileDiffs,
		fullDiff: STAGED_PATCH,
		initialNotes: [],
		semanticFiles: buildSemanticFiles(files, fileDiffs),
		requestRender() {},
		onAsk(scope, text) {
			results.push({ action: "ask", scope, text });
		},
		onSaveNote(scope, text) {
			const note = { source: "staged" as const, scope, note: text, createdAt: 1, fileCount: 2 };
			results.push({ action: "note", scope, text });
			return note;
		},
		onClose() {},
	});

	const initialRender = component.render(180).join("\n");
	assert.match(initialRender, /Changed Files \(2\)/);
	assert.doesNotMatch(initialRender, /Changed Regions/);
	assert.match(initialRender, /Code Changes · README\.md/);
	assert.match(initialRender, /Semantic Goal Context/);
	assert.match(initialRender, /This file changes README\.md/);
	assert.match(initialRender, /Tab ask all/);
	assert.match(initialRender, /↑↓\/j\/k select file/);
	assert.match(initialRender, /- old/);

	component.focusContent();
	component.setSelectedHunkIndex(1);
	component.startVisualSelection();
	component.moveContentLine(4);
	const visualRender = component.render(180).join("\n");
	assert.match(visualRender, /VISUAL 8-12/);
	assert.match(visualRender, /▌/);
	component.beginInputMode("ask");
	component.replaceDraft("What changed in this selection?");
	assert.equal(component.submitDraft(), true);
	assert.deepEqual(results[0], {
		action: "ask",
		scope: {
			kind: "selection",
			filePath: "README.md",
			startLine: 8,
			endLine: 12,
			rawStartLine: 8,
			rawEndLine: 12,
		},
		text: "What changed in this selection?",
	});

	component.updateAnswer("Scoped interim answer");
	component.finishAnswer("Scoped final answer");
	assert.match(component.render(180).join("\n"), /Scoped final answer/);

	component.focusFiles();
	component.handleInput("A");
	component.replaceDraft("Give me the big picture");
	assert.equal(component.submitDraft(), true);
	assert.deepEqual(results[1], {
		action: "ask",
		scope: { kind: "all" },
		text: "Give me the big picture",
	});

	component.moveSelection(1);
	component.focusContent();
	assert.match(component.render(180).join("\n"), /console\.log\('x'\)/);

	component.beginInputMode("note", { kind: "all" });
	component.replaceDraft("Need one more review pass");
	assert.equal(component.submitDraft(), true);
	assert.deepEqual(results[2], {
		action: "note",
		scope: { kind: "all" },
		text: "Need one more review pass",
	});
});

test("/review-mode generates, persists, and immediately renders semantic explanations", async () => {
	const calls: unknown[] = [];
	const harness = createPiHarness([
		{ code: 0, stdout: STAGED_NAME_STATUS, stderr: "" },
		{ code: 0, stdout: STAGED_PATCH, stderr: "" },
	]);
	reviewModeExtension(harness.pi as any, { analyzeSemanticReview: createSemanticAnalyzerStub(calls) });
	const context = createContext({
		entries: [
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "Populate semantic explanations for every review change." }] },
			},
		],
	});
	const command = harness.commands.get("review-mode");
	assert.ok(command);

	await command.handler("--staged", context.ctx as any);

	assert.equal(calls.length, 1);
	assert.match((calls[0] as any).goalContext, /Populate semantic explanations/);
	assert.equal(harness.appendEntries.length, 1);
	assert.equal(harness.appendEntries[0]?.customType, "review-mode-semantic-context");
	assert.match(context.customRenders[0]?.join("\n") ?? "", /This file changes README\.md/);
});

test("/review-mode reuses a persisted semantic snapshot for an unchanged diff", async () => {
	const files = parseGitNameStatusOutput(STAGED_NAME_STATUS);
	const fileDiffs = parseReviewModeDiffFiles(STAGED_PATCH);
	const snapshot = {
		source: "staged" as const,
		diffHash: buildReviewModeDiffHash("staged", files, STAGED_PATCH),
		goalContext: "Persist explanations for this review.",
		files: buildSemanticFiles(files, fileDiffs),
		createdAt: 1,
	};
	const harness = createPiHarness([
		{ code: 0, stdout: STAGED_NAME_STATUS, stderr: "" },
		{ code: 0, stdout: STAGED_PATCH, stderr: "" },
	]);
	reviewModeExtension(harness.pi as any, {
		analyzeSemanticReview: async () => {
			throw new Error("analyzer should not run");
		},
	});
	const context = createContext({
		entries: [{ type: "custom", customType: "review-mode-semantic-context", data: snapshot }],
	});
	const command = harness.commands.get("review-mode");
	assert.ok(command);

	await command.handler("--staged", context.ctx as any);

	assert.equal(harness.appendEntries.length, 0);
	assert.match(context.customRenders[0]?.join("\n") ?? "", /This file changes README\.md/);
});

test("/review-mode defaults to all local changes including untracked files", async () => {
	const harness = createPiHarness([
		{ code: 0, stdout: LOCAL_NAME_STATUS, stderr: "" },
		{ code: 0, stdout: LOCAL_UNTRACKED, stderr: "" },
		{ code: 0, stdout: LOCAL_TRACKED_PATCH, stderr: "" },
		{ code: 1, stdout: LOCAL_UNTRACKED_PATCH, stderr: "" },
	]);
	reviewModeExtension(harness.pi as any);
	const context = createContext({
		simulateCustom(component) {
			component.beginInputMode("ask", { kind: "all" });
			component.replaceDraft("What changed locally?");
			component.submitDraft();
		},
	});
	const command = harness.commands.get("review-mode");
	assert.ok(command);

	await command.handler("", context.ctx as any);

	assert.equal(context.getWaitForIdleCalls(), 1);
	assert.equal(context.getCustomCalls(), 1);
	assert.equal(context.customOptions[0]?.overlay, true);
	assert.equal(context.customOptions[0]?.overlayOptions?.anchor, "center");
	assert.deepEqual(harness.execCalls, [
		{
			command: "git",
			args: ["-C", "/repo", "diff", "HEAD", "--name-status", "--find-renames", "--find-copies"],
		},
		{
			command: "git",
			args: ["-C", "/repo", "ls-files", "--others", "--exclude-standard"],
		},
		{
			command: "git",
			args: ["-C", "/repo", "diff", "HEAD", "--find-renames", "--find-copies"],
		},
		{
			command: "git",
			args: ["-C", "/repo", "diff", "--no-index", "/dev/null", "notes.txt"],
		},
	]);
	assert.deepEqual(harness.sendUserMessages, [{ content: "What changed locally?", options: undefined }]);
	assert.match(context.customRenders[0]!.join("\n"), /notes\.txt/);
	assert.deepEqual(context.notifications.at(-1), {
		message: "Asked review question about all 2 local changes.",
		level: "info",
	});

	const beforeAgentStart = harness.eventHandlers.get("before_agent_start");
	assert.ok(beforeAgentStart);
	const injected = await beforeAgentStart(
		{ prompt: "What changed locally?", systemPrompt: "BASE" },
		{ sessionManager: { getSessionId: () => "session-1" } } as any,
	);
	assert.match(injected.systemPrompt, /Selected scope: all 2 local changes/);
	assert.match(injected.systemPrompt, /README\.md/);
	assert.match(injected.systemPrompt, /notes\.txt/);
	assert.match(injected.systemPrompt, /\+draft note/);
});

test("/review-mode --staged asks about a visual selection and injects only that snippet", async () => {
	const harness = createPiHarness([
		{ code: 0, stdout: STAGED_NAME_STATUS, stderr: "" },
		{ code: 0, stdout: STAGED_PATCH, stderr: "" },
	]);
	reviewModeExtension(harness.pi as any);
	const context = createContext({
		simulateCustom(component) {
			component.focusContent();
			component.setSelectedHunkIndex(1);
			component.startVisualSelection();
			component.moveContentLine(4);
			component.beginInputMode("ask");
			component.replaceDraft("What changed in this selection?");
			component.submitDraft();
		},
	});
	const command = harness.commands.get("review-mode");
	assert.ok(command);

	await command.handler("--staged", context.ctx as any);

	assert.deepEqual(harness.execCalls, [
		{
			command: "git",
			args: ["-C", "/repo", "diff", "--cached", "--name-status", "--find-renames", "--find-copies"],
		},
		{
			command: "git",
			args: ["-C", "/repo", "diff", "--cached", "--find-renames", "--find-copies"],
		},
	]);
	assert.deepEqual(harness.sendUserMessages, [{ content: "What changed in this selection?", options: undefined }]);
	assert.deepEqual(context.notifications.at(-1), {
		message: "Asked review question about README.md :: selected lines 8-12.",
		level: "info",
	});

	const beforeAgentStart = harness.eventHandlers.get("before_agent_start");
	assert.ok(beforeAgentStart);
	const injected = await beforeAgentStart(
		{ prompt: "What changed in this selection?", systemPrompt: "BASE" },
		{ sessionManager: { getSessionId: () => "session-1" } } as any,
	);
	assert.match(injected.systemPrompt, /Selected snippet: README\.md :: selected lines 8-12/);
	assert.match(injected.systemPrompt, /\+extra/);
	assert.doesNotMatch(injected.systemPrompt, /-old\n\+new/);
});

test("/review-mode --unstaged reviews tracked working tree changes", async () => {
	const harness = createPiHarness([
		{ code: 0, stdout: "M\tsrc/app.ts", stderr: "" },
		{ code: 0, stdout: UNSTAGED_PATCH, stderr: "" },
	]);
	reviewModeExtension(harness.pi as any);
	const context = createContext({
		simulateCustom(component) {
			component.beginInputMode("ask");
			component.replaceDraft("What changed in app.ts?");
			component.submitDraft();
		},
	});
	const command = harness.commands.get("review-mode");
	assert.ok(command);

	await command.handler("--unstaged", context.ctx as any);

	assert.deepEqual(harness.execCalls, [
		{
			command: "git",
			args: ["-C", "/repo", "diff", "--name-status", "--find-renames", "--find-copies"],
		},
		{
			command: "git",
			args: ["-C", "/repo", "diff", "--find-renames", "--find-copies"],
		},
	]);
	assert.deepEqual(context.notifications.at(-1), {
		message: "Asked review question about src/app.ts.",
		level: "info",
	});

	const beforeAgentStart = harness.eventHandlers.get("before_agent_start");
	assert.ok(beforeAgentStart);
	const injected = await beforeAgentStart(
		{ prompt: "What changed in app.ts?", systemPrompt: "BASE" },
		{ sessionManager: { getSessionId: () => "session-1" } } as any,
	);
	assert.match(injected.systemPrompt, /Source: unstaged/);
	assert.match(injected.systemPrompt, /Selected file: src\/app\.ts/);
	assert.match(injected.systemPrompt, /\+return newValue/);
});

test("/review-mode --outgoing reviews commits ahead of upstream", async () => {
	const harness = createPiHarness([
		{ code: 0, stdout: "origin/main\n", stderr: "" },
		{ code: 0, stdout: "M\tsrc/review.ts", stderr: "" },
		{ code: 0, stdout: OUTGOING_PATCH, stderr: "" },
	]);
	reviewModeExtension(harness.pi as any);
	const context = createContext({
		simulateCustom(component) {
			component.beginInputMode("ask");
			component.replaceDraft("What would I push?");
			component.submitDraft();
		},
	});
	const command = harness.commands.get("review-mode");
	assert.ok(command);

	await command.handler("--outgoing", context.ctx as any);

	assert.deepEqual(harness.execCalls, [
		{
			command: "git",
			args: ["-C", "/repo", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
		},
		{
			command: "git",
			args: ["-C", "/repo", "diff", "origin/main...HEAD", "--name-status", "--find-renames", "--find-copies"],
		},
		{
			command: "git",
			args: ["-C", "/repo", "diff", "origin/main...HEAD", "--find-renames", "--find-copies"],
		},
	]);
	assert.deepEqual(context.notifications.at(-1), {
		message: "Asked review question about src/review.ts.",
		level: "info",
	});

	const beforeAgentStart = harness.eventHandlers.get("before_agent_start");
	assert.ok(beforeAgentStart);
	const injected = await beforeAgentStart(
		{ prompt: "What would I push?", systemPrompt: "BASE" },
		{ sessionManager: { getSessionId: () => "session-1" } } as any,
	);
	assert.match(injected.systemPrompt, /Source: outgoing/);
	assert.match(injected.systemPrompt, /Selected file: src\/review\.ts/);
	assert.match(injected.systemPrompt, /\+return true/);
});

test("/review-mode saves scoped notes and /review-notes lists them", async () => {
	const harness = createPiHarness([
		{ code: 0, stdout: STAGED_NAME_STATUS, stderr: "" },
		{ code: 0, stdout: STAGED_PATCH, stderr: "" },
	]);
	reviewModeExtension(harness.pi as any);
	const context = createContext({
		simulateCustom(component) {
			component.focusContent();
			component.setSelectedHunkIndex(1);
			component.startVisualSelection();
			component.moveContentLine(4);
			component.beginInputMode("note");
			component.replaceDraft("Double-check the added extra line");
			component.submitDraft();
		},
	});
	const reviewCommand = harness.commands.get("review-mode");
	assert.ok(reviewCommand);

	await reviewCommand.handler("--staged", context.ctx as any);

	assert.equal(harness.sendUserMessages.length, 0);
	assert.equal(harness.appendEntries.length, 2);
	assert.equal(harness.appendEntries[0]?.customType, "review-mode-semantic-context");
	const noteEntry = harness.appendEntries.find((entry) => entry.customType === "review-mode-note");
	assert.ok(noteEntry);
	assert.deepEqual(noteEntry.data, {
		source: "staged",
		scope: {
			kind: "selection",
			filePath: "README.md",
			startLine: 8,
			endLine: 12,
			rawStartLine: 8,
			rawEndLine: 12,
		},
		note: "Double-check the added extra line",
		createdAt: (noteEntry.data as any).createdAt,
		fileCount: 2,
	});
	assert.deepEqual(context.notifications.at(-1), {
		message: "Saved review note for README.md :: selected lines 8-12.",
		level: "info",
	});

	const createdAt = Date.parse("2026-04-17T12:00:00Z");
	const entries = [
		{
			type: "custom",
			customType: "review-mode-note",
			data: {
				source: "local",
				scope: { kind: "all" },
				note: "Run a final local review pass",
				createdAt,
				fileCount: 2,
			},
		},
		{
			type: "custom",
			customType: "review-mode-note",
			data: noteEntry.data,
		},
	];

	assert.match(formatReviewModeNotes(collectReviewModeNotes(entries as any)), /all 2 local changes/);
	assert.match(formatReviewModeNotes(collectReviewModeNotes(entries as any)), /README\.md :: selected lines 8-12/);

	const notesHarness = createPiHarness([]);
	reviewModeExtension(notesHarness.pi as any);
	const notesContext = createContext({ entries });
	const notesCommand = notesHarness.commands.get("review-notes");
	assert.ok(notesCommand);

	await notesCommand.handler("", notesContext.ctx as any);

	assert.match(notesContext.editorWrites[0] ?? "", /Review notes:/);
	assert.match(notesContext.editorWrites[0] ?? "", /Run a final local review pass/);
	assert.deepEqual(notesContext.notifications.at(-1), {
		message: "Loaded 2 review note(s).",
		level: "info",
	});
});

test("/review-mode reports when there are no changes for the selected source", async () => {
	const harness = createPiHarness([
		{ code: 0, stdout: "", stderr: "" },
		{ code: 0, stdout: "", stderr: "" },
	]);
	reviewModeExtension(harness.pi as any);
	const context = createContext();
	const command = harness.commands.get("review-mode");
	assert.ok(command);

	await command.handler("--unstaged", context.ctx as any);

	assert.equal(context.getCustomCalls(), 0);
	assert.deepEqual(context.notifications.at(-1), {
		message: "No unstaged changes to review.",
		level: "info",
	});
});

test("/review-mode writes help text for unsupported args", async () => {
	const harness = createPiHarness([]);
	reviewModeExtension(harness.pi as any);
	const context = createContext();
	const command = harness.commands.get("review-mode");
	assert.ok(command);

	await command.handler("--mystery", context.ctx as any);

	assert.equal(harness.execCalls.length, 0);
	assert.equal(context.editorWrites[0], buildReviewModeHelpText());
	assert.deepEqual(context.notifications.at(-1), {
		message: "Unsupported review-mode argument: --mystery",
		level: "error",
	});
});
