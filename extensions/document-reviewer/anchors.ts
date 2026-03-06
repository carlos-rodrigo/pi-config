export interface CommentAnchor {
	exact: string;
	startOffset?: number;
	endOffset?: number;
	prefix?: string;
	suffix?: string;
}

export interface ReanchoredAnchor {
	anchor: CommentAnchor;
	stale: boolean;
}

const CONTEXT_WINDOW = 64;

export function normalizeAnchorSelector(value: unknown): CommentAnchor | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}

	const record = value as Record<string, unknown>;
	const exact = normalizeInlineText(
		typeof record.exact === "string"
			? record.exact
			: typeof record.quote === "string"
				? record.quote
				: "",
	);
	if (!exact) {
		return null;
	}

	const startOffset = parseOptionalOffset(record.startOffset);
	const endOffset = parseOptionalOffset(record.endOffset);
	if (startOffset === null || endOffset === null) {
		return null;
	}
	if ((startOffset === undefined) !== (endOffset === undefined)) {
		return null;
	}
	if (startOffset !== undefined && endOffset !== undefined && endOffset < startOffset) {
		return null;
	}

	const prefix = parseOptionalInlineText(record.prefix);
	const suffix = parseOptionalInlineText(record.suffix);
	if (prefix === null || suffix === null) {
		return null;
	}

	return {
		exact,
		...(startOffset !== undefined ? { startOffset } : {}),
		...(endOffset !== undefined ? { endOffset } : {}),
		...(prefix ? { prefix } : {}),
		...(suffix ? { suffix } : {}),
	};
}

export function reanchorSelector(anchor: CommentAnchor, markdown: string): ReanchoredAnchor {
	const normalizedAnchor = normalizeAnchorSelector(anchor);
	if (!normalizedAnchor) {
		return {
			stale: true,
			anchor: {
				exact: "",
			},
		};
	}

	const documentText = String(markdown ?? "");
	const directCandidate = resolveDirectOffsetCandidate(normalizedAnchor, documentText);
	if (directCandidate) {
		return {
			stale: false,
			anchor: withContext(normalizedAnchor.exact, documentText, directCandidate.startOffset, directCandidate.endOffset),
		};
	}

	const candidates = findExactCandidates(documentText, normalizedAnchor.exact);
	if (candidates.length === 0) {
		return {
			stale: true,
			anchor: normalizedAnchor,
		};
	}

	const bestCandidate = pickBestCandidate(candidates, normalizedAnchor, documentText);
	return {
		stale: false,
		anchor: withContext(normalizedAnchor.exact, documentText, bestCandidate.startOffset, bestCandidate.endOffset),
	};
}

export function reanchorThreads<T extends { anchor: CommentAnchor; stale?: boolean }>(
	threads: readonly T[],
	markdown: string,
): T[] {
	if (!Array.isArray(threads) || threads.length === 0) {
		return [];
	}

	return threads.map((thread) => {
		const reanchored = reanchorSelector(thread.anchor, markdown);
		return {
			...thread,
			anchor: reanchored.anchor,
			stale: reanchored.stale,
		};
	});
}

interface AnchorCandidate {
	startOffset: number;
	endOffset: number;
}

function resolveDirectOffsetCandidate(anchor: CommentAnchor, markdown: string): AnchorCandidate | null {
	if (!Number.isInteger(anchor.startOffset) || !Number.isInteger(anchor.endOffset)) {
		return null;
	}

	const startOffset = Number(anchor.startOffset);
	const endOffset = Number(anchor.endOffset);
	if (startOffset < 0 || endOffset < startOffset) {
		return null;
	}

	const candidateText = markdown.slice(startOffset, endOffset);
	if (!candidateText) {
		return null;
	}
	if (normalizeInlineText(candidateText) !== normalizeInlineText(anchor.exact)) {
		return null;
	}

	return { startOffset, endOffset };
}

function findExactCandidates(markdown: string, exact: string): AnchorCandidate[] {
	if (!exact) return [];

	const tokens = exact.split(/\s+/).map(escapeRegExp).filter(Boolean);
	if (tokens.length === 0) return [];
	const pattern = tokens.join("\\s+");
	const matcher = new RegExp(pattern, "g");
	const candidates: AnchorCandidate[] = [];

	let match: RegExpExecArray | null;
	while ((match = matcher.exec(markdown)) !== null) {
		if (!match[0]) {
			matcher.lastIndex += 1;
			continue;
		}

		candidates.push({
			startOffset: match.index,
			endOffset: match.index + match[0].length,
		});
	}

	return candidates;
}

function pickBestCandidate(candidates: AnchorCandidate[], anchor: CommentAnchor, markdown: string): AnchorCandidate {
	const normalizedPrefix = normalizeInlineText(anchor.prefix ?? "");
	const normalizedSuffix = normalizeInlineText(anchor.suffix ?? "");
	const preferredOffset = Number.isInteger(anchor.startOffset) ? Number(anchor.startOffset) : undefined;

	let best = candidates[0];
	let bestScore = Number.NEGATIVE_INFINITY;

	for (const candidate of candidates) {
		let score = 0;
		if (normalizedPrefix) {
			const beforeText = normalizeInlineText(
				markdown.slice(Math.max(0, candidate.startOffset - normalizedPrefix.length - CONTEXT_WINDOW), candidate.startOffset),
			);
			if (beforeText.endsWith(normalizedPrefix)) score += 4;
			else if (beforeText.includes(normalizedPrefix)) score += 2;
		}

		if (normalizedSuffix) {
			const afterText = normalizeInlineText(
				markdown.slice(candidate.endOffset, Math.min(markdown.length, candidate.endOffset + normalizedSuffix.length + CONTEXT_WINDOW)),
			);
			if (afterText.startsWith(normalizedSuffix)) score += 4;
			else if (afterText.includes(normalizedSuffix)) score += 2;
		}

		if (preferredOffset !== undefined) {
			score -= Math.abs(preferredOffset - candidate.startOffset) / 200;
		}

		if (score > bestScore) {
			best = candidate;
			bestScore = score;
		}
	}

	return best;
}

function withContext(exact: string, markdown: string, startOffset: number, endOffset: number): CommentAnchor {
	const prefix = normalizeInlineText(markdown.slice(Math.max(0, startOffset - CONTEXT_WINDOW), startOffset));
	const suffix = normalizeInlineText(markdown.slice(endOffset, Math.min(markdown.length, endOffset + CONTEXT_WINDOW)));

	return {
		exact,
		startOffset,
		endOffset,
		...(prefix ? { prefix } : {}),
		...(suffix ? { suffix } : {}),
	};
}

function parseOptionalOffset(value: unknown): number | null | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}

	if (!Number.isInteger(value)) {
		return null;
	}

	const normalized = Number(value);
	if (normalized < 0) {
		return null;
	}

	return normalized;
}

function parseOptionalInlineText(value: unknown): string | null | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "string") {
		return null;
	}

	const normalized = normalizeInlineText(value);
	return normalized || undefined;
}

function normalizeInlineText(value: string): string {
	return String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
