import { getLanguageFromPath, highlightCode, type ExtensionAPI, type ExtensionCommandContext, type Theme } from "@mariozechner/pi-coding-agent";
import { CURSOR_MARKER, Key, matchesKey, truncateToWidth, type Focusable, visibleWidth } from "@mariozechner/pi-tui";

export type ReviewModeSource = "local" | "staged" | "unstaged" | "outgoing";
export type ReviewModeInputMode = "browse" | "ask" | "note";
export type ReviewModeScopeMode = "hunk" | "file" | "all";

export interface ReviewModeFileChange {
	statusCode: string;
	status: string;
	path: string;
	previousPath?: string;
}

export interface ReviewModeHunk {
	index: number;
	heading: string;
	text: string;
}

export interface ReviewModeFileDiff {
	path: string;
	header: string;
	patch: string;
	hunks: ReviewModeHunk[];
}

export type ReviewModeScope =
	| { kind: "hunk"; filePath: string; hunkIndex: number; heading: string }
	| { kind: "file"; filePath: string }
	| { kind: "selection"; filePath: string; startLine: number; endLine: number; rawStartLine: number; rawEndLine: number }
	| { kind: "all" };

export interface ParsedReviewModeArgs {
	source: ReviewModeSource;
	help: boolean;
	error?: string;
}

export interface ReviewModeNoteEntry {
	source: ReviewModeSource;
	scope: ReviewModeScope;
	note: string;
	createdAt: number;
	fileCount: number;
}

export interface ReviewDiffTruncationResult {
	text: string;
	truncated: boolean;
	totalLines: number;
	outputLines: number;
	totalChars: number;
	outputChars: number;
}

export interface ReviewModeInjectionInput {
	source: ReviewModeSource;
	scope: ReviewModeScope;
	files: ReviewModeFileChange[];
	diff: string;
}

interface ReviewModeWorkbenchOptions {
	cwd: string;
	source: ReviewModeSource;
	files: ReviewModeFileChange[];
	fileDiffs: ReviewModeFileDiff[];
	fullDiff: string;
	initialNotes: ReviewModeNoteEntry[];
	requestRender: () => void;
	onAsk: (scope: ReviewModeScope, text: string) => void;
	onSaveNote: (scope: ReviewModeScope, text: string) => ReviewModeNoteEntry;
	onClose: () => void;
}

interface ReviewModeLoadedData {
	files: ReviewModeFileChange[];
	fullDiff: string;
	fileDiffs: ReviewModeFileDiff[];
}

interface PendingReviewQuestion {
	workbenchId: number;
	sessionId: string;
	prompt: string;
	injection: ReviewModeInjectionInput;
}

interface ActiveReviewQuestion {
	workbenchId: number;
	sessionId: string;
	prompt: string;
}

interface ActiveReviewWorkbenchRuntime {
	id: number;
	sessionId: string;
	workbench: ReviewModeWorkbench;
}

const REVIEW_MODE_NOTE_ENTRY_TYPE = "review-mode-note";
const REVIEW_DIFF_MAX_LINES = 400;
const REVIEW_DIFF_MAX_CHARS = 12_000;
const REVIEW_MODAL_WIDTH = "94%";
const REVIEW_MODAL_MAX_HEIGHT = "92%";
const REVIEW_MODAL_MIN_WIDTH = 110;
const WIDE_LAYOUT_MIN_WIDTH = 96;
const REVIEW_MODAL_HEIGHT_RATIO = 0.92;
const REVIEW_HEADER_LINES = 3;
const REVIEW_FILES_PANE_HEIGHT = 6;
const REVIEW_COMPOSER_PANE_HEIGHT = 8;

const REVIEW_MODE_HELP_TEXT = [
	"Usage:",
	"  /review-mode",
	"  /review-mode --local",
	"  /review-mode --staged",
	"  /review-mode --unstaged",
	"  /review-mode --outgoing",
	"  /review-notes",
	"",
	"Notes:",
	"- /review-mode defaults to all local changes: staged + unstaged + untracked.",
	"- --staged reviews what would be committed now.",
	"- --unstaged reviews tracked working-tree changes only.",
	"- --outgoing reviews commits ahead of the current upstream branch.",
	"- ↑/↓ or j/k in the files pane changes the selected file.",
	"- Enter opens the selected file in the code pane.",
	"- Tab from the files pane opens the composer for an all-changes question.",
	"- Shift+Enter (or 'A') also asks about all reviewed changes.",
	"- In the code pane, ↑/↓ jumps between hunks while j/k moves line by line.",
	"- Press 'v' or 'b' to start or end visual selection in the code pane.",
	"- In visual mode, ↑/↓ or j/k extends the selected snippet.",
	"- Enter asks about the current file or selected snippet and keeps the answer inside review mode.",
	"- Press 'n' to save a scoped review note/decision for this session.",
	"- Press 'J'/'K' to scroll the composer when answers or notes are taller than the pane.",
	"- Press Esc to move back one focus level or close the workbench.",
].join("\n");

export function buildReviewModeHelpText(): string {
	return REVIEW_MODE_HELP_TEXT;
}

export function parseReviewModeArgs(input: string): ParsedReviewModeArgs {
	const tokens = input.trim().length > 0 ? input.trim().split(/\s+/) : [];
	let source: ReviewModeSource = "local";
	let explicitSource: ReviewModeSource | undefined;

	for (const token of tokens) {
		switch (token) {
			case "help":
			case "--help":
				return { source, help: true };
			case "--local":
			case "--staged":
			case "--unstaged":
			case "--outgoing": {
				const nextSource = token.slice(2) as ReviewModeSource;
				if (explicitSource && explicitSource !== nextSource) {
					return {
						source,
						help: false,
						error: `Conflicting review-mode flags: --${explicitSource} and ${token}`,
					};
				}
				explicitSource = nextSource;
				source = nextSource;
				break;
			}
			default:
				return {
					source,
					help: false,
					error: `Unsupported review-mode argument: ${token}`,
				};
		}
	}

	return { source, help: false };
}

export function parseGitNameStatusOutput(output: string): ReviewModeFileChange[] {
	const changes: ReviewModeFileChange[] = [];

	for (const line of output.split(/\r?\n/)) {
		if (!line.trim()) continue;

		const parts = line.split("\t");
		const statusCode = parts[0]?.trim();
		if (!statusCode) continue;

		const status = statusCode[0] ?? statusCode;
		if ((status === "R" || status === "C") && parts.length >= 3) {
			changes.push({
				statusCode,
				status,
				previousPath: parts[1],
				path: parts[2],
			});
			continue;
		}

		if (parts.length >= 2) {
			changes.push({
				statusCode,
				status,
				path: parts[1],
			});
		}
	}

	return changes;
}

export function parseGitUntrackedOutput(output: string): ReviewModeFileChange[] {
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((path) => ({
			statusCode: "??",
			status: "?",
			path,
		}));
}

export function parseReviewModeDiffFiles(diff: string): ReviewModeFileDiff[] {
	if (!diff.trim()) return [];

	const sections: string[][] = [];
	let currentSection: string[] = [];

	for (const line of diff.split(/\r?\n/)) {
		if (line.startsWith("diff --git ")) {
			if (currentSection.length > 0) sections.push(currentSection);
			currentSection = [line];
			continue;
		}
		if (currentSection.length > 0) currentSection.push(line);
	}

	if (currentSection.length > 0) sections.push(currentSection);

	return sections
		.map((section) => parseReviewModeDiffSection(section))
		.filter((fileDiff): fileDiff is ReviewModeFileDiff => fileDiff !== undefined);
}

export function formatReviewModeChange(change: ReviewModeFileChange): string {
	if (change.previousPath) {
		return `${change.previousPath} → ${change.path}`;
	}
	return change.path;
}

export function formatReviewModeScope(
	scope: ReviewModeScope,
	fileCount?: number,
	source: ReviewModeSource = "local",
): string {
	switch (scope.kind) {
		case "hunk":
			return `${scope.filePath} :: ${scope.heading}`;
		case "file":
			return scope.filePath;
		case "selection":
			return `${scope.filePath} :: selected lines ${scope.startLine}-${scope.endLine}`;
		case "all": {
			const label = describeReviewSource(source);
			return typeof fileCount === "number" ? `all ${fileCount} ${label}` : `all ${label}`;
		}
	}
}

export function truncateReviewDiff(
	diff: string,
	options?: { maxLines?: number; maxChars?: number },
): ReviewDiffTruncationResult {
	const maxLines = options?.maxLines ?? REVIEW_DIFF_MAX_LINES;
	const maxChars = options?.maxChars ?? REVIEW_DIFF_MAX_CHARS;
	const lines = diff.split(/\r?\n/);
	const kept: string[] = [];
	let outputChars = 0;
	let truncated = false;

	for (const line of lines) {
		const nextChars = outputChars + line.length + (kept.length > 0 ? 1 : 0);
		if (kept.length >= maxLines || nextChars > maxChars) {
			truncated = true;
			break;
		}
		kept.push(line);
		outputChars = nextChars;
	}

	return {
		text: kept.join("\n"),
		truncated,
		totalLines: lines.length,
		outputLines: kept.length,
		totalChars: diff.length,
		outputChars,
	};
}

export function buildReviewModeInjectionPrompt(input: ReviewModeInjectionInput): string {
	const truncated = truncateReviewDiff(input.diff);
	const fileLines = input.files.map((file) => `- ${formatReviewModeChange(file)}`);
	const diffHeading = truncated.truncated
		? `Scoped diff excerpt (${truncated.outputLines}/${truncated.totalLines} lines, ${truncated.outputChars}/${truncated.totalChars} chars; truncated):`
		: "Scoped diff:";
	const diffText = truncated.text.trim().length > 0 ? truncated.text : "[No textual diff output returned for this scope.]";

	return [
		"Review mode scoped diff context:",
		`Source: ${input.source}`,
		buildScopeLine(input.scope, input.files.length, input.source),
		"You are answering from the in-session review workbench.",
		"Answer ONLY about the selected scope. Do not generalize to unrelated files or the whole branch unless the selected scope itself requires it.",
		"Keep the answer concise: aim for 2-5 short lines.",
		"If the question asks something broader than the selected scope, say that your answer is limited to the selected scope and explain only what the scoped diff supports.",
		"If the scoped diff is insufficient, say exactly what additional scope or context is needed.",
		"Review set files:",
		...(fileLines.length > 0 ? fileLines : ["- (none)"]),
		diffHeading,
		"```diff",
		diffText,
		"```",
	].join("\n");
}

export function collectReviewModeNotes(entries: any[]): ReviewModeNoteEntry[] {
	const notes: ReviewModeNoteEntry[] = [];

	for (const entry of entries) {
		if (!entry || entry.type !== "custom" || entry.customType !== REVIEW_MODE_NOTE_ENTRY_TYPE) continue;
		if (isReviewModeNoteEntry(entry.data)) notes.push(entry.data);
	}

	return notes.sort((left, right) => left.createdAt - right.createdAt);
}

export function formatReviewModeNotes(notes: ReviewModeNoteEntry[]): string {
	if (notes.length === 0) return "No review notes saved in this session.";

	const lines = ["Review notes:", ""];
	for (let i = 0; i < notes.length; i++) {
		const note = notes[i]!;
		lines.push(
			`${i + 1}. [${note.source}] ${formatReviewModeScope(note.scope, note.fileCount, note.source)} · ${new Date(note.createdAt).toISOString()}`,
		);
		lines.push(`   ${note.note}`);
		lines.push("");
	}

	return lines.join("\n").trimEnd();
}

function parseReviewModeDiffSection(section: string[]): ReviewModeFileDiff | undefined {
	const path = findPatchSectionPath(section);
	if (!path) return undefined;

	const headerLines: string[] = [];
	const hunks: ReviewModeHunk[] = [];
	let currentHunkLines: string[] | null = null;
	let currentHeading = "";

	for (const line of section) {
		if (line.startsWith("@@ ")) {
			if (currentHunkLines) {
				hunks.push({
					index: hunks.length,
					heading: currentHeading,
					text: currentHunkLines.join("\n"),
				});
			}
			currentHeading = line;
			currentHunkLines = [line];
			continue;
		}

		if (currentHunkLines) currentHunkLines.push(line);
		else headerLines.push(line);
	}

	if (currentHunkLines) {
		hunks.push({
			index: hunks.length,
			heading: currentHeading,
			text: currentHunkLines.join("\n"),
		});
	}

	return {
		path,
		header: headerLines.join("\n"),
		patch: section.join("\n"),
		hunks,
	};
}

function findPatchSectionPath(section: string[]): string | undefined {
	for (const line of section) {
		if (!line.startsWith("+++ ")) continue;
		const path = normalizePatchPath(line.slice(4));
		if (path) return path;
	}

	for (const line of section) {
		if (!line.startsWith("--- ")) continue;
		const path = normalizePatchPath(line.slice(4));
		if (path) return path;
	}

	const header = section[0];
	if (!header?.startsWith("diff --git ")) return undefined;
	const match = /^diff --git a\/(.+) b\/(.+)$/.exec(header);
	if (!match) return undefined;
	return normalizePatchPath(`b/${match[2]}`) ?? normalizePatchPath(`a/${match[1]}`);
}

function normalizePatchPath(rawPath: string): string | undefined {
	const trimmed = rawPath.trim();
	if (!trimmed || trimmed === "/dev/null") return undefined;
	if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) return trimmed.slice(2);
	return trimmed;
}

function buildScopeLine(scope: ReviewModeScope, fileCount: number, source: ReviewModeSource): string {
	switch (scope.kind) {
		case "hunk":
			return `Selected hunk: ${scope.filePath} :: ${scope.heading}`;
		case "file":
			return `Selected file: ${scope.filePath}`;
		case "selection":
			return `Selected snippet: ${formatReviewModeScope(scope, fileCount, source)}`;
		case "all":
			return `Selected scope: ${formatReviewModeScope(scope, fileCount, source)}`;
	}
}

function describeReviewSource(source: ReviewModeSource): string {
	switch (source) {
		case "local":
			return "local changes";
		case "staged":
			return "staged changes";
		case "unstaged":
			return "unstaged changes";
		case "outgoing":
			return "outgoing changes";
	}
}

function isReviewModeScope(value: unknown): value is ReviewModeScope {
	if (!value || typeof value !== "object") return false;
	const scope = value as {
		kind?: unknown;
		filePath?: unknown;
		hunkIndex?: unknown;
		heading?: unknown;
		startLine?: unknown;
		endLine?: unknown;
		rawStartLine?: unknown;
		rawEndLine?: unknown;
	};
	if (scope.kind === "all") return true;
	if (scope.kind === "file" && typeof scope.filePath === "string" && scope.filePath.length > 0) return true;
	if (
		scope.kind === "selection" &&
		typeof scope.filePath === "string" &&
		scope.filePath.length > 0 &&
		typeof scope.startLine === "number" &&
		typeof scope.endLine === "number" &&
		typeof scope.rawStartLine === "number" &&
		typeof scope.rawEndLine === "number"
	) {
		return true;
	}
	return (
		scope.kind === "hunk" &&
		typeof scope.filePath === "string" &&
		scope.filePath.length > 0 &&
		typeof scope.hunkIndex === "number" &&
		typeof scope.heading === "string" &&
		scope.heading.length > 0
	);
}

function isReviewModeNoteEntry(value: unknown): value is ReviewModeNoteEntry {
	if (!value || typeof value !== "object") return false;
	const note = value as {
		source?: unknown;
		scope?: unknown;
		note?: unknown;
		createdAt?: unknown;
		fileCount?: unknown;
	};
	return (
		(note.source === "local" || note.source === "staged" || note.source === "unstaged" || note.source === "outgoing") &&
		isReviewModeScope(note.scope) &&
		typeof note.note === "string" &&
		typeof note.createdAt === "number" &&
		typeof note.fileCount === "number"
	);
}

async function execGit(pi: ExtensionAPI, cwd: string, args: string[]) {
	return pi.exec("git", ["-C", cwd, ...args]);
}

function formatGitError(result: { stdout: string; stderr: string }, fallback: string): string {
	return result.stderr.trim() || result.stdout.trim() || fallback;
}

function isMissingHeadError(message: string): boolean {
	return /bad revision 'HEAD'|ambiguous argument 'HEAD'|unknown revision or path not in the working tree/i.test(message);
}

async function loadSimpleTrackedReviewModeData(
	pi: ExtensionAPI,
	cwd: string,
	source: ReviewModeSource,
	nameStatusArgs: string[],
	patchArgs: string[],
): Promise<{ ok: true; data: ReviewModeLoadedData } | { ok: false; error: string; level: "error" | "warning" }> {
	const nameStatusResult = await execGit(pi, cwd, nameStatusArgs);
	if (nameStatusResult.code !== 0) {
		const message = formatGitError(nameStatusResult, `Failed to load ${describeReviewSource(source)}.`);
		if (/not a git repository/i.test(message)) {
			return {
				ok: false,
				error: "Review mode is only available inside a git repository.",
				level: "error",
			};
		}
		return {
			ok: false,
			error: message,
			level: "error",
		};
	}

	const files = parseGitNameStatusOutput(nameStatusResult.stdout);
	if (files.length === 0) {
		return { ok: true, data: { files, fullDiff: "", fileDiffs: [] } };
	}

	const patchResult = await execGit(pi, cwd, patchArgs);
	if (patchResult.code !== 0) {
		return {
			ok: false,
			error: formatGitError(patchResult, `Failed to load ${describeReviewSource(source)} diff.`),
			level: "error",
		};
	}

	return {
		ok: true,
		data: {
			files,
			fullDiff: patchResult.stdout,
			fileDiffs: parseReviewModeDiffFiles(patchResult.stdout),
		},
	};
}

async function loadLocalReviewModeData(
	pi: ExtensionAPI,
	cwd: string,
): Promise<{ ok: true; data: ReviewModeLoadedData } | { ok: false; error: string; level: "error" | "warning" }> {
	const trackedNameStatus = await execGit(pi, cwd, ["diff", "HEAD", "--name-status", "--find-renames", "--find-copies"]);
	if (trackedNameStatus.code !== 0) {
		const message = formatGitError(trackedNameStatus, "Failed to load local changes.");
		if (isMissingHeadError(message)) {
			return {
				ok: false,
				error: "Local review needs an existing HEAD commit. In a brand-new repo, stage files first and use /review-mode --staged.",
				level: "error",
			};
		}
		if (/not a git repository/i.test(message)) {
			return {
				ok: false,
				error: "Review mode is only available inside a git repository.",
				level: "error",
			};
		}
		return { ok: false, error: message, level: "error" };
	}

	const untrackedResult = await execGit(pi, cwd, ["ls-files", "--others", "--exclude-standard"]);
	if (untrackedResult.code !== 0) {
		return {
			ok: false,
			error: formatGitError(untrackedResult, "Failed to list untracked files."),
			level: "error",
		};
	}

	const trackedFiles = parseGitNameStatusOutput(trackedNameStatus.stdout);
	const untrackedFiles = parseGitUntrackedOutput(untrackedResult.stdout);
	const files = [...trackedFiles, ...untrackedFiles];
	if (files.length === 0) {
		return { ok: true, data: { files, fullDiff: "", fileDiffs: [] } };
	}

	let trackedPatch = "";
	if (trackedFiles.length > 0) {
		const trackedPatchResult = await execGit(pi, cwd, ["diff", "HEAD", "--find-renames", "--find-copies"]);
		if (trackedPatchResult.code !== 0) {
			return {
				ok: false,
				error: formatGitError(trackedPatchResult, "Failed to load tracked local diff."),
				level: "error",
			};
		}
		trackedPatch = trackedPatchResult.stdout;
	}

	const untrackedPatches: string[] = [];
	for (const file of untrackedFiles) {
		const patchResult = await execGit(pi, cwd, ["diff", "--no-index", "/dev/null", file.path]);
		if (patchResult.code !== 0 && patchResult.code !== 1) {
			return {
				ok: false,
				error: formatGitError(patchResult, `Failed to build diff for untracked file ${file.path}.`),
				level: "error",
			};
		}
		if (patchResult.stdout.trim()) untrackedPatches.push(patchResult.stdout);
	}

	const fullDiff = [trackedPatch, ...untrackedPatches].filter((part) => part.trim().length > 0).join("\n");
	return {
		ok: true,
		data: {
			files,
			fullDiff,
			fileDiffs: parseReviewModeDiffFiles(fullDiff),
		},
	};
}

async function resolveUpstreamRef(
	pi: ExtensionAPI,
	cwd: string,
): Promise<{ ok: true; upstreamRef: string } | { ok: false; error: string; level: "error" | "warning" }> {
	const result = await execGit(pi, cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
	if (result.code !== 0) {
		return {
			ok: false,
			error: "Current branch has no upstream. Push with --set-upstream before using /review-mode --outgoing.",
			level: "error",
		};
	}

	return { ok: true, upstreamRef: result.stdout.trim() };
}

async function loadReviewModeData(
	pi: ExtensionAPI,
	cwd: string,
	source: ReviewModeSource,
): Promise<{ ok: true; data: ReviewModeLoadedData } | { ok: false; error: string; level: "error" | "warning" }> {
	switch (source) {
		case "local":
			return loadLocalReviewModeData(pi, cwd);
		case "staged":
			return loadSimpleTrackedReviewModeData(
				pi,
				cwd,
				source,
				["diff", "--cached", "--name-status", "--find-renames", "--find-copies"],
				["diff", "--cached", "--find-renames", "--find-copies"],
			);
		case "unstaged":
			return loadSimpleTrackedReviewModeData(
				pi,
				cwd,
				source,
				["diff", "--name-status", "--find-renames", "--find-copies"],
				["diff", "--find-renames", "--find-copies"],
			);
		case "outgoing": {
			const upstream = await resolveUpstreamRef(pi, cwd);
			if (!upstream.ok) return upstream;
			const range = `${upstream.upstreamRef}...HEAD`;
			return loadSimpleTrackedReviewModeData(
				pi,
				cwd,
				source,
				["diff", range, "--name-status", "--find-renames", "--find-copies"],
				["diff", range, "--find-renames", "--find-copies"],
			);
		}
	}
}

function findReviewModeFileDiff(fileDiffs: ReviewModeFileDiff[], filePath: string): ReviewModeFileDiff | undefined {
	return fileDiffs.find((fileDiff) => fileDiff.path === filePath);
}

function buildScopedReviewDiff(scope: ReviewModeScope, fullDiff: string, fileDiffs: ReviewModeFileDiff[]): string {
	switch (scope.kind) {
		case "all":
			return fullDiff;
		case "file":
			return findReviewModeFileDiff(fileDiffs, scope.filePath)?.patch ?? "";
		case "selection":
			return buildSelectionScopeDiff(scope, fileDiffs);
		case "hunk": {
			const fileDiff = findReviewModeFileDiff(fileDiffs, scope.filePath);
			const hunk = fileDiff?.hunks[scope.hunkIndex];
			if (!fileDiff || !hunk) return "";
			const header = fileDiff.header.trim();
			return header.length > 0 ? `${header}\n${hunk.text}` : hunk.text;
		}
	}
}

function extractAssistantText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const maybeMessage = message as { role?: unknown; content?: unknown };
	if (maybeMessage.role !== "assistant") return "";
	if (!Array.isArray(maybeMessage.content)) return "";
	return maybeMessage.content
		.filter((block): block is { type: string; text?: string } => !!block && typeof block === "object")
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("\n")
		.trim();
}

function extractLastAssistantText(messages: unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const text = extractAssistantText(messages[i]);
		if (text) return text;
	}
	return "";
}

function expandTabsForTui(text: string): string {
	return text.replace(/\t/g, "    ");
}

function padLine(content: string, innerWidth: number): string {
	const normalized = expandTabsForTui(content);
	const clipped = truncateToWidth(normalized, innerWidth);
	return clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
}

function renderCursorText(text: string, cursor: number, focused: boolean): string {
	const boundedCursor = Math.max(0, Math.min(cursor, text.length));
	const before = text.slice(0, boundedCursor);
	const currentChar = boundedCursor < text.length ? text[boundedCursor] : " ";
	const after = boundedCursor < text.length ? text.slice(boundedCursor + 1) : "";
	const marker = focused ? CURSOR_MARKER : "";
	return `${before}${marker}\x1b[7m${currentChar}\x1b[27m${after}`;
}

function createPaneLines(theme: Theme, title: string, content: string[], width: number, height: number): string[] {
	const safeWidth = Math.max(10, width);
	const innerWidth = safeWidth - 2;
	const visibleTitle = truncateToWidth(expandTabsForTui(` ${title} `), innerWidth);
	const topFill = "─".repeat(Math.max(0, innerWidth - visibleWidth(visibleTitle)));
	const lines = [
		theme.fg("border", "╭") + theme.fg("accent", visibleTitle) + theme.fg("border", `${topFill}╮`),
	];

	const contentRows = Math.max(0, height - 2);
	for (let i = 0; i < contentRows; i++) {
		lines.push(
			theme.fg("border", "│") +
				padLine(content[i] ?? "", innerWidth) +
				theme.fg("border", "│"),
		);
	}
	lines.push(theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
	return lines;
}

function createModalFrameLines(theme: Theme, title: string, content: string[], width: number, footer: string): string[] {
	const safeWidth = Math.max(10, width);
	const innerWidth = safeWidth - 2;
	const visibleTitle = truncateToWidth(` ${expandTabsForTui(title)} `, innerWidth);
	const titleFill = "─".repeat(Math.max(0, innerWidth - visibleWidth(visibleTitle)));
	const visibleFooter = truncateToWidth(` ${expandTabsForTui(footer)} `, innerWidth);
	const footerFill = "─".repeat(Math.max(0, innerWidth - visibleWidth(visibleFooter)));
	return [
		theme.fg("borderAccent", "╭") + visibleTitle + theme.fg("borderAccent", `${titleFill}╮`),
		...content.map((line) => theme.fg("borderAccent", "│") + padLine(line, innerWidth) + theme.fg("borderAccent", "│")),
		theme.fg("borderAccent", "╰") + visibleFooter + theme.fg("borderAccent", `${footerFill}╯`),
	];
}

function mergePaneColumns(columns: string[][]): string[] {
	const height = columns.reduce((max, pane) => Math.max(max, pane.length), 0);
	const merged: string[] = [];
	for (let row = 0; row < height; row++) {
		merged.push(columns.map((pane) => pane[row] ?? "").join(" "));
	}
	return merged;
}

function selectStatusColor(status: string): "success" | "warning" | "error" | "accent" | "muted" {
	if (status === "A") return "success";
	if (status === "D") return "error";
	if (status === "?") return "accent";
	if (status === "R" || status === "C" || status === "M") return "warning";
	return "muted";
}

function formatStatusBadge(theme: Theme, change: ReviewModeFileChange): string {
	return theme.fg(selectStatusColor(change.status), change.status.padEnd(2, " "));
}

export function styleReviewDiffLine(theme: Theme, line: string): string {
	if (line.startsWith("diff --git ")) return theme.fg("accent", theme.bold(line));
	if (line.startsWith("@@ ")) return theme.fg("accent", theme.bold(line));
	if (
		line.startsWith("index ") ||
		line.startsWith("--- ") ||
		line.startsWith("+++ ") ||
		line.startsWith("new file mode ") ||
		line.startsWith("deleted file mode ") ||
		line.startsWith("old mode ") ||
		line.startsWith("new mode ") ||
		line.startsWith("similarity index ") ||
		line.startsWith("rename from ") ||
		line.startsWith("rename to ")
	) {
		return theme.fg("dim", line);
	}
	if (line.startsWith("+") && !line.startsWith("+++ ")) return theme.fg("toolDiffAdded", line);
	if (line.startsWith("-") && !line.startsWith("--- ")) return theme.fg("toolDiffRemoved", line);
	return theme.fg("toolDiffContext", line);
}

function resolveDiffLineNumberWidth(diff: string): number {
	let oldLine: number | null = null;
	let newLine: number | null = null;
	let maxLineNumber = 0;

	for (const rawLine of diff.split(/\r?\n/)) {
		if (rawLine.startsWith("@@ ")) {
			const header = parseUnifiedDiffHeader(rawLine);
			oldLine = header?.oldStart ?? null;
			newLine = header?.newStart ?? null;
			continue;
		}
		if (rawLine.startsWith("+") && !rawLine.startsWith("+++ ")) {
			if (newLine != null) {
				maxLineNumber = Math.max(maxLineNumber, newLine);
				newLine += 1;
			}
			continue;
		}
		if (rawLine.startsWith("-") && !rawLine.startsWith("--- ")) {
			if (oldLine != null) {
				maxLineNumber = Math.max(maxLineNumber, oldLine);
				oldLine += 1;
			}
			continue;
		}
		if (rawLine.startsWith(" ")) {
			if (oldLine != null) {
				maxLineNumber = Math.max(maxLineNumber, oldLine);
				oldLine += 1;
			}
			if (newLine != null) {
				maxLineNumber = Math.max(maxLineNumber, newLine);
				newLine += 1;
			}
		}
	}

	return Math.max(1, String(maxLineNumber || 1).length);
}

function formatDiffLineNumber(theme: Theme, lineNumber: number | null, width: number): string {
	if (lineNumber == null) return theme.fg("dim", " ".repeat(width));
	return theme.fg("dim", String(lineNumber).padStart(width, " "));
}

function parseUnifiedDiffHeader(line: string): { oldStart: number; newStart: number } | null {
	const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
	if (!match) return null;
	return { oldStart: Number(match[1]), newStart: Number(match[2]) };
}

function highlightDiffCodeBody(theme: Theme, body: string, filePath: string | undefined): string {
	if (!filePath) return body;
	const language = getLanguageFromPath(filePath);
	if (!language) return body;
	const highlighted = highlightCode(body, language);
	return highlighted[0] ?? body;
}

function styleAddedDiffBody(theme: Theme, body: string): string {
	return theme.bg("toolSuccessBg", ` ${body}`);
}

function styleRemovedDiffBody(theme: Theme, body: string): string {
	return theme.bg("toolErrorBg", ` ${body}`);
}

function buildStyledScopedDiffLines(theme: Theme, diff: string): string[] {
	if (!diff.trim()) return [];

	const lineNumberWidth = resolveDiffLineNumberWidth(diff);
	const lines: string[] = [];
	let currentPath: string | undefined;
	let oldLine: number | null = null;
	let newLine: number | null = null;

	for (const rawLine of diff.split(/\r?\n/)) {
		if (rawLine.startsWith("diff --git ")) {
			const match = /^diff --git a\/(.+) b\/(.+)$/.exec(rawLine);
			currentPath = match?.[2] ?? currentPath;
			oldLine = null;
			newLine = null;
			lines.push(styleReviewDiffLine(theme, rawLine));
			continue;
		}

		if (rawLine.startsWith("+++ ")) {
			const normalized = normalizePatchPath(rawLine.slice(4));
			if (normalized) currentPath = normalized;
			lines.push(styleReviewDiffLine(theme, rawLine));
			continue;
		}

		if (rawLine.startsWith("@@ ")) {
			const header = parseUnifiedDiffHeader(rawLine);
			oldLine = header?.oldStart ?? null;
			newLine = header?.newStart ?? null;
			lines.push(styleReviewDiffLine(theme, rawLine));
			continue;
		}

		if (rawLine.startsWith("+") && !rawLine.startsWith("+++ ")) {
			const marker = theme.fg("toolDiffAdded", "+");
			const body = styleAddedDiffBody(theme, highlightDiffCodeBody(theme, rawLine.slice(1), currentPath));
			lines.push(`${formatDiffLineNumber(theme, null, lineNumberWidth)} ${formatDiffLineNumber(theme, newLine, lineNumberWidth)} ${marker}${body}`);
			newLine = newLine == null ? null : newLine + 1;
			continue;
		}

		if (rawLine.startsWith("-") && !rawLine.startsWith("--- ")) {
			const marker = theme.fg("toolDiffRemoved", "-");
			const body = styleRemovedDiffBody(theme, highlightDiffCodeBody(theme, rawLine.slice(1), currentPath));
			lines.push(`${formatDiffLineNumber(theme, oldLine, lineNumberWidth)} ${formatDiffLineNumber(theme, null, lineNumberWidth)} ${marker}${body}`);
			oldLine = oldLine == null ? null : oldLine + 1;
			continue;
		}

		if (rawLine.startsWith(" ")) {
			const marker = theme.fg("dim", "│");
			const body = highlightDiffCodeBody(theme, rawLine.slice(1), currentPath);
			lines.push(`${formatDiffLineNumber(theme, oldLine, lineNumberWidth)} ${formatDiffLineNumber(theme, newLine, lineNumberWidth)} ${marker} ${body}`);
			oldLine = oldLine == null ? null : oldLine + 1;
			newLine = newLine == null ? null : newLine + 1;
			continue;
		}

		lines.push(styleReviewDiffLine(theme, rawLine));
	}

	return lines;
}

type ReviewModeFocusArea = "files" | "content" | "composer";

interface ReviewDiffDisplayLine {
	text: string;
	rawLine: string;
	rawLineIndex: number;
	hunkIndex: number | null;
	isHunkHeader: boolean;
}

function buildDisplayedFileDiffLines(theme: Theme, fileDiff: ReviewModeFileDiff): ReviewDiffDisplayLine[] {
	const lineNumberWidth = resolveDiffLineNumberWidth(fileDiff.patch);
	const lines: ReviewDiffDisplayLine[] = [];
	let currentPath: string | undefined = fileDiff.path;
	let oldLine: number | null = null;
	let newLine: number | null = null;
	let currentHunkIndex: number | null = null;

	for (const [index, rawLine] of fileDiff.patch.split(/\r?\n/).entries()) {
		if (rawLine.startsWith("diff --git ")) {
			const match = /^diff --git a\/(.+) b\/(.+)$/.exec(rawLine);
			currentPath = match?.[2] ?? currentPath;
			oldLine = null;
			newLine = null;
			currentHunkIndex = null;
			lines.push({
				text: styleReviewDiffLine(theme, rawLine),
				rawLine,
				rawLineIndex: index + 1,
				hunkIndex: currentHunkIndex,
				isHunkHeader: false,
			});
			continue;
		}

		if (rawLine.startsWith("+++ ")) {
			const normalized = normalizePatchPath(rawLine.slice(4));
			if (normalized) currentPath = normalized;
			lines.push({
				text: styleReviewDiffLine(theme, rawLine),
				rawLine,
				rawLineIndex: index + 1,
				hunkIndex: currentHunkIndex,
				isHunkHeader: false,
			});
			continue;
		}

		if (rawLine.startsWith("@@ ")) {
			const header = parseUnifiedDiffHeader(rawLine);
			oldLine = header?.oldStart ?? null;
			newLine = header?.newStart ?? null;
			currentHunkIndex = currentHunkIndex == null ? 0 : currentHunkIndex + 1;
			lines.push({
				text: styleReviewDiffLine(theme, rawLine),
				rawLine,
				rawLineIndex: index + 1,
				hunkIndex: currentHunkIndex,
				isHunkHeader: true,
			});
			continue;
		}

		if (rawLine.startsWith("+") && !rawLine.startsWith("+++ ")) {
			const marker = theme.fg("toolDiffAdded", "+");
			const body = styleAddedDiffBody(theme, highlightDiffCodeBody(theme, rawLine.slice(1), currentPath));
			lines.push({
				text: `${formatDiffLineNumber(theme, null, lineNumberWidth)} ${formatDiffLineNumber(theme, newLine, lineNumberWidth)} ${marker}${body}`,
				rawLine,
				rawLineIndex: index + 1,
				hunkIndex: currentHunkIndex,
				isHunkHeader: false,
			});
			newLine = newLine == null ? null : newLine + 1;
			continue;
		}

		if (rawLine.startsWith("-") && !rawLine.startsWith("--- ")) {
			const marker = theme.fg("toolDiffRemoved", "-");
			const body = styleRemovedDiffBody(theme, highlightDiffCodeBody(theme, rawLine.slice(1), currentPath));
			lines.push({
				text: `${formatDiffLineNumber(theme, oldLine, lineNumberWidth)} ${formatDiffLineNumber(theme, null, lineNumberWidth)} ${marker}${body}`,
				rawLine,
				rawLineIndex: index + 1,
				hunkIndex: currentHunkIndex,
				isHunkHeader: false,
			});
			oldLine = oldLine == null ? null : oldLine + 1;
			continue;
		}

		if (rawLine.startsWith(" ")) {
			const marker = theme.fg("dim", "│");
			const body = highlightDiffCodeBody(theme, rawLine.slice(1), currentPath);
			lines.push({
				text: `${formatDiffLineNumber(theme, oldLine, lineNumberWidth)} ${formatDiffLineNumber(theme, newLine, lineNumberWidth)} ${marker} ${body}`,
				rawLine,
				rawLineIndex: index + 1,
				hunkIndex: currentHunkIndex,
				isHunkHeader: false,
			});
			oldLine = oldLine == null ? null : oldLine + 1;
			newLine = newLine == null ? null : newLine + 1;
			continue;
		}

		lines.push({
			text: styleReviewDiffLine(theme, rawLine),
			rawLine,
			rawLineIndex: index + 1,
			hunkIndex: currentHunkIndex,
			isHunkHeader: false,
		});
	}

	return lines;
}

function buildSelectionScopeDiff(scope: Extract<ReviewModeScope, { kind: "selection" }>, fileDiffs: ReviewModeFileDiff[]): string {
	const fileDiff = findReviewModeFileDiff(fileDiffs, scope.filePath);
	if (!fileDiff) return "";
	const patchLines = fileDiff.patch.split(/\r?\n/);
	const start = Math.max(0, Math.min(scope.rawStartLine, scope.rawEndLine) - 1);
	const end = Math.min(patchLines.length, Math.max(scope.rawStartLine, scope.rawEndLine));
	let contextualStart = start;
	while (contextualStart > 0 && !patchLines[contextualStart]!.startsWith("@@ ")) {
		contextualStart -= 1;
	}
	const snippet = patchLines.slice(contextualStart, end).join("\n").trim();
	if (!snippet) return fileDiff.header.trim();
	if (snippet.startsWith("diff --git ")) return snippet;
	const header = fileDiff.header.trim();
	return header ? `${header}\n${snippet}` : snippet;
}

function noteMatchesScope(note: ReviewModeNoteEntry, scope: ReviewModeScope, source: ReviewModeSource): boolean {
	if (note.source !== source) return false;
	if (scope.kind === "all") return note.scope.kind === "all";
	if (scope.kind === "file" || scope.kind === "selection") {
		return (
			(note.scope.kind === "file" && note.scope.filePath === scope.filePath) ||
			(note.scope.kind === "hunk" && note.scope.filePath === scope.filePath) ||
			(note.scope.kind === "selection" && note.scope.filePath === scope.filePath)
		);
	}
	if (note.scope.kind === "hunk" || note.scope.kind === "selection") {
		return note.scope.filePath === scope.filePath;
	}
	return note.scope.kind === "file" && note.scope.filePath === scope.filePath;
}

export class ReviewModeWorkbench implements Focusable {
	focused = false;

	private readonly theme: Theme;
	private readonly options: ReviewModeWorkbenchOptions;
	private readonly notes: ReviewModeNoteEntry[];
	private selectedIndex = 0;
	private selectedHunkIndex = 0;
	private focusArea: ReviewModeFocusArea = "files";
	private focusBeforeComposer: Exclude<ReviewModeFocusArea, "composer"> = "files";
	private visualSelectionAnchorLineIndex: number | null = null;
	private contentCursorLineIndex = 0;
	private mode: ReviewModeInputMode = "browse";
	private composerScope: ReviewModeScope | null = null;
	private draft = "";
	private cursor = 0;
	private answerPending = false;
	private lastQuestion = "";
	private lastQuestionScope: ReviewModeScope | null = null;
	private lastAnswer = "";
	private lastAnswerTimestamp: number | null = null;
	private diffScrollOffset = 0;
	private lastDiffPaneHeight = 1;
	private composerScrollOffset = 0;
	private lastBottomPaneHeight = 1;
	private cachedDisplayedFilePath: string | null = null;
	private cachedDisplayedFileLines: ReviewDiffDisplayLine[] = [];
	private cachedDisplayedFileHunkLineIndexes: number[] = [];

	constructor(theme: Theme, options: ReviewModeWorkbenchOptions) {
		this.theme = theme;
		this.options = options;
		this.notes = [...options.initialNotes];
		this.ensureSelectionState();
	}

	getSelectedChange(): ReviewModeFileChange | undefined {
		return this.options.files[this.selectedIndex];
	}

	getSelectedFileDiff(): ReviewModeFileDiff | undefined {
		const selected = this.getSelectedChange();
		if (!selected) return undefined;
		return findReviewModeFileDiff(this.options.fileDiffs, selected.path);
	}

	getSelectedHunk(): ReviewModeHunk | undefined {
		return this.getSelectedFileDiff()?.hunks[this.selectedHunkIndex];
	}

	getSelectedScope(): ReviewModeScope {
		this.ensureSelectionState();
		if (this.focusArea === "composer" && this.composerScope) return this.composerScope;
		return this.getVisualSelectionScope() ?? this.getCurrentFileScope();
	}

	focusContent(): void {
		if (this.focusArea === "content") return;
		this.focusArea = "content";
		this.ensureSelectionState();
		this.ensureContentCursorVisible();
		this.options.requestRender();
	}

	focusFiles(): void {
		if (this.focusArea === "files") return;
		this.focusArea = "files";
		this.options.requestRender();
	}

	startVisualSelection(): void {
		this.focusContent();
		if (this.getCurrentFileDiffDisplayLines().length === 0) return;
		if (this.visualSelectionAnchorLineIndex == null) {
			this.visualSelectionAnchorLineIndex = this.contentCursorLineIndex;
			this.options.requestRender();
		}
	}

	setSelectedHunkIndex(index: number): void {
		const hunks = this.getSelectedFileDiff()?.hunks ?? [];
		if (hunks.length === 0) {
			this.selectedHunkIndex = 0;
			this.contentCursorLineIndex = 0;
			this.visualSelectionAnchorLineIndex = null;
			this.resetDiffScroll();
			this.options.requestRender();
			return;
		}
		const bounded = Math.max(0, Math.min(hunks.length - 1, index));
		if (bounded === this.selectedHunkIndex && this.getCurrentFileHunkLineIndexes()[bounded] === this.contentCursorLineIndex) return;
		this.selectedHunkIndex = bounded;
		const hunkLineIndexes = this.getCurrentFileHunkLineIndexes();
		this.contentCursorLineIndex = hunkLineIndexes[bounded] ?? this.contentCursorLineIndex;
		this.ensureContentCursorVisible();
		this.options.requestRender();
	}

	moveSelection(delta: number): void {
		const next = Math.max(0, Math.min(this.options.files.length - 1, this.selectedIndex + delta));
		if (next === this.selectedIndex) return;
		this.selectedIndex = next;
		this.selectedHunkIndex = 0;
		this.contentCursorLineIndex = 0;
		this.visualSelectionAnchorLineIndex = null;
		this.invalidateDisplayedFileCache();
		if (this.focusArea === "composer" && this.composerScope?.kind !== "all") {
			this.composerScope = null;
		}
		this.resetDiffScroll();
		this.resetComposerScroll();
		this.ensureSelectionState();
		this.options.requestRender();
	}

	beginInputMode(mode: "ask" | "note", scope: ReviewModeScope = this.getSelectedScope()): void {
		this.mode = mode;
		this.composerScope = scope;
		this.focusBeforeComposer = this.focusArea === "composer" ? this.focusBeforeComposer : this.focusArea;
		this.focusArea = "composer";
		this.draft = "";
		this.cursor = 0;
		this.resetComposerScroll();
		this.options.requestRender();
	}

	replaceDraft(text: string): void {
		this.draft = text;
		this.cursor = text.length;
		this.options.requestRender();
	}

	startQuestion(scope: ReviewModeScope, text: string): void {
		this.lastQuestionScope = scope;
		this.composerScope = scope;
		this.lastQuestion = text;
		this.lastAnswer = "";
		this.answerPending = true;
		this.lastAnswerTimestamp = null;
		this.focusArea = "composer";
		this.mode = "browse";
		this.draft = "";
		this.cursor = 0;
		this.resetComposerScroll();
		this.options.requestRender();
	}

	updateAnswer(text: string): void {
		this.lastAnswer = text;
		this.pinComposerToBottom();
		this.options.requestRender();
	}

	finishAnswer(text: string): void {
		this.answerPending = false;
		this.lastAnswer = text;
		this.lastAnswerTimestamp = Date.now();
		this.pinComposerToBottom();
		this.options.requestRender();
	}

	recordNote(note: ReviewModeNoteEntry): void {
		this.notes.push(note);
		this.composerScope = note.scope;
		this.lastAnswer = `Saved note: ${note.note}`;
		this.lastAnswerTimestamp = Date.now();
		this.answerPending = false;
		this.focusArea = "composer";
		this.pinComposerToBottom();
		this.options.requestRender();
	}

	handleInput(data: string): void {
		if (this.mode === "browse") {
			this.handleBrowseInput(data);
			return;
		}

		this.handleInputModeInput(data);
	}

	render(width: number): string[] {
		this.ensureSelectionState();
		const layoutWidth = Math.max(1, width - 2);
		if (layoutWidth < WIDE_LAYOUT_MIN_WIDTH) {
			return this.renderStacked(width);
		}
		return this.renderWide(width);
	}

	invalidate(): void {}

	private renderWide(width: number): string[] {
		const gap = 1;
		const outerWidth = Math.max(40, width);
		const innerWidth = Math.max(20, outerWidth - 2);
		const terminalRows = process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows : 40;
		const modalHeight = Math.max(28, Math.floor(terminalRows * REVIEW_MODAL_HEIGHT_RATIO));
		const composerPaneHeight = REVIEW_COMPOSER_PANE_HEIGHT;
		const middlePaneHeight = Math.max(16, modalHeight - REVIEW_HEADER_LINES - composerPaneHeight);
		const header = `${this.theme.bold("Review Mode")} ${this.theme.fg("accent", `· ${this.options.source}`)} ${this.theme.fg("dim", `· ${this.options.cwd}`)}`;
		const middleAvailableWidth = innerWidth - gap;
		const filesWidth = Math.max(28, Math.floor(middleAvailableWidth / 3));
		const contentWidth = Math.max(50, middleAvailableWidth - filesWidth);
		const filesPane = createPaneLines(
			this.theme,
			this.buildFilePaneTitle(),
			this.buildFilePaneContent(middlePaneHeight - 2),
			filesWidth,
			middlePaneHeight,
		);
		const contentPane = createPaneLines(
			this.theme,
			this.buildContentPaneTitle(),
			this.buildDiffPaneContent(middlePaneHeight - 2),
			contentWidth,
			middlePaneHeight,
		);
		const bottomPane = createPaneLines(
			this.theme,
			this.getBottomPaneTitle(),
			this.buildBottomPaneContent(composerPaneHeight - 2),
			innerWidth,
			composerPaneHeight,
		);
		return createModalFrameLines(
			this.theme,
			header,
			[
				this.theme.fg("dim", truncateToWidth(this.buildScopeSummary(), innerWidth)),
				...mergePaneColumns([filesPane, contentPane]),
				...bottomPane,
			],
			outerWidth,
			this.theme.fg("dim", this.buildFooterHelp()),
		);
	}

	private renderStacked(width: number): string[] {
		const outerWidth = Math.max(40, width);
		const innerWidth = Math.max(20, outerWidth - 2);
		const terminalRows = process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows : 36;
		const modalHeight = Math.max(24, Math.floor(terminalRows * REVIEW_MODAL_HEIGHT_RATIO));
		const filesPaneHeight = 6;
		const composerPaneHeight = 7;
		const contentPaneHeight = Math.max(10, modalHeight - REVIEW_HEADER_LINES - filesPaneHeight - composerPaneHeight);
		const panes = [
			createPaneLines(this.theme, this.buildFilePaneTitle(), this.buildFilePaneContent(filesPaneHeight - 2), innerWidth, filesPaneHeight),
			createPaneLines(this.theme, this.buildContentPaneTitle(), this.buildDiffPaneContent(contentPaneHeight - 2), innerWidth, contentPaneHeight),
			createPaneLines(this.theme, this.getBottomPaneTitle(), this.buildBottomPaneContent(composerPaneHeight - 2), innerWidth, composerPaneHeight),
		];
		return createModalFrameLines(
			this.theme,
			this.theme.bold("Review Mode") + this.theme.fg("accent", ` · ${this.options.source}`),
			[
				this.theme.fg("dim", truncateToWidth(this.buildScopeSummary(), innerWidth)),
				...panes.flat(),
			],
			outerWidth,
			this.theme.fg("dim", this.buildFooterHelp()),
		);
	}

	private buildFilePaneTitle(): string {
		const base = `Changed Files (${this.options.files.length})`;
		return this.focusArea === "files" ? `${base} · focus` : base;
	}

	private buildFilePaneContent(height: number): string[] {
		const lines: string[] = [];
		const windowSize = Math.min(Math.max(1, height - 2), this.options.files.length);
		const windowStart = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(windowSize / 2), Math.max(0, this.options.files.length - windowSize)),
		);
		const visibleFiles = this.options.files.slice(windowStart, windowStart + windowSize);
		for (let i = 0; i < visibleFiles.length; i++) {
			const index = windowStart + i;
			const change = visibleFiles[i]!;
			let line = `${index === this.selectedIndex ? "▶" : " "} ${formatStatusBadge(this.theme, change)} ${formatReviewModeChange(change)}`;
			if (index === this.selectedIndex) {
				line = this.focusArea === "files" ? this.theme.bg("selectedBg", line) : this.theme.fg("accent", line);
			}
			lines.push(line);
		}
		if (this.options.files.length > visibleFiles.length) {
			lines.push(this.theme.fg("dim", `showing ${windowStart + 1}-${windowStart + visibleFiles.length} of ${this.options.files.length}`));
		}
		lines.push("");
		lines.push(this.theme.fg("dim", "Enter opens file · Tab/Shift+Enter/A asks about all changes"));
		return lines.slice(0, height);
	}

	private buildContentPaneTitle(): string {
		const lines = this.getCurrentFileDiffDisplayLines();
		const selected = this.getSelectedChange();
		const total = lines.length;
		const start = total === 0 ? 0 : this.diffScrollOffset + 1;
		const end = Math.min(total, this.diffScrollOffset + this.lastDiffPaneHeight);
		const range = total === 0 ? "0/0" : `${start}-${end}/${total}`;
		const hunkCount = this.getSelectedFileDiff()?.hunks.length ?? 0;
		const hunkLabel = hunkCount > 0 ? ` · hunk ${Math.min(this.selectedHunkIndex + 1, hunkCount)}/${hunkCount}` : "";
		const visualRange = this.getVisualSelectionRange();
		const modeLabel = visualRange
			? ` · VISUAL ${visualRange.start + 1}-${visualRange.end + 1}`
			: this.focusArea === "content"
				? " · CODE"
				: "";
		return `Content · ${selected ? formatReviewModeChange(selected) : "no file"}${modeLabel}${hunkLabel} · ${range}`;
	}

	private invalidateDisplayedFileCache(): void {
		this.cachedDisplayedFilePath = null;
		this.cachedDisplayedFileLines = [];
		this.cachedDisplayedFileHunkLineIndexes = [];
	}

	private getCurrentFileScope(): ReviewModeScope {
		const filePath = this.getSelectedChange()?.path ?? this.options.files[0]?.path ?? "";
		return { kind: "file", filePath };
	}

	private getCurrentFileDiffDisplayLines(): ReviewDiffDisplayLine[] {
		const fileDiff = this.getSelectedFileDiff();
		if (!fileDiff) {
			this.invalidateDisplayedFileCache();
			return [];
		}
		if (this.cachedDisplayedFilePath === fileDiff.path) {
			return this.cachedDisplayedFileLines;
		}
		const lines = buildDisplayedFileDiffLines(this.theme, fileDiff);
		this.cachedDisplayedFilePath = fileDiff.path;
		this.cachedDisplayedFileLines = lines;
		this.cachedDisplayedFileHunkLineIndexes = lines
			.map((line, index) => (line.isHunkHeader ? index : -1))
			.filter((index) => index >= 0);
		return lines;
	}

	private getCurrentFileHunkLineIndexes(lines: ReviewDiffDisplayLine[] = this.getCurrentFileDiffDisplayLines()): number[] {
		if (lines === this.cachedDisplayedFileLines) return this.cachedDisplayedFileHunkLineIndexes;
		const indexes: number[] = [];
		for (let i = 0; i < lines.length; i++) {
			if (lines[i]!.isHunkHeader) indexes.push(i);
		}
		return indexes;
	}

	private getVisualSelectionRange(): { start: number; end: number } | null {
		if (this.visualSelectionAnchorLineIndex == null) return null;
		return {
			start: Math.min(this.visualSelectionAnchorLineIndex, this.contentCursorLineIndex),
			end: Math.max(this.visualSelectionAnchorLineIndex, this.contentCursorLineIndex),
		};
	}

	private getVisualSelectionScope(): Extract<ReviewModeScope, { kind: "selection" }> | null {
		const range = this.getVisualSelectionRange();
		const selected = this.getSelectedChange();
		const lines = this.getCurrentFileDiffDisplayLines();
		if (!range || !selected || lines.length === 0) return null;
		const startLine = lines[range.start];
		const endLine = lines[range.end];
		if (!startLine || !endLine) return null;
		return {
			kind: "selection",
			filePath: selected.path,
			startLine: range.start + 1,
			endLine: range.end + 1,
			rawStartLine: startLine.rawLineIndex,
			rawEndLine: endLine.rawLineIndex,
		};
	}

	private clearVisualSelection(): void {
		if (this.visualSelectionAnchorLineIndex == null) return;
		this.visualSelectionAnchorLineIndex = null;
	}

	private syncSelectedHunkToCursor(lines: ReviewDiffDisplayLine[] = this.getCurrentFileDiffDisplayLines()): void {
		const hunkLineIndexes = this.getCurrentFileHunkLineIndexes(lines);
		if (hunkLineIndexes.length === 0) {
			this.selectedHunkIndex = 0;
			return;
		}
		let nextIndex = 0;
		for (let i = 0; i < hunkLineIndexes.length; i++) {
			if (hunkLineIndexes[i]! <= this.contentCursorLineIndex) nextIndex = i;
			else break;
		}
		this.selectedHunkIndex = nextIndex;
	}

	private ensureContentCursorVisible(): void {
		if (this.contentCursorLineIndex < this.diffScrollOffset) {
			this.diffScrollOffset = this.contentCursorLineIndex;
			return;
		}
		const bottom = this.diffScrollOffset + this.lastDiffPaneHeight - 1;
		if (this.contentCursorLineIndex > bottom) {
			this.diffScrollOffset = Math.max(0, this.contentCursorLineIndex - this.lastDiffPaneHeight + 1);
		}
	}

	private moveContentHunkSelection(delta: number): void {
		const hunks = this.getSelectedFileDiff()?.hunks ?? [];
		if (hunks.length === 0) return;
		this.setSelectedHunkIndex(Math.max(0, Math.min(hunks.length - 1, this.selectedHunkIndex + delta)));
	}

	private moveContentLine(delta: number): void {
		const lines = this.getCurrentFileDiffDisplayLines();
		if (lines.length === 0) return;
		const next = Math.max(0, Math.min(lines.length - 1, this.contentCursorLineIndex + delta));
		if (next === this.contentCursorLineIndex) return;
		this.contentCursorLineIndex = next;
		this.syncSelectedHunkToCursor(lines);
		this.ensureContentCursorVisible();
		this.options.requestRender();
	}

	private startOrExtendVisualSelection(delta: number): void {
		this.focusContent();
		if (this.getCurrentFileDiffDisplayLines().length === 0) return;
		if (this.visualSelectionAnchorLineIndex == null) {
			this.visualSelectionAnchorLineIndex = this.contentCursorLineIndex;
		}
		this.moveContentLine(delta);
	}

	private clampDiffScroll(totalLines: number): void {
		const maxOffset = Math.max(0, totalLines - this.lastDiffPaneHeight);
		if (this.diffScrollOffset > maxOffset) this.diffScrollOffset = maxOffset;
		if (this.diffScrollOffset < 0) this.diffScrollOffset = 0;
	}

	private resetDiffScroll(): void {
		this.diffScrollOffset = 0;
	}

	private scrollDiff(delta: number): void {
		const totalLines = this.getCurrentFileDiffDisplayLines().length;
		this.clampDiffScroll(totalLines);
		const maxOffset = Math.max(0, totalLines - this.lastDiffPaneHeight);
		const next = Math.max(0, Math.min(maxOffset, this.diffScrollOffset + delta));
		if (next === this.diffScrollOffset) return;
		this.diffScrollOffset = next;
		this.options.requestRender();
	}

	private scrollDiffTo(position: "start" | "end"): void {
		const totalLines = this.getCurrentFileDiffDisplayLines().length;
		this.clampDiffScroll(totalLines);
		const next = position === "start" ? 0 : Math.max(0, totalLines - this.lastDiffPaneHeight);
		if (next === this.diffScrollOffset) return;
		this.diffScrollOffset = next;
		this.options.requestRender();
	}

	private styleContentLine(line: ReviewDiffDisplayLine, index: number): string {
		const selection = this.getVisualSelectionRange();
		const isSelected = !!selection && index >= selection.start && index <= selection.end;
		const isCursor = index === this.contentCursorLineIndex;
		const isFocusedCursor = this.focusArea === "content" && !selection && isCursor;
		const gutter = isSelected
			? this.theme.fg("accent", this.theme.bold("▌"))
			: isFocusedCursor
				? this.theme.fg("accent", "▶")
				: this.theme.fg("dim", "│");
		const gutterBlock = isSelected || isFocusedCursor ? this.theme.bg("selectedBg", `${gutter} `) : `${gutter} `;
		return `${gutterBlock}${line.text}`;
	}

	private buildDiffPaneContent(height: number): string[] {
		this.lastDiffPaneHeight = Math.max(1, height);
		const lines = this.getCurrentFileDiffDisplayLines();
		if (lines.length === 0) {
			return [this.theme.fg("dim", "No diff text available for the selected file.")];
		}
		this.ensureSelectionState();
		this.clampDiffScroll(lines.length);
		const visible = lines.slice(this.diffScrollOffset, this.diffScrollOffset + height);
		return visible.map((line, index) => this.styleContentLine(line!, this.diffScrollOffset + index));
	}

	private getBottomPaneLines(): string[] {
		const lines: string[] = [];
		const currentScope = this.getSelectedScope();
		lines.push(this.theme.fg("muted", `selection: ${formatReviewModeScope(currentScope, this.options.files.length, this.options.source)}`));
		lines.push(this.theme.fg("dim", "Enter asks about the current scope · answers stay here · target 2-5 short lines"));
		if (this.mode === "ask" || this.mode === "note") {
			lines.push("");
			lines.push(this.theme.fg("accent", this.mode === "ask" ? "Scoped question" : "Scoped note"));
			lines.push(`${this.mode}: ${renderCursorText(this.draft, this.cursor, this.focused)}`);
		}
		if (this.lastQuestionScope) {
			lines.push("");
			lines.push(this.theme.fg("muted", `last scope: ${formatReviewModeScope(this.lastQuestionScope, this.options.files.length, this.options.source)}`));
		}
		if (this.lastQuestion) {
			lines.push(this.theme.fg("accent", `Q: ${this.lastQuestion}`));
		}
		if (this.answerPending) {
			lines.push(this.theme.fg("warning", "Answering with the current session context..."));
		}
		if (this.lastAnswer) {
			for (const line of this.lastAnswer.split(/\r?\n/)) {
				lines.push(line);
			}
		} else if (!this.answerPending && this.mode === "browse") {
			lines.push(this.theme.fg("dim", "No scoped answer yet."));
		}
		const relatedNotes = this.notes.filter((note) => noteMatchesScope(note, currentScope, this.options.source));
		if (relatedNotes.length > 0) {
			lines.push("");
			lines.push(this.theme.fg("accent", "Notes for current selection"));
			for (const note of relatedNotes.slice(-2)) {
				lines.push(`- ${note.note}`);
			}
		}
		return lines;
	}

	private clampComposerScroll(totalLines: number): void {
		const maxOffset = Math.max(0, totalLines - this.lastBottomPaneHeight);
		if (this.composerScrollOffset > maxOffset) this.composerScrollOffset = maxOffset;
		if (this.composerScrollOffset < 0) this.composerScrollOffset = 0;
	}

	private resetComposerScroll(): void {
		this.composerScrollOffset = 0;
	}

	private pinComposerToBottom(): void {
		const totalLines = this.getBottomPaneLines().length;
		this.clampComposerScroll(totalLines);
		this.composerScrollOffset = Math.max(0, totalLines - this.lastBottomPaneHeight);
	}

	private scrollComposer(delta: number): void {
		const totalLines = this.getBottomPaneLines().length;
		this.clampComposerScroll(totalLines);
		const maxOffset = Math.max(0, totalLines - this.lastBottomPaneHeight);
		const next = Math.max(0, Math.min(maxOffset, this.composerScrollOffset + delta));
		if (next === this.composerScrollOffset) return;
		this.composerScrollOffset = next;
		this.options.requestRender();
	}

	private buildBottomPaneContent(height: number): string[] {
		this.lastBottomPaneHeight = Math.max(1, height);
		const lines = this.getBottomPaneLines();
		this.clampComposerScroll(lines.length);
		return lines.slice(this.composerScrollOffset, this.composerScrollOffset + height);
	}

	private getBottomPaneTitle(): string {
		const total = this.getBottomPaneLines().length;
		this.clampComposerScroll(total);
		const start = total === 0 ? 0 : this.composerScrollOffset + 1;
		const end = Math.min(total, this.composerScrollOffset + this.lastBottomPaneHeight);
		const range = total === 0 ? "0/0" : `${start}-${end}/${total}`;
		const base = this.mode === "note" ? "Composer · Save Note" : this.mode === "ask" ? "Composer · Ask Question" : "Composer";
		return `${base} · ${range}`;
	}

	private buildScopeSummary(): string {
		const focus = this.focusArea === "content" && this.visualSelectionAnchorLineIndex != null ? "visual" : this.focusArea;
		const selection = this.getVisualSelectionRange();
		const selectionSummary = selection ? ` · Selected lines ${selection.start + 1}-${selection.end + 1}` : "";
		return `Focus: ${focus} · Scope: ${formatReviewModeScope(this.getSelectedScope(), this.options.files.length, this.options.source)}${selectionSummary}`;
	}

	private buildFooterHelp(): string {
		if (this.mode === "ask" || this.mode === "note") {
			return "Composer · type question/note · Enter submit · Esc back";
		}
		if (this.focusArea === "composer") {
			const base = "Composer · Enter follow-up · n note · J/K scroll composer · Esc back";
			return this.answerPending ? `${base} · waiting for scoped answer` : base;
		}
		if (this.focusArea === "content") {
			const navigation = this.visualSelectionAnchorLineIndex == null ? "j/k lines · ↑↓ hunks" : "j/k/↑↓ extend selection";
			const enterHint = this.visualSelectionAnchorLineIndex == null ? "Enter ask file" : "Enter ask selection";
			const visualHint = this.visualSelectionAnchorLineIndex == null ? "b/v visual select" : "b/v/Esc cancel selection";
			const base = `Content · ${navigation} · Ctrl+U/Ctrl+D scroll · g/G top/bottom · ${enterHint} · ${visualHint} · Esc files`;
			return this.answerPending ? `${base} · waiting for scoped answer` : base;
		}
		const base = "Files · ↑↓/j/k select file · Enter inspect file · Tab ask all · J/K scroll composer · Esc close";
		return this.answerPending ? `${base} · waiting for scoped answer` : base;
	}

	private ensureSelectionState(): void {
		if (this.options.files.length === 0) {
			this.selectedIndex = 0;
			this.selectedHunkIndex = 0;
			this.contentCursorLineIndex = 0;
			this.visualSelectionAnchorLineIndex = null;
			this.invalidateDisplayedFileCache();
			return;
		}
		this.selectedIndex = Math.max(0, Math.min(this.options.files.length - 1, this.selectedIndex));
		const fileDiff = this.getSelectedFileDiff();
		const hunks = fileDiff?.hunks ?? [];
		const lines = this.getCurrentFileDiffDisplayLines();
		if (hunks.length === 0) {
			this.selectedHunkIndex = 0;
		} else {
			this.selectedHunkIndex = Math.max(0, Math.min(hunks.length - 1, this.selectedHunkIndex));
		}
		if (lines.length === 0) {
			this.contentCursorLineIndex = 0;
			this.visualSelectionAnchorLineIndex = null;
			return;
		}
		const hunkLineIndexes = this.getCurrentFileHunkLineIndexes(lines);
		if (hunkLineIndexes.length > 0 && (this.contentCursorLineIndex < 0 || this.contentCursorLineIndex >= lines.length)) {
			this.contentCursorLineIndex = hunkLineIndexes[this.selectedHunkIndex] ?? 0;
		} else {
			this.contentCursorLineIndex = Math.max(0, Math.min(lines.length - 1, this.contentCursorLineIndex));
		}
		if (this.visualSelectionAnchorLineIndex != null) {
			this.visualSelectionAnchorLineIndex = Math.max(0, Math.min(lines.length - 1, this.visualSelectionAnchorLineIndex));
		}
		if (hunkLineIndexes.length > 0 && this.visualSelectionAnchorLineIndex == null) {
			this.contentCursorLineIndex = hunkLineIndexes[this.selectedHunkIndex] ?? this.contentCursorLineIndex;
		}
		this.syncSelectedHunkToCursor(lines);
		this.ensureContentCursorVisible();
	}

	private submitDraft(): boolean {
		const text = this.draft.trim();
		if (!text) return false;
		const scope = this.composerScope ?? this.getSelectedScope();
		if (this.mode === "ask") {
			if (this.answerPending) return false;
			this.startQuestion(scope, text);
			this.options.onAsk(scope, text);
			return true;
		}
		if (this.mode === "note") {
			this.mode = "browse";
			this.draft = "";
			this.cursor = 0;
			const note = this.options.onSaveNote(scope, text);
			this.recordNote(note);
			return true;
		}
		return false;
	}

	private handleBrowseInput(data: string): void {
		if (data === "K") {
			this.scrollComposer(-1);
			return;
		}
		if (data === "J") {
			this.scrollComposer(1);
			return;
		}
		if (data === "q" || data === "Q") {
			this.options.onClose();
			return;
		}
		if (this.focusArea === "composer") {
			this.handleComposerBrowseInput(data);
			return;
		}
		if (this.focusArea === "content") {
			this.handleContentBrowseInput(data);
			return;
		}
		this.handleFilesBrowseInput(data);
	}

	private handleFilesBrowseInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.options.onClose();
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			this.moveSelection(-1);
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			this.moveSelection(1);
			return;
		}
		if (matchesKey(data, Key.tab)) {
			if (!this.answerPending) this.beginInputMode("ask", { kind: "all" });
			return;
		}
		if (matchesKey(data, Key.shift("enter")) || matchesKey(data, Key.shift("return")) || data === "A") {
			if (!this.answerPending) this.beginInputMode("ask", { kind: "all" });
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.focusContent();
			return;
		}
		if (data === "n" || data === "N") {
			this.beginInputMode("note", this.getCurrentFileScope());
		}
	}

	private handleContentBrowseInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			if (this.visualSelectionAnchorLineIndex != null) {
				this.clearVisualSelection();
				this.options.requestRender();
				return;
			}
			this.focusFiles();
			return;
		}
		if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
			this.scrollDiff(-this.lastDiffPaneHeight);
			return;
		}
		if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
			this.scrollDiff(this.lastDiffPaneHeight);
			return;
		}
		if (data === "g") {
			this.scrollDiffTo("start");
			return;
		}
		if (data === "G") {
			this.scrollDiffTo("end");
			return;
		}
		if (matchesKey(data, Key.shift("up"))) {
			this.startOrExtendVisualSelection(-1);
			return;
		}
		if (matchesKey(data, Key.shift("down"))) {
			this.startOrExtendVisualSelection(1);
			return;
		}
		if (data === "v" || data === "V" || data === "b" || data === "B") {
			if (this.visualSelectionAnchorLineIndex == null) this.startVisualSelection();
			else {
				this.clearVisualSelection();
				this.options.requestRender();
			}
			return;
		}
		if (data === "k") {
			this.moveContentLine(-1);
			return;
		}
		if (data === "j") {
			this.moveContentLine(1);
			return;
		}
		if (matchesKey(data, Key.up)) {
			if (this.visualSelectionAnchorLineIndex != null) this.moveContentLine(-1);
			else this.moveContentHunkSelection(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			if (this.visualSelectionAnchorLineIndex != null) this.moveContentLine(1);
			else this.moveContentHunkSelection(1);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (this.answerPending) return;
			this.beginInputMode("ask", this.getVisualSelectionScope() ?? this.getCurrentFileScope());
			return;
		}
		if (data === "n" || data === "N") {
			this.beginInputMode("note", this.getVisualSelectionScope() ?? this.getCurrentFileScope());
		}
	}

	private handleComposerBrowseInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.focusArea = this.focusBeforeComposer;
			this.options.requestRender();
			return;
		}
		if ((matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) && this.focusArea === "composer") {
			this.scrollComposer(-this.lastBottomPaneHeight);
			return;
		}
		if ((matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) && this.focusArea === "composer") {
			this.scrollComposer(this.lastBottomPaneHeight);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (!this.answerPending) this.beginInputMode("ask", this.composerScope ?? this.getCurrentFileScope());
			return;
		}
		if (data === "n" || data === "N") {
			this.beginInputMode("note", this.composerScope ?? this.getCurrentFileScope());
		}
	}

	private handleInputModeInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.mode = "browse";
			this.draft = "";
			this.cursor = 0;
			this.focusArea = this.focusBeforeComposer;
			this.options.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (!this.submitDraft()) this.options.requestRender();
			return;
		}
		if (matchesKey(data, Key.left)) {
			this.cursor = Math.max(0, this.cursor - 1);
			this.options.requestRender();
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.cursor = Math.min(this.draft.length, this.cursor + 1);
			this.options.requestRender();
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.cursor = 0;
			this.options.requestRender();
			return;
		}
		if (matchesKey(data, Key.end)) {
			this.cursor = this.draft.length;
			this.options.requestRender();
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			if (this.cursor === 0) return;
			this.draft = this.draft.slice(0, this.cursor - 1) + this.draft.slice(this.cursor);
			this.cursor -= 1;
			this.options.requestRender();
			return;
		}
		if (matchesKey(data, Key.delete)) {
			if (this.cursor >= this.draft.length) return;
			this.draft = this.draft.slice(0, this.cursor) + this.draft.slice(this.cursor + 1);
			this.options.requestRender();
			return;
		}
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.draft = this.draft.slice(0, this.cursor) + data + this.draft.slice(this.cursor);
			this.cursor += 1;
			this.options.requestRender();
		}
	}
}

export async function handleReviewModeCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const parsed = parseReviewModeArgs(args);
	if (parsed.error) {
		ctx.ui.notify(parsed.error, "error");
		ctx.ui.setEditorText(buildReviewModeHelpText());
		return;
	}

	if (parsed.help) {
		ctx.ui.setEditorText(buildReviewModeHelpText());
		ctx.ui.notify("Loaded review-mode help", "info");
		return;
	}

	if (!ctx.hasUI) {
		ctx.ui.notify("review-mode requires the interactive Pi TUI.", "error");
		return;
	}

	await ctx.waitForIdle();

	const loaded = await loadReviewModeData(pi, ctx.cwd, parsed.source);
	if (!loaded.ok) {
		ctx.ui.notify(loaded.error, loaded.level);
		return;
	}

	if (loaded.data.files.length === 0) {
		ctx.ui.notify(`No ${describeReviewSource(parsed.source)} to review.`, "info");
		return;
	}

	const sessionId = ctx.sessionManager.getSessionId();
	const initialNotes = collectReviewModeNotes(ctx.sessionManager.getEntries()).filter((note) => note.source === parsed.source);
	const runtimeId = nextReviewWorkbenchId++;
	let runtime: ActiveReviewWorkbenchRuntime | null = null;

	try {
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				const workbench = new ReviewModeWorkbench(theme, {
					cwd: ctx.cwd,
					source: parsed.source,
					files: loaded.data.files,
					fileDiffs: loaded.data.fileDiffs,
					fullDiff: loaded.data.fullDiff,
					initialNotes,
					requestRender: () => tui.requestRender(),
					onAsk: (scope, text) => {
						const injection: ReviewModeInjectionInput = {
							source: parsed.source,
							scope,
							files: loaded.data.files,
							diff: buildScopedReviewDiff(scope, loaded.data.fullDiff, loaded.data.fileDiffs),
						};
						queueReviewQuestion({ workbenchId: runtimeId, sessionId, prompt: text, injection }, pi, ctx);
						ctx.ui.notify(
							`Asked review question about ${formatReviewModeScope(scope, loaded.data.files.length, parsed.source)}.`,
							"info",
						);
					},
					onSaveNote: (scope, text) => {
						const note: ReviewModeNoteEntry = {
							source: parsed.source,
							scope,
							note: text,
							createdAt: Date.now(),
							fileCount: loaded.data.files.length,
						};
						pi.appendEntry(REVIEW_MODE_NOTE_ENTRY_TYPE, note);
						ctx.ui.notify(
							`Saved review note for ${formatReviewModeScope(scope, loaded.data.files.length, parsed.source)}.`,
							"info",
						);
						return note;
					},
					onClose: () => done(undefined),
				});

				runtime = { id: runtimeId, sessionId, workbench };
				activeReviewWorkbench = runtime;
				return workbench;
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: REVIEW_MODAL_WIDTH,
					minWidth: REVIEW_MODAL_MIN_WIDTH,
					maxHeight: REVIEW_MODAL_MAX_HEIGHT,
				},
			},
		);
	} finally {
		if (activeReviewWorkbench?.id === runtimeId) activeReviewWorkbench = null;
	}
}

function queueReviewQuestion(pending: PendingReviewQuestion, pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
	pendingReviewQuestion = pending;
	if (ctx.isIdle()) {
		pi.sendUserMessage(pending.prompt);
	} else {
		pi.sendUserMessage(pending.prompt, { deliverAs: "followUp" });
	}
}

function isActiveWorkbenchSession(sessionId: string): boolean {
	return !!activeReviewWorkbench && activeReviewWorkbench.sessionId === sessionId;
}

function strengthenScopedSystemPrompt(systemPrompt: string, injection: ReviewModeInjectionInput): string {
	return [
		systemPrompt,
		"",
		buildReviewModeInjectionPrompt(injection),
	].join("\n");
}

let nextReviewWorkbenchId = 1;
let pendingReviewQuestion: PendingReviewQuestion | null = null;
let activeReviewQuestion: ActiveReviewQuestion | null = null;
let activeReviewWorkbench: ActiveReviewWorkbenchRuntime | null = null;

export default function reviewModeExtension(pi: ExtensionAPI) {
	pi.on("session_start", async () => {
		pendingReviewQuestion = null;
		activeReviewQuestion = null;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const pending = pendingReviewQuestion;
		if (!pending) return;
		if (pending.sessionId !== ctx.sessionManager.getSessionId()) return;
		if (event.prompt.trim() !== pending.prompt.trim()) return;
		pendingReviewQuestion = null;
		activeReviewQuestion = { workbenchId: pending.workbenchId, sessionId: pending.sessionId, prompt: pending.prompt };
		return {
			systemPrompt: strengthenScopedSystemPrompt(event.systemPrompt, pending.injection),
		};
	});

	pi.on("message_update", async (event, ctx) => {
		if (!activeReviewQuestion) return;
		if (!isActiveWorkbenchSession(ctx.sessionManager.getSessionId())) return;
		if (activeReviewWorkbench?.id !== activeReviewQuestion.workbenchId) return;
		const text = extractAssistantText((event as { message?: unknown }).message);
		if (!text) return;
		activeReviewWorkbench.workbench.updateAnswer(text);
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!activeReviewQuestion) return;
		if (activeReviewQuestion.sessionId !== ctx.sessionManager.getSessionId()) {
			activeReviewQuestion = null;
			return;
		}
		const text = extractLastAssistantText((event as { messages?: unknown[] }).messages ?? []);
		if (activeReviewWorkbench?.id === activeReviewQuestion.workbenchId) {
			activeReviewWorkbench.workbench.finishAnswer(text || "No assistant answer text was produced for this scoped question.");
		}
		activeReviewQuestion = null;
	});

	pi.registerCommand("review-mode", {
		description: "Open an in-session review workbench for local, staged, unstaged, or outgoing git changes",
		handler: async (args, ctx) => handleReviewModeCommand(pi, args, ctx),
	});

	pi.registerCommand("review-notes", {
		description: "List saved review-mode notes for the current session",
		handler: async (_args, ctx) => {
			const notes = collectReviewModeNotes(ctx.sessionManager.getEntries());
			if (notes.length === 0) {
				ctx.ui.notify("No review notes saved in this session.", "info");
				return;
			}
			ctx.ui.setEditorText(formatReviewModeNotes(notes));
			ctx.ui.notify(`Loaded ${notes.length} review note(s).`, "info");
		},
	});
}
