import { readFile } from "node:fs/promises";
import path from "node:path";

export const PRODUCT_AGENT_POLICY_FILE = ".pi/product-agent-policy.json";

export type ProductAgentPolicyMode = "strict" | "soft" | "mixed";

export interface ProductAgentPolicy {
	version: 1;
	mode: ProductAgentPolicyMode;
	gates: {
		planApprovalRequired: boolean;
		designApprovalRequired: boolean;
		tasksApprovalRequired: boolean;
		reviewRequired: boolean;
	};
	execution: {
		autoRunLoop: boolean;
		stopOnFailedChecks: boolean;
		stopOnUncertainty: boolean;
		maxConsecutiveTasks?: number;
	};
}

export type PolicyWarningCode = "file-read-error" | "invalid-json" | "invalid-schema";

export interface PolicyWarning {
	code: PolicyWarningCode;
	message: string;
}

export interface PolicyLoadResult {
	policy: ProductAgentPolicy;
	source: "default" | "project-file";
	policyPath: string;
	warning?: PolicyWarning;
}

export const STRICT_DEFAULT_PRODUCT_POLICY: ProductAgentPolicy = {
	version: 1,
	mode: "strict",
	gates: {
		planApprovalRequired: true,
		designApprovalRequired: true,
		tasksApprovalRequired: true,
		reviewRequired: true,
	},
	execution: {
		autoRunLoop: true,
		stopOnFailedChecks: true,
		stopOnUncertainty: true,
	},
};

interface ValidationSuccess {
	ok: true;
	policy: ProductAgentPolicy;
}

interface ValidationFailure {
	ok: false;
	error: string;
}

type PolicyValidationResult = ValidationSuccess | ValidationFailure;

export async function loadProductAgentPolicy(options: { projectRoot?: string } = {}): Promise<PolicyLoadResult> {
	const projectRoot = options.projectRoot ?? process.cwd();
	const policyPath = path.resolve(projectRoot, PRODUCT_AGENT_POLICY_FILE);

	let rawPolicy = "";
	try {
		rawPolicy = await readFile(policyPath, "utf8");
	} catch (error) {
		if (hasErrnoCode(error, "ENOENT")) {
			return {
				policy: cloneStrictDefaultPolicy(),
				source: "default",
				policyPath,
			};
		}

		return {
			policy: cloneStrictDefaultPolicy(),
			source: "default",
			policyPath,
			warning: {
				code: "file-read-error",
				message: `Could not read policy file (${policyPath}). Using strict defaults. ${toErrorMessage(error)}`,
			},
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawPolicy);
	} catch (error) {
		return {
			policy: cloneStrictDefaultPolicy(),
			source: "default",
			policyPath,
			warning: {
				code: "invalid-json",
				message: `Policy JSON is invalid at ${policyPath}. Using strict defaults. ${toErrorMessage(error)}`,
			},
		};
	}

	const validationResult = validateProductAgentPolicy(parsed);
	if (!validationResult.ok) {
		return {
			policy: cloneStrictDefaultPolicy(),
			source: "default",
			policyPath,
			warning: {
				code: "invalid-schema",
				message: `${validationResult.error} Using strict defaults from built-in policy.`,
			},
		};
	}

	return {
		policy: validationResult.policy,
		source: "project-file",
		policyPath,
	};
}

export function validateProductAgentPolicy(value: unknown): PolicyValidationResult {
	if (!isRecord(value)) {
		return {
			ok: false,
			error: "Policy must be a JSON object.",
		};
	}

	if (value.version !== 1) {
		return {
			ok: false,
			error: "Policy field `version` must be exactly 1.",
		};
	}

	if (!isPolicyMode(value.mode)) {
		return {
			ok: false,
			error: "Policy field `mode` must be one of: strict, soft, mixed.",
		};
	}

	if (!isRecord(value.gates)) {
		return {
			ok: false,
			error: "Policy field `gates` must be an object.",
		};
	}

	if (typeof value.gates.planApprovalRequired !== "boolean") {
		return {
			ok: false,
			error: "Policy field `gates.planApprovalRequired` must be a boolean.",
		};
	}

	if (typeof value.gates.designApprovalRequired !== "boolean") {
		return {
			ok: false,
			error: "Policy field `gates.designApprovalRequired` must be a boolean.",
		};
	}

	if (typeof value.gates.tasksApprovalRequired !== "boolean") {
		return {
			ok: false,
			error: "Policy field `gates.tasksApprovalRequired` must be a boolean.",
		};
	}

	if (typeof value.gates.reviewRequired !== "boolean") {
		return {
			ok: false,
			error: "Policy field `gates.reviewRequired` must be a boolean.",
		};
	}

	if (!isRecord(value.execution)) {
		return {
			ok: false,
			error: "Policy field `execution` must be an object.",
		};
	}

	if (typeof value.execution.autoRunLoop !== "boolean") {
		return {
			ok: false,
			error: "Policy field `execution.autoRunLoop` must be a boolean.",
		};
	}

	if (typeof value.execution.stopOnFailedChecks !== "boolean") {
		return {
			ok: false,
			error: "Policy field `execution.stopOnFailedChecks` must be a boolean.",
		};
	}

	if (typeof value.execution.stopOnUncertainty !== "boolean") {
		return {
			ok: false,
			error: "Policy field `execution.stopOnUncertainty` must be a boolean.",
		};
	}

	const maxConsecutiveTasks = value.execution.maxConsecutiveTasks;
	if (maxConsecutiveTasks !== undefined) {
		if (
			typeof maxConsecutiveTasks !== "number" ||
			!Number.isInteger(maxConsecutiveTasks) ||
			maxConsecutiveTasks < 1
		) {
			return {
				ok: false,
				error: "Policy field `execution.maxConsecutiveTasks`, when present, must be an integer >= 1.",
			};
		}
	}

	const policy: ProductAgentPolicy = {
		version: 1,
		mode: value.mode,
		gates: {
			planApprovalRequired: value.gates.planApprovalRequired,
			designApprovalRequired: value.gates.designApprovalRequired,
			tasksApprovalRequired: value.gates.tasksApprovalRequired,
			reviewRequired: value.gates.reviewRequired,
		},
		execution: {
			autoRunLoop: value.execution.autoRunLoop,
			stopOnFailedChecks: value.execution.stopOnFailedChecks,
			stopOnUncertainty: value.execution.stopOnUncertainty,
		},
	};

	if (typeof maxConsecutiveTasks === "number") {
		policy.execution.maxConsecutiveTasks = maxConsecutiveTasks;
	}

	return {
		ok: true,
		policy,
	};
}

function cloneStrictDefaultPolicy(): ProductAgentPolicy {
	const execution: ProductAgentPolicy["execution"] = {
		autoRunLoop: STRICT_DEFAULT_PRODUCT_POLICY.execution.autoRunLoop,
		stopOnFailedChecks: STRICT_DEFAULT_PRODUCT_POLICY.execution.stopOnFailedChecks,
		stopOnUncertainty: STRICT_DEFAULT_PRODUCT_POLICY.execution.stopOnUncertainty,
	};

	if (STRICT_DEFAULT_PRODUCT_POLICY.execution.maxConsecutiveTasks !== undefined) {
		execution.maxConsecutiveTasks = STRICT_DEFAULT_PRODUCT_POLICY.execution.maxConsecutiveTasks;
	}

	return {
		version: STRICT_DEFAULT_PRODUCT_POLICY.version,
		mode: STRICT_DEFAULT_PRODUCT_POLICY.mode,
		gates: {
			planApprovalRequired: STRICT_DEFAULT_PRODUCT_POLICY.gates.planApprovalRequired,
			designApprovalRequired: STRICT_DEFAULT_PRODUCT_POLICY.gates.designApprovalRequired,
			tasksApprovalRequired: STRICT_DEFAULT_PRODUCT_POLICY.gates.tasksApprovalRequired,
			reviewRequired: STRICT_DEFAULT_PRODUCT_POLICY.gates.reviewRequired,
		},
		execution,
	};
}

function isPolicyMode(mode: unknown): mode is ProductAgentPolicyMode {
	return mode === "strict" || mode === "soft" || mode === "mixed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasErrnoCode(error: unknown, code: string): boolean {
	if (!isRecord(error)) return false;
	return error.code === code;
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
