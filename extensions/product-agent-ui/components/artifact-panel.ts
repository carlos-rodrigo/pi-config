import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import type { ProductArtifactItem } from "../services/artifact-service.js";

const DEFAULT_PREVIEW_LINES = 14;
const COMPACT_PREVIEW_LINES = 6;
const PREVIEW_LINES_CACHE_LIMIT = 8;
const previewLinesCache = new Map<string, string[]>();

export interface ArtifactPanelRenderParams {
	theme: Theme;
	width: number;
	artifact: ProductArtifactItem;
	compact?: boolean;
}

export function renderArtifactPanel(params: ArtifactPanelRenderParams): string[] {
	const { theme, width, artifact, compact = false } = params;
	const lines: string[] = [];

	lines.push(truncateToWidth(theme.fg("accent", theme.bold(`${artifact.label} artifact`)), width));
	lines.push(truncateToWidth(theme.fg("muted", `Path: ${artifact.path}`), width));
	lines.push(
		truncateToWidth(
			theme.fg("dim", buildActionsLine(artifact)),
			width,
		),
	);

	if (artifact.warning) {
		lines.push(truncateToWidth(theme.fg("warning", `⚠ ${sanitizeDisplayText(artifact.warning)}`), width));
	}

	lines.push("");

	if (!artifact.exists) {
		lines.push(
			truncateToWidth(
				theme.fg("dim", "Artifact file is missing. Press c to compose/refine it with the linked skill."),
				width,
			),
		);
		return lines;
	}

	lines.push(truncateToWidth(theme.fg("border", "Preview"), width));
	const previewLines = getPreviewLines(artifact.content, compact ? COMPACT_PREVIEW_LINES : DEFAULT_PREVIEW_LINES);

	if (previewLines.lines.length === 0) {
		lines.push(truncateToWidth(theme.fg("dim", "  (empty file)"), width));
	} else {
		for (const previewLine of previewLines.lines) {
			const safeLine = sanitizeDisplayText(previewLine);
			const contentLine = safeLine.length > 0 ? `  ${safeLine}` : "  ";
			lines.push(truncateToWidth(contentLine, width));
		}
	}

	if (previewLines.remainingLineCount > 0) {
		lines.push(
			truncateToWidth(
				theme.fg("dim", `  … ${previewLines.remainingLineCount} more line${previewLines.remainingLineCount === 1 ? "" : "s"}`),
				width,
			),
		);
	}

	return lines;
}

function buildActionsLine(artifact: ProductArtifactItem): string {
	const fileActionHint = artifact.stage === "tasks" ? "O open · D diff · E edit" : "o open · d diff · e edit";
	return `Actions: c compose/refine (${artifact.composeCommand}) · ${fileActionHint}`;
}

function getPreviewLines(content: string, maxLines: number): {
	lines: string[];
	remainingLineCount: number;
} {
	const allLines = getCachedLines(content);
	const lines = allLines.slice(0, maxLines);
	const remainingLineCount = Math.max(0, allLines.length - lines.length);

	return {
		lines,
		remainingLineCount,
	};
}

function getCachedLines(content: string): string[] {
	const cached = previewLinesCache.get(content);
	if (cached) {
		return cached;
	}

	const normalized = content.replace(/\r\n/g, "\n");
	const allLines = normalized.split("\n");
	const normalizedLines = allLines.length === 1 && allLines[0] === "" ? [] : allLines;
	previewLinesCache.set(content, normalizedLines);
	evictOldestPreviewCacheEntry();
	return normalizedLines;
}

function evictOldestPreviewCacheEntry(): void {
	if (previewLinesCache.size <= PREVIEW_LINES_CACHE_LIMIT) return;
	const oldestKey = previewLinesCache.keys().next().value;
	if (oldestKey !== undefined) {
		previewLinesCache.delete(oldestKey);
	}
}

function sanitizeDisplayText(value: string): string {
	return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trimEnd();
}
