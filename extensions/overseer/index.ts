import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { WARNING_EVENT, type WarningArchivePayload } from "../self-improvement-archive/index.ts";

const REPEATED_FAILURE_THRESHOLD = 2;
const LARGE_WRITE_CHARS = 50_000;
const LARGE_EDIT_CHARS = 50_000;

export type OverseerWarning = WarningArchivePayload & {
	severity: "info" | "warning";
};

type ToolResultLike = {
	toolName: string;
	isError?: boolean;
	content?: Array<{ text?: string }>;
};

type ToolCallLike = {
	toolName: string;
	input?: unknown;
};

function textFromToolResult(event: ToolResultLike): string {
	return (event.content ?? [])
		.map((part) => part.text)
		.filter((text): text is string => Boolean(text))
		.join("\n")
		.trim();
}

function compact(text: string, max = 240): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	return singleLine.length <= max ? singleLine : `${singleLine.slice(0, max)}…`;
}

function warningKey(warning: OverseerWarning): string {
	return `${warning.type}:${warning.toolName ?? "global"}`;
}

export function detectLargeMutation(event: ToolCallLike): OverseerWarning | undefined {
	const input = event.input as { content?: string; edits?: Array<{ oldText?: string; newText?: string }>; path?: string } | undefined;
	if (!input) return undefined;
	if (event.toolName === "write" && typeof input.content === "string" && input.content.length > LARGE_WRITE_CHARS) {
		return {
			type: "large-write",
			severity: "warning",
			toolName: event.toolName,
			message: `Large write to ${input.path ?? "unknown path"} (${input.content.length} chars). Prefer focused edit unless a full rewrite is intentional.`,
		};
	}
	if (event.toolName === "edit") {
		const largest = Math.max(0, ...(input.edits ?? []).map((edit) => Math.max(edit.oldText?.length ?? 0, edit.newText?.length ?? 0)));
		if (largest > LARGE_EDIT_CHARS) {
			return {
				type: "large-edit",
				severity: "warning",
				toolName: event.toolName,
				message: `Large edit to ${input.path ?? "unknown path"} (${largest} chars). Consider splitting into smaller exact replacements.`,
			};
		}
	}
	return undefined;
}

export function detectRepeatedFailure(
	event: ToolResultLike,
	counts: Map<string, number>,
): OverseerWarning | undefined {
	if (!event.isError) return undefined;
	const message = compact(textFromToolResult(event) || "tool failed", 120);
	const key = `${event.toolName}:${message}`;
	const count = (counts.get(key) ?? 0) + 1;
	counts.set(key, count);
	if (count < REPEATED_FAILURE_THRESHOLD) return undefined;
	return {
		type: "repeated-tool-error",
		severity: "warning",
		toolName: event.toolName,
		count,
		message: `${event.toolName} has failed ${count} times with the same error. Pause, narrow the repro/search, or ask oracle before retrying. Error: ${message}`,
	};
}

export default function overseerExtension(pi: ExtensionAPI) {
	const failureCounts = new Map<string, number>();
	const emittedWarnings = new Set<string>();

	function reset() {
		failureCounts.clear();
		emittedWarnings.clear();
	}

	function emitWarning(warning: OverseerWarning, ctx: { hasUI?: boolean; ui?: { notify?: (message: string, level: string) => void } }) {
		const key = warningKey(warning);
		if (emittedWarnings.has(key)) return;
		emittedWarnings.add(key);
		if (ctx.hasUI) ctx.ui?.notify?.(`Overseer: ${warning.message}`, warning.severity);
		pi.events?.emit?.(WARNING_EVENT, { ...warning, timestamp: new Date().toISOString() });
	}

	pi.on("session_start", async () => reset());
	pi.on("session_shutdown", async () => reset());

	pi.on("tool_call", async (event, ctx) => {
		const warning = detectLargeMutation(event as ToolCallLike);
		if (warning) emitWarning(warning, ctx);
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		const warning = detectRepeatedFailure(event as ToolResultLike, failureCounts);
		if (warning) emitWarning(warning, ctx);
		return undefined;
	});

	pi.registerCommand("overseer-status", {
		description: "Show warning-only overseer state for this session",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`Overseer warning-only mode: ${emittedWarnings.size} warning(s) emitted this session`, "info");
		},
	});
}
