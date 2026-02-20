import { realpathSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TaskFileActionMode } from "../types.js";
import type { ProductArtifactStage } from "./artifact-service.js";

export type DispatchPathValidationResult =
	| { ok: true; path: string }
	| {
			ok: false;
			reason: string;
	  };

export type DispatchActionResult =
	| { ok: true }
	| {
			ok: false;
			reason: string;
	  };

export function validateTaskPathForDispatch(options: {
	ctx: ExtensionContext;
	featureName: string;
	taskPath: string;
}): DispatchPathValidationResult {
	const { ctx, featureName, taskPath } = options;

	return validateFeaturePathForDispatch({
		ctx,
		featureName,
		relativePath: taskPath,
		expectedPrefix: `.features/${featureName}/tasks/`,
		expectedRoot: path.resolve(ctx.cwd, ".features", featureName, "tasks"),
		errorScope: "task",
	});
}

export function validateArtifactPathForDispatch(options: {
	ctx: ExtensionContext;
	featureName: string;
	artifactPath: string;
}): DispatchPathValidationResult {
	const { ctx, featureName, artifactPath } = options;

	return validateFeaturePathForDispatch({
		ctx,
		featureName,
		relativePath: artifactPath,
		expectedPrefix: `.features/${featureName}/`,
		expectedRoot: path.resolve(ctx.cwd, ".features", featureName),
		errorScope: "artifact",
	});
}

export function dispatchOpenFileAction(options: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	mode: TaskFileActionMode;
	path: string;
}): void {
	const { pi, ctx, mode } = options;
	const filePath = sanitizeDisplayText(options.path);
	const command = mode === "diff" ? `/open ${filePath} --diff` : `/open ${filePath}`;

	dispatchUserMessage(pi, ctx, command);

	if (mode === "edit") {
		ctx.ui.notify(`Opening ${filePath} in viewer. Press e in the viewer to open nvim.`, "info");
		return;
	}

	const actionLabel = mode === "diff" ? "Diff queued" : "Open queued";
	ctx.ui.notify(`${actionLabel}: ${filePath}`, "info");
}

export function dispatchArtifactComposeAction(options: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	featureName: string;
	stage: ProductArtifactStage;
}): DispatchActionResult {
	const { pi, ctx, featureName, stage } = options;
	if (!isValidFeatureName(featureName)) {
		return {
			ok: false,
			reason: `Invalid feature name: ${featureName}`,
		};
	}

	const composeCommand = buildArtifactComposeCommand(stage, featureName);
	dispatchUserMessage(pi, ctx, composeCommand);
	ctx.ui.notify(`Compose/refine queued via ${getComposeCommandLabel(stage)}.`, "info");
	return { ok: true };
}

function validateFeaturePathForDispatch(options: {
	ctx: ExtensionContext;
	featureName: string;
	relativePath: string;
	expectedPrefix: string;
	expectedRoot: string;
	errorScope: "task" | "artifact";
}): DispatchPathValidationResult {
	const { ctx, featureName, relativePath, expectedPrefix, expectedRoot, errorScope } = options;

	if (!isValidFeatureName(featureName)) {
		return {
			ok: false,
			reason: `Invalid feature name: ${featureName}`,
		};
	}

	const sanitizedPath = sanitizeDisplayText(relativePath);
	if (!sanitizedPath || sanitizedPath !== relativePath) {
		return {
			ok: false,
			reason: `Selected ${errorScope} path contains unsupported characters.`,
		};
	}

	if (sanitizedPath.includes("--diff") || sanitizedPath.includes("--edit") || sanitizedPath.includes("--")) {
		return {
			ok: false,
			reason: `Selected ${errorScope} path contains reserved flag text.`,
		};
	}

	if (!/^[a-zA-Z0-9._/-]+$/.test(sanitizedPath)) {
		return {
			ok: false,
			reason: `Selected ${errorScope} path has unsupported characters for dispatch.`,
		};
	}

	if (sanitizedPath.startsWith("/") || sanitizedPath.startsWith("\\") || sanitizedPath.includes("..")) {
		return {
			ok: false,
			reason: `Selected ${errorScope} path is not a safe relative path.`,
		};
	}

	if (!sanitizedPath.startsWith(expectedPrefix)) {
		return {
			ok: false,
			reason: `Selected ${errorScope} path is outside the active feature directory.`,
		};
	}

	const resolvedCandidate = path.resolve(ctx.cwd, sanitizedPath);
	let projectRootRealPath = ctx.cwd;
	let expectedRootRealPath = expectedRoot;
	let candidateRealPath = resolvedCandidate;

	try {
		projectRootRealPath = realpathSync(ctx.cwd);
		expectedRootRealPath = realpathSync(expectedRoot);
		candidateRealPath = realpathSync(resolvedCandidate);
	} catch {
		return {
			ok: false,
			reason: `Selected ${errorScope} file could not be resolved from disk.`,
		};
	}

	if (!isPathWithinRoot(projectRootRealPath, expectedRootRealPath)) {
		return {
			ok: false,
			reason: `Active feature directory resolves outside the project root.`,
		};
	}

	if (!isPathWithinRoot(expectedRootRealPath, candidateRealPath)) {
		return {
			ok: false,
			reason: `Selected ${errorScope} file resolved outside the active feature directory.`,
		};
	}

	return {
		ok: true,
		path: sanitizedPath,
	};
}

function dispatchUserMessage(pi: ExtensionAPI, ctx: ExtensionContext, message: string): void {
	if (ctx.isIdle()) {
		pi.sendUserMessage(message);
		return;
	}
	pi.sendUserMessage(message, { deliverAs: "followUp" });
}

function buildArtifactComposeCommand(stage: ProductArtifactStage, featureName: string): string {
	const featureRoot = `.features/${featureName}`;

	switch (stage) {
		case "plan":
			return `/skill:prd Compose or refine the PRD for feature ${featureName}. Write the result to ${featureRoot}/prd.md.`;
		case "design":
			return `/skill:design-solution Compose or refine the technical design for feature ${featureName}. Read ${featureRoot}/prd.md and write ${featureRoot}/design.md.`;
		case "tasks":
			return `/skill:simple-tasks Compose or refine tasks for feature ${featureName}. Write task files under ${featureRoot}/tasks/ and update ${featureRoot}/tasks/_active.md.`;
		default:
			return `/skill:prd Compose artifacts for feature ${featureName}.`;
	}
}

function getComposeCommandLabel(stage: ProductArtifactStage): string {
	switch (stage) {
		case "plan":
			return "/skill:prd";
		case "design":
			return "/skill:design-solution";
		case "tasks":
			return "/skill:simple-tasks";
		default:
			return "/skill:prd";
	}
}

function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
	const relativePath = path.relative(rootPath, candidatePath);
	if (relativePath.length === 0) return true;
	return !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function sanitizeDisplayText(value: string): string {
	return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
}

function isValidFeatureName(featureName: string): boolean {
	if (!featureName) return false;
	if (featureName.includes("/") || featureName.includes("\\") || featureName.includes("..")) {
		return false;
	}
	return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(featureName);
}
