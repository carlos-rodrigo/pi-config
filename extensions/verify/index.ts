import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { HANDOFF_SESSION_STARTED_EVENT } from "../handoff/events.ts";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Type } from "@sinclair/typebox";

export const VERIFY_SCRIPT_RELATIVE_PATH = "scripts/verify.sh";
const VERIFY_TIMEOUT_MS = 60_000;
const MAX_ERROR_CHARS = 12_000;

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
export type VerifyTemplateKind = "node" | "go" | "rust" | "python" | "ruby" | "elixir" | "generic";

export type DetectedProjectTemplate = {
	kind: VerifyTemplateKind;
	signals: string[];
	packageManager?: PackageManager;
};

type VerificationFailure = {
	projectRoot: string;
	errors: string;
};

type VerificationPlanInput = {
	task: string;
	paths?: string[];
	changedPaths?: string[];
	behaviorChange?: boolean;
};

export type VerificationPlan = {
	projectRoot: string;
	task: string;
	paths: string[];
	targetedCommands: string[];
	regressionCommands: string[];
	preChangeChecks: string[];
	edgeCases: string[];
	manualChecks: string[];
	notes: string[];
};

type SetupMode = "created" | "existing" | "reset";

const NODE_LOCKFILES: Array<{ file: string; packageManager: PackageManager }> = [
	{ file: "pnpm-lock.yaml", packageManager: "pnpm" },
	{ file: "yarn.lock", packageManager: "yarn" },
	{ file: "bun.lockb", packageManager: "bun" },
	{ file: "bun.lock", packageManager: "bun" },
	{ file: "package-lock.json", packageManager: "npm" },
];

const STACK_MARKERS: Array<{ file: string; kind: Exclude<VerifyTemplateKind, "generic"> }> = [
	{ file: "package.json", kind: "node" },
	{ file: "go.mod", kind: "go" },
	{ file: "Cargo.toml", kind: "rust" },
	{ file: "pyproject.toml", kind: "python" },
	{ file: "requirements.txt", kind: "python" },
	{ file: "setup.py", kind: "python" },
	{ file: "Pipfile", kind: "python" },
	{ file: "poetry.lock", kind: "python" },
	{ file: "uv.lock", kind: "python" },
	{ file: "Gemfile", kind: "ruby" },
	{ file: "mix.exs", kind: "elixir" },
];

const ADDITIONAL_SIGNALS = ["Makefile"] as const;

function stripLeadingAt(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

export function normalizeToolPath(path: string): string {
	return stripLeadingAt(path);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function shellQuote(text: string): string {
	return `'${text.replace(/'/g, `'\\''`)}'`;
}

function truncateForMessage(text: string): string {
	if (text.length <= MAX_ERROR_CHARS) return text;
	return `${text.slice(0, MAX_ERROR_CHARS)}\n\n[truncated to ${MAX_ERROR_CHARS} chars]`;
}

function describeTemplate(template: DetectedProjectTemplate): string {
	if (template.kind === "node" && template.packageManager) {
		return `node/${template.packageManager}`;
	}
	return template.kind;
}

function formatVerifyCommand(projectRoot: string, quick = false): string {
	const command = quick ? `bash ${VERIFY_SCRIPT_RELATIVE_PATH} --quick` : `bash ${VERIFY_SCRIPT_RELATIVE_PATH}`;
	return `cd ${shellQuote(projectRoot)} && ${command}`;
}

async function findNearestVerifyRoot(startDir: string): Promise<string | undefined> {
	let current = resolve(startDir);

	while (true) {
		if (await pathExists(join(current, VERIFY_SCRIPT_RELATIVE_PATH))) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

async function findNearestMarkerRoot(startDir: string): Promise<string | undefined> {
	let current = resolve(startDir);

	while (true) {
		for (const marker of STACK_MARKERS) {
			if (await pathExists(join(current, marker.file))) return current;
		}
		for (const signal of ADDITIONAL_SIGNALS) {
			if (await pathExists(join(current, signal))) return current;
		}
		if (await pathExists(join(current, ".github", "workflows"))) return current;

		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

async function findGitRoot(pi: Pick<ExtensionAPI, "exec">, startDir: string): Promise<string | undefined> {
	try {
		const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
			cwd: startDir,
			timeout: 5_000,
		});
		if (result.code !== 0) return undefined;
		const root = result.stdout.trim();
		return root || undefined;
	} catch {
		return undefined;
	}
}

export async function findProjectRoot(pi: Pick<ExtensionAPI, "exec">, startDir: string): Promise<string | undefined> {
	const verifyRoot = await findNearestVerifyRoot(startDir);
	if (verifyRoot) return verifyRoot;

	const gitRoot = await findGitRoot(pi, startDir);
	if (gitRoot) return gitRoot;

	return findNearestMarkerRoot(startDir);
}

async function detectNodePackageManager(projectRoot: string): Promise<{ packageManager: PackageManager; signals: string[] }> {
	const signals: string[] = [];

	for (const entry of NODE_LOCKFILES) {
		if (await pathExists(join(projectRoot, entry.file))) {
			signals.push(entry.file);
			return { packageManager: entry.packageManager, signals };
		}
	}

	const packageJsonPath = join(projectRoot, "package.json");
	try {
		const raw = await readFile(packageJsonPath, "utf8");
		const parsed = JSON.parse(raw) as { packageManager?: unknown };
		if (typeof parsed.packageManager === "string") {
			const normalized = parsed.packageManager.split("@")[0] as PackageManager;
			if (["npm", "pnpm", "yarn", "bun"].includes(normalized)) {
				signals.push(`packageManager:${normalized}`);
				return { packageManager: normalized, signals };
			}
		}
	} catch {
		// Ignore malformed package.json and fall back to npm.
	}

	return { packageManager: "npm", signals };
}

export async function detectProjectTemplate(projectRoot: string): Promise<DetectedProjectTemplate> {
	const detectedKinds = new Set<Exclude<VerifyTemplateKind, "generic">>();
	const signals: string[] = [];

	for (const marker of STACK_MARKERS) {
		if (await pathExists(join(projectRoot, marker.file))) {
			detectedKinds.add(marker.kind);
			signals.push(marker.file);
		}
	}

	if (await pathExists(join(projectRoot, ".github", "workflows"))) {
		signals.push(".github/workflows/");
	}

	for (const signal of ADDITIONAL_SIGNALS) {
		if (await pathExists(join(projectRoot, signal))) signals.push(signal);
	}

	if (detectedKinds.size === 1 && detectedKinds.has("node")) {
		const nodeInfo = await detectNodePackageManager(projectRoot);
		return {
			kind: "node",
			packageManager: nodeInfo.packageManager,
			signals: [...signals, ...nodeInfo.signals],
		};
	}

	if (detectedKinds.size === 1) {
		return {
			kind: Array.from(detectedKinds)[0],
			signals,
		};
	}

	return { kind: "generic", signals };
}

function nodeScriptCommand(packageManager: PackageManager, script: string): string {
	switch (packageManager) {
		case "npm":
			return script === "test" ? "npm test" : `npm run ${script}`;
		case "pnpm":
			return `pnpm ${script}`;
		case "yarn":
			return `yarn ${script}`;
		case "bun":
			return `bun run ${script}`;
	}
}

function getTemplateCommands(template: DetectedProjectTemplate): { quick: string[]; full: string[] } {
	switch (template.kind) {
		case "node": {
			const packageManager = template.packageManager ?? "npm";
			return {
				quick: [nodeScriptCommand(packageManager, "test")],
				full: [
					nodeScriptCommand(packageManager, "test"),
					nodeScriptCommand(packageManager, "lint"),
					nodeScriptCommand(packageManager, "build"),
				],
			};
		}
		case "go":
			return {
				quick: ["go test ./..."],
				full: ["go test ./...", "go vet ./...", "go build ./..."],
			};
		case "rust":
			return {
				quick: ["cargo test"],
				full: ["cargo test", "cargo clippy --all-targets --all-features -- -D warnings", "cargo build --all-targets"],
			};
		case "python":
			return {
				quick: ["python -m pytest"],
				full: ["python -m pytest", "python -m compileall ."],
			};
		case "ruby":
			return {
				quick: ["bundle exec rake test"],
				full: ["bundle exec rake test"],
			};
		case "elixir":
			return {
				quick: ["mix test"],
				full: ["mix test", "mix format --check-formatted"],
			};
		case "generic":
			return {
				quick: ["echo \"No quick verification configured yet. Update this script for the current project.\""],
				full: ["echo \"No project-specific verification configured yet. Update this script for the current project.\""],
			};
	}
}

export function buildVerifyScript(template: DetectedProjectTemplate): string {
	const commands = getTemplateCommands(template);
	const quickBody = commands.quick.map((command) => `  ${command}`).join("\n");
	const fullBody = commands.full.join("\n");

	return [
		"#!/bin/bash",
		"# Starter verify script generated by /setup-verify.",
		"# Customize this file to match the real project quality gates.",
		"# Keep success silent and let failures surface command output.",
		"",
		"set -euo pipefail",
		"",
		"quick=false",
		'[[ "${1:-}" == "--quick" ]] && quick=true',
		"",
		"if [ \"$quick\" = true ]; then",
		quickBody,
		"  exit 0",
		"fi",
		"",
		fullBody,
		"",
	].join("\n");
}

export function buildSetupVerifyPrompt(
	projectRoot: string,
	template: DetectedProjectTemplate,
	mode: SetupMode,
): string {
	const scriptPath = join(projectRoot, VERIFY_SCRIPT_RELATIVE_PATH);
	const intro =
		mode === "created"
			? `A starter verification script was created at ${scriptPath} from the ${describeTemplate(template)} template.`
			: mode === "reset"
				? `The verification script at ${scriptPath} was reset to the ${describeTemplate(template)} starter template.`
				: `An existing verification script was found at ${scriptPath}.`;
	const detectedSignals = template.signals.length > 0 ? template.signals.map((signal) => `- ${signal}`).join("\n") : "- none";

	return [
		intro,
		"",
		"Inspect this repository's actual stack and verification workflow before editing the script.",
		"Use evidence from package scripts, lockfiles, CI workflows, Makefile/task runners, and the README.",
		"Do not invent commands that the repo does not already support.",
		"",
		`Detected signals at ${projectRoot}:`,
		detectedSignals,
		"",
		`Update ${scriptPath} so it matches the real quality gates for this project.`,
		"Keep success silent and let failures print the real errors.",
		"Support `bash scripts/verify.sh --quick` when there is a meaningful fast subset; otherwise make `--quick` equivalent to the full check.",
		"",
		"Then run these commands and fix the script until they both work:",
		`1. ${formatVerifyCommand(projectRoot, true)}`,
		`2. ${formatVerifyCommand(projectRoot)}`,
	].join("\n");
}

export function buildVerificationFailureMessage(failures: VerificationFailure[]): string {
	const lines = ["## ❌ Verification failed", "", "Fix these errors before finishing:", ""];

	for (const failure of failures) {
		lines.push(`### ${failure.projectRoot}`);
		lines.push("");
		lines.push("```");
		lines.push(truncateForMessage(failure.errors));
		lines.push("```");
		lines.push("");
		lines.push(`Run \`${formatVerifyCommand(failure.projectRoot)}\` after fixing to confirm.`);
		lines.push("");
	}

	return lines.join("\n").trim();
}

async function collectTouchedProjectRoots(pi: Pick<ExtensionAPI, "exec">, touchedPaths: Set<string>): Promise<string[]> {
	const roots = new Set<string>();
	const directories = new Set(Array.from(touchedPaths, (path) => dirname(path)));

	for (const directory of directories) {
		const root = await findProjectRoot(pi, directory);
		if (root) roots.add(root);
	}

	return Array.from(roots);
}

async function runVerification(pi: Pick<ExtensionAPI, "exec">, projectRoot: string): Promise<VerificationFailure | undefined> {
	const verifyScriptPath = join(projectRoot, VERIFY_SCRIPT_RELATIVE_PATH);
	if (!(await pathExists(verifyScriptPath))) return undefined;

	try {
		const result = await pi.exec("bash", [VERIFY_SCRIPT_RELATIVE_PATH], {
			cwd: projectRoot,
			timeout: VERIFY_TIMEOUT_MS,
		});
		if (result.code === 0) return undefined;
		return {
			projectRoot,
			errors: (result.stderr || result.stdout || "Verification failed").trim(),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			projectRoot,
			errors: message,
		};
	}
}

function parseSetupArgs(args: string): { reset: boolean; help: boolean } {
	const tokens = args
		.trim()
		.split(/\s+/)
		.filter(Boolean);

	return {
		reset: tokens.includes("--reset") || tokens.includes("--force"),
		help: tokens.includes("help") || tokens.includes("--help") || tokens.includes("-h"),
	};
}

function setupHelpText(): string {
	return [
		"Usage:",
		"  /setup-verify           # scaffold scripts/verify.sh if missing, then ask the agent to refine it",
		"  /setup-verify --reset   # replace scripts/verify.sh with a fresh starter template first",
	].join("\n");
}

function toSlashPath(path: string): string {
	return path.replace(/\\/g, "/");
}

function normalizePlanPath(projectRoot: string, rawPath: string): string {
	const stripped = normalizeToolPath(rawPath.trim());
	if (!stripped) return "";
	const absolute = resolve(projectRoot, stripped);
	const relativePath = toSlashPath(relative(projectRoot, absolute));
	return relativePath.startsWith("../") || relativePath === ".." ? toSlashPath(stripped) : relativePath;
}

async function readPackageScripts(projectRoot: string): Promise<Record<string, string>> {
	try {
		const raw = await readFile(join(projectRoot, "package.json"), "utf8");
		const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
		const scripts: Record<string, string> = {};
		for (const [name, command] of Object.entries(parsed.scripts ?? {})) {
			if (typeof command === "string") scripts[name] = command;
		}
		return scripts;
	} catch {
		return {};
	}
}

function scriptCommand(packageManager: PackageManager | undefined, script: string): string {
	return nodeScriptCommand(packageManager ?? "npm", script);
}

function inferScriptNamesFromPath(path: string): string[] {
	const parts = path.split("/").filter(Boolean);
	const names: string[] = [];
	if (parts[0] === "extensions" && parts[1]) names.push(`test:${parts[1]}`);
	if (parts[0] === "agents" && parts[1]) names.push(`test:${basename(parts[1], ".md")}`);
	return names;
}

function looksLikeCodePath(path: string): boolean {
	return /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|kt|rb|ex|exs)$/i.test(path);
}

function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}

async function inferVerificationCommands(projectRoot: string, template: DetectedProjectTemplate, paths: string[]): Promise<{ targeted: string[]; regression: string[]; notes: string[] }> {
	const notes: string[] = [];
	const targeted: string[] = [];
	const regression: string[] = [];
	const scripts = await readPackageScripts(projectRoot);
	const packageManager = template.kind === "node" ? template.packageManager : undefined;

	if (template.kind === "node") {
		for (const path of paths) {
			for (const script of inferScriptNamesFromPath(path)) {
				if (scripts[script]) targeted.push(scriptCommand(packageManager, script));
			}
		}

		if (targeted.length === 0 && paths.some(looksLikeCodePath)) {
			if (scripts["test:direct"]) targeted.push(scriptCommand(packageManager, "test:direct"));
			else if (scripts.test) targeted.push(scriptCommand(packageManager, "test"));
		}
	} else if (paths.some(looksLikeCodePath)) {
		targeted.push(...getTemplateCommands(template).quick);
	}

	if (await pathExists(join(projectRoot, VERIFY_SCRIPT_RELATIVE_PATH))) {
		regression.push(`bash ${VERIFY_SCRIPT_RELATIVE_PATH}`);
	} else if (template.kind === "node" && scripts.test) {
		regression.push(scriptCommand(packageManager, "test"));
	} else if (template.kind !== "generic") {
		regression.push(...getTemplateCommands(template).full);
	}

	if (targeted.length === 0) notes.push("No targeted automated command was inferred from repo scripts and paths; inspect nearby tests or CI before editing.");
	if (regression.length === 0) notes.push("No final regression gate was found; consider running /setup-verify before implementation.");

	return { targeted: unique(targeted), regression: unique(regression), notes };
}

function inferPreChangeChecks(task: string): string[] {
	if (!/\b(fix|bug|regression|fail|failing|broken|error|crash|repro|reproduce)\b/i.test(task)) return [];
	return ["Reproduce the failing behavior before editing, then keep the same command/input as the post-fix proof."];
}

function inferEdgeCases(task: string, paths: string[]): string[] {
	const lower = `${task} ${paths.join(" ")}`.toLowerCase();
	const cases: string[] = [];
	if (/\b(api|endpoint|webhook|http|request|response)\b/.test(lower)) cases.push("Exercise at least one invalid or boundary request payload and verify the response/status is explicit.");
	if (/\b(cli|command|script|args?|flag)\b/.test(lower)) cases.push("Run the CLI/command with one valid input and one invalid or missing argument.");
	if (/\b(ui|tui|editor|modal|browser|review|shortcut|key)\b/.test(lower)) cases.push("Check focus transitions, visible state changes, and keyboard fallback behavior for the interactive path.");
	if (/\b(extension|tool|command|hook)\b/.test(lower) || paths.some((path) => path.startsWith("extensions/"))) cases.push("Verify the changed extension registers its command/tool/hook and handles missing or malformed input without crashing.");
	cases.push("Run one negative or no-op case to prove unchanged behavior remains stable.");
	return unique(cases).slice(0, 4);
}

function inferManualChecks(task: string, paths: string[]): string[] {
	const lower = `${task} ${paths.join(" ")}`.toLowerCase();
	const checks: string[] = [];
	if (/\b(ui|tui|editor|modal|browser|review|shortcut|key)\b/.test(lower)) checks.push("Manually exercise the visible interaction and compare the result to the expected UI state.");
	if (/\b(extension|tool|command|hook)\b/.test(lower) || paths.some((path) => path.startsWith("extensions/"))) checks.push("After tests pass, reload Pi and smoke-test the changed command/tool in a real session if the behavior is user-facing.");
	return unique(checks);
}

export async function buildVerificationPlan(projectRoot: string, template: DetectedProjectTemplate, input: VerificationPlanInput): Promise<VerificationPlan> {
	const rawPaths = [...(input.paths ?? []), ...(input.changedPaths ?? [])];
	const paths = unique(rawPaths.map((path) => normalizePlanPath(projectRoot, path)).filter(Boolean));
	const commands = await inferVerificationCommands(projectRoot, template, paths);
	return {
		projectRoot,
		task: input.task.trim(),
		paths,
		targetedCommands: commands.targeted,
		regressionCommands: commands.regression,
		preChangeChecks: inferPreChangeChecks(input.task),
		edgeCases: inferEdgeCases(input.task, paths),
		manualChecks: inferManualChecks(input.task, paths),
		notes: commands.notes,
	};
}

export function formatVerificationPlan(plan: VerificationPlan): string {
	const lines = ["## Verification Contract", "", `Task: ${plan.task || "(not specified)"}`, `Project root: ${plan.projectRoot}`];
	if (plan.paths.length > 0) lines.push(`Paths: ${plan.paths.join(", ")}`);
	lines.push("", "### Before editing");
	if (plan.preChangeChecks.length === 0) lines.push("- Define the expected behavior and any observable success signal before changing code.");
	else for (const check of plan.preChangeChecks) lines.push(`- ${check}`);
	lines.push("", "### Targeted automated checks");
	if (plan.targetedCommands.length === 0) lines.push("- No targeted command inferred; find or add the nearest meaningful test first.");
	else for (const command of plan.targetedCommands) lines.push(`- \`${command}\` → Expected: exits 0 and covers the changed behavior.`);
	lines.push("", "### Edge cases / experiments");
	for (const edgeCase of plan.edgeCases) lines.push(`- ${edgeCase}`);
	if (plan.manualChecks.length > 0) {
		lines.push("", "### Manual / E2E checks");
		for (const check of plan.manualChecks) lines.push(`- ${check}`);
	}
	lines.push("", "### Final regression gate");
	if (plan.regressionCommands.length === 0) lines.push("- No regression command inferred.");
	else for (const command of plan.regressionCommands) lines.push(`- \`${command}\` → Expected: exits 0.`);
	if (plan.notes.length > 0) {
		lines.push("", "### Notes");
		for (const note of plan.notes) lines.push(`- ${note}`);
	}
	return lines.join("\n");
}

function isDocsOnlyPrompt(prompt: string): boolean {
	const lower = prompt.toLowerCase();
	const docSignal = /\b(readme|docs?|markdown|wording|copy|typo|spelling|comment|comments)\b/.test(lower);
	const behaviorSignal = /\b(behavior|logic|runtime|api|endpoint|tool|command|extension|hook|test|fix|bug|feature)\b/.test(lower);
	return docSignal && !behaviorSignal;
}

export function shouldInjectVerificationPreflight(prompt: string): boolean {
	const lower = prompt.toLowerCase();
	if (!prompt.trim() || isDocsOnlyPrompt(prompt)) return false;
	if (/\b(verification_plan|verify-plan|verification contract|how should (i|we) verify)\b/.test(lower)) return false;
	return /\b(implement|add|build|create|update|change|fix|refactor|remove|delete|wire|support|ship)\b/.test(lower);
}

function verificationPreflightSystemPrompt(): string {
	return [
		"Verification preflight:",
		"For behavior-changing code, call `verification_plan` before editing to define targeted checks, expected results, edge cases, and the final regression gate.",
		"If likely files are unclear, use code_find/semantic_search first, then pass candidate paths to `verification_plan`.",
		"Skip only for docs-only/trivial changes, and state the exception briefly.",
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	const touchedPaths = new Set<string>();
	const touchedProjectRoots = new Set<string>();
	let lastSessionId: string | undefined;

	function clearTouchedState() {
		touchedPaths.clear();
		touchedProjectRoots.clear();
	}

	function syncSessionState(ctx: { sessionManager: { getSessionId(): string } }) {
		const sessionId = ctx.sessionManager.getSessionId();
		if (lastSessionId !== undefined && lastSessionId !== sessionId) {
			clearTouchedState();
		}
		lastSessionId = sessionId;
	}

	function resetSessionState(ctx?: { sessionManager: { getSessionId(): string } }) {
		clearTouchedState();
		lastSessionId = ctx?.sessionManager.getSessionId();
	}

	function noteTouchedPath(ctxCwd: string, toolPath: string | undefined) {
		if (!toolPath) return;
		touchedPaths.add(resolve(ctxCwd, normalizeToolPath(toolPath)));
	}

	pi.on("before_agent_start", async (event) => {
		if (!shouldInjectVerificationPreflight(event.prompt ?? "")) return;
		const systemPrompt = event.systemPrompt ?? "";
		return {
			systemPrompt: `${systemPrompt}${systemPrompt ? "\n\n" : ""}${verificationPreflightSystemPrompt()}`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		resetSessionState(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		resetSessionState(ctx);
	});

	pi.events.on(HANDOFF_SESSION_STARTED_EVENT, () => {
		resetSessionState();
	});

	pi.on("tool_call", async (event, ctx) => {
		syncSessionState(ctx);
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const input = event.input as { path?: string };
		noteTouchedPath(ctx.cwd, input.path);
	});

	pi.on("agent_end", async (_event, ctx) => {
		syncSessionState(ctx);
		if (!ctx.hasUI) return;

		const roots = new Set<string>(touchedProjectRoots);
		for (const root of await collectTouchedProjectRoots(pi, touchedPaths)) {
			roots.add(root);
		}
		clearTouchedState();
		if (roots.size === 0) return;

		const failures: VerificationFailure[] = [];
		for (const projectRoot of roots) {
			const failure = await runVerification(pi, projectRoot);
			if (failure) failures.push(failure);
		}
		if (failures.length === 0) return;

		pi.sendUserMessage(buildVerificationFailureMessage(failures), { deliverAs: "followUp" });
	});

	pi.registerTool({
		name: "verification_plan",
		label: "Verification Plan",
		description: "Build a preflight verification contract for a task before editing: targeted checks, expected results, edge cases, manual/E2E checks, and final regression gate.",
		promptSnippet: "Plan how to verify a behavior change before editing",
		promptGuidelines: [
			"Use verification_plan before editing when the task changes behavior.",
			"Use it to define targeted checks, expected results, edge cases, and the final regression gate.",
			"Pass likely paths from code_find or semantic_search when known so checks are repo-specific.",
			"For bug fixes, include a pre-change reproduction step when possible.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "The requested change or behavior to verify." }),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Known or likely files/directories affected by the task." })),
			changedPaths: Type.Optional(Type.Array(Type.String(), { description: "Already changed files, if any." })),
			behaviorChange: Type.Optional(Type.Boolean({ description: "Whether this is expected to change runtime behavior. Defaults to true." })),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Building verification contract from repo evidence" }], details: {} });
			const projectRoot = (await findProjectRoot(pi, ctx.cwd)) ?? resolve(ctx.cwd);
			const template = await detectProjectTemplate(projectRoot);
			const plan = await buildVerificationPlan(projectRoot, template, params as VerificationPlanInput);
			return {
				content: [{ type: "text" as const, text: formatVerificationPlan(plan) }],
				details: plan,
			};
		},
	});

	pi.registerCommand("verify-plan", {
		description: "Create a preflight verification contract for a task before editing",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!task) {
				ctx.ui.setEditorText("Usage: /verify-plan <task to implement or fix>");
				ctx.ui.notify("/verify-plan usage written to editor", "info");
				return;
			}
			const projectRoot = (await findProjectRoot(pi, ctx.cwd)) ?? resolve(ctx.cwd);
			const template = await detectProjectTemplate(projectRoot);
			const plan = await buildVerificationPlan(projectRoot, template, { task });
			ctx.ui.setEditorText(formatVerificationPlan(plan));
			ctx.ui.notify("Verification contract written to editor", "info");
		},
	});

	pi.registerCommand("setup-verify", {
		description: "Scaffold scripts/verify.sh and ask the agent to customize it for this repo",
		handler: async (args, ctx) => {
			const { reset, help } = parseSetupArgs(args);
			if (help) {
				ctx.ui.setEditorText(setupHelpText());
				ctx.ui.notify("/setup-verify help written to editor", "info");
				return;
			}

			const projectRoot = (await findProjectRoot(pi, ctx.cwd)) ?? resolve(ctx.cwd);
			const template = await detectProjectTemplate(projectRoot);
			const verifyScriptPath = join(projectRoot, VERIFY_SCRIPT_RELATIVE_PATH);
			const verifyScriptExists = await pathExists(verifyScriptPath);
			let mode: SetupMode = verifyScriptExists ? "existing" : "created";

			if (!verifyScriptExists || reset) {
				await mkdir(dirname(verifyScriptPath), { recursive: true });
				await writeFile(verifyScriptPath, buildVerifyScript(template), "utf8");
				await chmod(verifyScriptPath, 0o755);
				mode = verifyScriptExists ? "reset" : "created";
			}

			touchedProjectRoots.add(projectRoot);

			const prompt = buildSetupVerifyPrompt(projectRoot, template, mode);
			ctx.ui.notify(
				mode === "existing"
					? `Found ${VERIFY_SCRIPT_RELATIVE_PATH}; asking the agent to refine it`
					: `Prepared ${VERIFY_SCRIPT_RELATIVE_PATH}; asking the agent to customize it`,
				"info",
			);

			if (ctx.isIdle()) {
				pi.sendUserMessage(prompt);
			} else {
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			}
		},
	});
}
