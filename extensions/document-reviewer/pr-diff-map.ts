export interface PullRequestDiffFile {
	filename: string;
	patch?: string | null;
}

export interface PullRequestInlineCommentLocator {
	filePath: string;
	lineStart?: number;
	lineEnd?: number;
}

export interface PullRequestInlineCommentTarget {
	path: string;
	line: number;
	side: "RIGHT";
}

function parseHunkHeader(line: string): number | null {
	const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
	if (!match) return null;
	return Number.parseInt(match[1]!, 10);
}

export function parseChangedRightSideLines(patch: string): number[] {
	const changedLines = new Set<number>();
	let currentRightLine: number | null = null;

	for (const line of patch.split(/\r?\n/)) {
		const hunkStart = parseHunkHeader(line);
		if (hunkStart !== null) {
			currentRightLine = hunkStart;
			continue;
		}

		if (currentRightLine === null) continue;
		if (line.startsWith("\\")) continue;
		if (line.startsWith("+++") || line.startsWith("---")) continue;

		if (line.startsWith("+")) {
			changedLines.add(currentRightLine);
			currentRightLine += 1;
			continue;
		}

		if (line.startsWith("-")) {
			continue;
		}

		if (line.startsWith(" ")) {
			currentRightLine += 1;
		}
	}

	return [...changedLines].sort((a, b) => a - b);
}

export function buildPullRequestDiffMap(files: readonly PullRequestDiffFile[]): Map<string, Set<number>> {
	const diffMap = new Map<string, Set<number>>();
	for (const file of files) {
		if (typeof file.patch !== "string" || file.patch.trim().length === 0) continue;
		diffMap.set(file.filename, new Set(parseChangedRightSideLines(file.patch)));
	}
	return diffMap;
}

export function getRightSideInlineCommentTarget(
	locator: PullRequestInlineCommentLocator,
	diffMap: ReadonlyMap<string, ReadonlySet<number>>,
): PullRequestInlineCommentTarget | null {
	if (!Number.isInteger(locator.lineStart) || !Number.isInteger(locator.lineEnd)) return null;
	if (locator.lineStart !== locator.lineEnd) return null;

	const changedLines = diffMap.get(locator.filePath);
	if (!changedLines?.has(locator.lineEnd)) return null;

	return {
		path: locator.filePath,
		line: locator.lineEnd,
		side: "RIGHT",
	};
}
