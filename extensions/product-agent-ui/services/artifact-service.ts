import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ProductStageId } from "../types.js";

export type ProductArtifactStage = "plan" | "design" | "tasks";

export type ProductArtifactComposeCommand = "/skill:prd" | "/skill:design-solution" | "/skill:simple-tasks";

export interface ProductArtifactItem {
	stage: ProductArtifactStage;
	label: string;
	path: string;
	composeCommand: ProductArtifactComposeCommand;
	exists: boolean;
	content: string;
	warning?: string;
}

export interface ProductArtifactLoadResult {
	featureName: string;
	artifacts: Record<ProductArtifactStage, ProductArtifactItem>;
	warning?: string;
}

const ARTIFACT_STAGES: ProductArtifactStage[] = ["plan", "design", "tasks"];
const MAX_ARTIFACT_BYTES = 128 * 1024;

const ARTIFACT_STAGE_CONFIG: Record<
	ProductArtifactStage,
	{
		label: string;
		relativePath: string;
		composeCommand: ProductArtifactComposeCommand;
	}
> = {
	plan: {
		label: "PRD",
		relativePath: "prd.md",
		composeCommand: "/skill:prd",
	},
	design: {
		label: "Design",
		relativePath: "design.md",
		composeCommand: "/skill:design-solution",
	},
	tasks: {
		label: "Tasks",
		relativePath: "tasks/_active.md",
		composeCommand: "/skill:simple-tasks",
	},
};

export async function loadProductArtifacts(options: {
	projectRoot: string;
	featureName: string;
}): Promise<ProductArtifactLoadResult> {
	const { projectRoot, featureName } = options;
	const featuresRoot = path.resolve(projectRoot, ".features");
	const featureRoot = path.resolve(featuresRoot, featureName);
	const warnings: string[] = [];

	if (!isValidFeatureName(featureName) || !isPathWithinRoot(featuresRoot, featureRoot)) {
		const warning = `Invalid feature name: ${featureName}`;
		return {
			featureName,
			artifacts: createFallbackArtifactMap(featureName, warning),
			warning,
		};
	}

	const [featuresRootRealPath, featureRootRealPath] = await Promise.all([
		resolveRealPathIfExists(featuresRoot),
		resolveRealPathIfExists(featureRoot),
	]);

	if (featuresRootRealPath && featureRootRealPath && !isPathWithinRoot(featuresRootRealPath, featureRootRealPath)) {
		const warning = `Feature directory resolves outside .features: ${featureName}`;
		return {
			featureName,
			artifacts: createFallbackArtifactMap(featureName, warning),
			warning,
		};
	}

	const stageArtifacts = await Promise.all(
		ARTIFACT_STAGES.map(async (stage) => {
			const stageArtifact = await loadStageArtifact({
				projectRoot,
				featureName,
				featureRoot,
				featureRootRealPath,
				stage,
			});
			return [stage, stageArtifact] as const;
		}),
	);

	const artifacts = {} as Record<ProductArtifactStage, ProductArtifactItem>;
	for (const [stage, stageArtifact] of stageArtifacts) {
		artifacts[stage] = stageArtifact;
		if (stageArtifact.warning) {
			warnings.push(stageArtifact.warning);
		}
	}

	return {
		featureName,
		artifacts,
		warning: warnings.length > 0 ? warnings.join(" | ") : undefined,
	};
}

export function getArtifactForStage(
	result: ProductArtifactLoadResult,
	stage: ProductStageId,
): ProductArtifactItem | undefined {
	if (!isArtifactStage(stage)) return undefined;
	return result.artifacts[stage];
}

export function isArtifactStage(stage: ProductStageId): stage is ProductArtifactStage {
	return stage === "plan" || stage === "design" || stage === "tasks";
}

async function loadStageArtifact(options: {
	projectRoot: string;
	featureName: string;
	featureRoot: string;
	featureRootRealPath?: string;
	stage: ProductArtifactStage;
}): Promise<ProductArtifactItem> {
	const { projectRoot, featureName, featureRoot, featureRootRealPath, stage } = options;
	const config = ARTIFACT_STAGE_CONFIG[stage];
	const absolutePath = path.resolve(featureRoot, config.relativePath);
	const relativePath = toPosixPath(path.relative(projectRoot, absolutePath));

	if (!isPathWithinRoot(featureRoot, absolutePath)) {
		return {
			stage,
			label: config.label,
			path: relativePath,
			composeCommand: config.composeCommand,
			exists: false,
			content: "",
			warning: `Invalid artifact path for ${config.label}: ${relativePath}`,
		};
	}

	let resolvedArtifactPath: string;
	try {
		resolvedArtifactPath = await realpath(absolutePath);
	} catch (error) {
		const missingFileWarning = hasErrnoCode(error, "ENOENT")
			? `${config.label} artifact missing for ${featureName}: ${relativePath}`
			: `Could not resolve ${config.label} artifact (${relativePath}): ${toErrorMessage(error)}`;

		return {
			stage,
			label: config.label,
			path: relativePath,
			composeCommand: config.composeCommand,
			exists: false,
			content: "",
			warning: missingFileWarning,
		};
	}

	if (featureRootRealPath && !isPathWithinRoot(featureRootRealPath, resolvedArtifactPath)) {
		return {
			stage,
			label: config.label,
			path: relativePath,
			composeCommand: config.composeCommand,
			exists: false,
			content: "",
			warning: `Resolved ${config.label} artifact is outside feature root: ${relativePath}`,
		};
	}

	try {
		const readResult = await readTextFileWithSizeCap(resolvedArtifactPath, MAX_ARTIFACT_BYTES);
		const truncatedWarning = readResult.truncated
			? `${config.label} artifact preview truncated at ${MAX_ARTIFACT_BYTES} bytes: ${relativePath}`
			: undefined;

		return {
			stage,
			label: config.label,
			path: relativePath,
			composeCommand: config.composeCommand,
			exists: true,
			content: readResult.content,
			warning: truncatedWarning,
		};
	} catch (error) {
		return {
			stage,
			label: config.label,
			path: relativePath,
			composeCommand: config.composeCommand,
			exists: false,
			content: "",
			warning: `Could not read ${config.label} artifact (${relativePath}): ${toErrorMessage(error)}`,
		};
	}
}

async function readTextFileWithSizeCap(filePath: string, maxBytes: number): Promise<{ content: string; truncated: boolean }> {
	const fileStat = await stat(filePath);
	if (!fileStat.isFile()) {
		throw new Error(`Expected a file but found a non-file path: ${filePath}`);
	}

	const bytesToRead = Math.min(fileStat.size, maxBytes);
	const fileHandle = await open(filePath, "r");
	try {
		if (bytesToRead <= 0) {
			return {
				content: "",
				truncated: false,
			};
		}

		const buffer = Buffer.alloc(bytesToRead);
		const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, 0);
		return {
			content: buffer.toString("utf8", 0, bytesRead),
			truncated: fileStat.size > maxBytes,
		};
	} finally {
		await fileHandle.close();
	}
}

function createFallbackArtifactMap(featureName: string, warning: string): Record<ProductArtifactStage, ProductArtifactItem> {
	const artifacts = {} as Record<ProductArtifactStage, ProductArtifactItem>;
	for (const stage of ARTIFACT_STAGES) {
		const config = ARTIFACT_STAGE_CONFIG[stage];
		const relativePath = toPosixPath(path.join(".features", featureName, config.relativePath));
		artifacts[stage] = {
			stage,
			label: config.label,
			path: relativePath,
			composeCommand: config.composeCommand,
			exists: false,
			content: "",
			warning,
		};
	}
	return artifacts;
}

function isValidFeatureName(featureName: string): boolean {
	if (!featureName) return false;
	if (featureName.includes("/") || featureName.includes("\\") || featureName.includes("..")) {
		return false;
	}
	return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(featureName);
}

async function resolveRealPathIfExists(targetPath: string): Promise<string | undefined> {
	try {
		return await realpath(targetPath);
	} catch (error) {
		if (hasErrnoCode(error, "ENOENT")) {
			return undefined;
		}
		throw error;
	}
}

function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
	const relativePath = path.relative(rootPath, candidatePath);
	if (relativePath.length === 0) return true;
	return !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function hasErrnoCode(error: unknown, code: string): boolean {
	if (!isRecord(error)) return false;
	return error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function toPosixPath(value: string): string {
	return value.split(path.sep).join("/");
}
