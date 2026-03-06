import type { CommentThread } from "./repository.js";

const EMPTY_EXPORT_TEXT = "No comments to export yet.";

export interface PlainTextReviewExport {
	text: string;
	count: number;
}

export function compilePlainTextReviewExport(threads: readonly CommentThread[]): PlainTextReviewExport {
	const normalizedThreads = Array.isArray(threads) ? [...threads] : [];
	const lines: string[] = [];

	normalizedThreads.sort((left, right) => Number(left?.createdAt ?? 0) - Number(right?.createdAt ?? 0));

	for (const thread of normalizedThreads) {
		if (!thread || typeof thread !== "object") continue;
		const comments = Array.isArray(thread.comments) ? thread.comments : [];
		if (comments.length === 0) continue;

		const anchorLabel = formatAnchorLabel(thread.anchor?.exact ?? thread.anchor?.quote ?? "", thread.stale === true);
		for (const comment of comments) {
			const body = normalizeInlineText(comment?.body ?? "");
			if (!body) continue;
			lines.push(`- [${anchorLabel}] ${body}`);
		}
	}

	if (lines.length === 0) {
		return {
			text: EMPTY_EXPORT_TEXT,
			count: 0,
		};
	}

	return {
		text: lines.join("\n"),
		count: lines.length,
	};
}

function formatAnchorLabel(rawAnchor: string, stale: boolean): string {
	const normalizedAnchor = normalizeInlineText(rawAnchor);
	const snippet = normalizedAnchor ? truncate(normalizedAnchor, 90) : "(anchor unavailable)";
	if (stale) {
		return `stale anchor: ${snippet}`;
	}
	return `anchor: ${snippet}`;
}

function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function normalizeInlineText(value: string): string {
	return String(value).replace(/\s+/g, " ").trim();
}
