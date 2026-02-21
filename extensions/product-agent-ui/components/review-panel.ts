import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import type {
	ProductReviewChecklistItem,
	ProductReviewData,
	ProductReviewFileItem,
	ReviewChecklistStatus,
	ReviewFileStatus,
} from "../services/review-service.js";

export interface ReviewPanelRenderParams {
	theme: Theme;
	width: number;
	result: ProductReviewData;
	selectedPath?: string;
}

export function renderReviewPanel(params: ReviewPanelRenderParams): string[] {
	const { theme, width, result, selectedPath } = params;
	const lines: string[] = [];

	lines.push(truncateToWidth(theme.fg("accent", theme.bold("Review")), width));
	lines.push(
		truncateToWidth(
			theme.fg("muted", `Changed files: ${result.files.length} · statuses A/M/D`),
			width,
		),
	);
	lines.push(truncateToWidth(theme.fg("dim", "Use ↑/↓ (or j/k) to select · o open · d diff · e edit"), width));

	if (result.warning) {
		for (const warning of result.warning.split(" | ")) {
			const safeWarning = sanitizeDisplayText(warning);
			if (!safeWarning) continue;
			lines.push(truncateToWidth(theme.fg("warning", `⚠ ${safeWarning}`), width));
		}
	}

	lines.push("");
	lines.push(truncateToWidth(theme.fg("border", "Git changes"), width));
	if (result.files.length === 0) {
		lines.push(truncateToWidth(theme.fg("dim", "  No changed files found in working tree."), width));
	} else {
		for (const file of result.files) {
			lines.push(
				truncateToWidth(
					formatReviewFileRow({
						theme,
						file,
						selected: file.path === selectedPath,
					}),
					width,
				),
			);
		}
	}

	lines.push("");
	lines.push(truncateToWidth(theme.fg("border", "Pre-ship checklist"), width));
	for (const item of result.checklist) {
		lines.push(truncateToWidth(formatChecklistItem(theme, item), width));
	}

	return lines;
}

function formatReviewFileRow(options: {
	theme: Theme;
	file: ProductReviewFileItem;
	selected: boolean;
}): string {
	const { theme, file, selected } = options;
	const marker = selected ? theme.fg("accent", "▸") : "•";
	const statusLabel = formatReviewStatus(theme, file.status);
	const safePath = sanitizeDisplayText(file.path);
	const rowContent = `${statusLabel} ${safePath}`;
	const styledContent = selected ? theme.fg("accent", rowContent) : rowContent;
	return `  ${marker} ${styledContent}`;
}

function formatChecklistItem(theme: Theme, item: ProductReviewChecklistItem): string {
	const icon = formatChecklistIcon(theme, item.status);
	const label = sanitizeDisplayText(item.label);
	const detail = sanitizeDisplayText(item.detail);
	return `  ${icon} ${label} ${theme.fg("dim", `— ${detail}`)}`;
}

function formatChecklistIcon(theme: Theme, status: ReviewChecklistStatus): string {
	switch (status) {
		case "pass":
			return theme.fg("success", "✓");
		case "warn":
			return theme.fg("warning", "!");
		case "fail":
			return theme.fg("error", "✗");
		case "manual":
		default:
			return theme.fg("dim", "○");
	}
}

function formatReviewStatus(theme: Theme, status: ReviewFileStatus): string {
	switch (status) {
		case "A":
			return theme.fg("success", "A");
		case "M":
			return theme.fg("warning", "M");
		case "D":
			return theme.fg("error", "D");
		default:
			return status;
	}
}

function sanitizeDisplayText(value: string): string {
	return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
}
