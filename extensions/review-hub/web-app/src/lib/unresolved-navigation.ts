import type { ReviewComment, ReviewManifest } from "@/lib/api";

type ReviewSection = ReviewManifest["sections"][number];

export function buildUnresolvedCountsBySection(comments: ReviewComment[]): Record<string, number> {
  return comments.reduce<Record<string, number>>((counts, comment) => {
    if ((comment.status ?? "open") !== "open") {
      return counts;
    }

    counts[comment.sectionId] = (counts[comment.sectionId] ?? 0) + 1;
    return counts;
  }, {});
}

export function sortUnresolvedComments(
  comments: ReviewComment[],
  sections: ReviewSection[],
): ReviewComment[] {
  const sectionOrder = new Map(sections.map((section, index) => [section.id, index]));

  return comments
    .filter((comment) => (comment.status ?? "open") === "open")
    .map((comment) => ({
      comment,
      sectionRank: sectionOrder.get(comment.sectionId) ?? Number.MAX_SAFE_INTEGER,
      createdAtMs: toSortableTimestamp(comment.createdAt),
    }))
    .sort((left, right) => {
      if (left.sectionRank !== right.sectionRank) {
        return left.sectionRank - right.sectionRank;
      }

      return left.createdAtMs - right.createdAtMs;
    })
    .map((entry) => entry.comment);
}

export function getNextUnresolvedComment(
  unresolvedComments: ReviewComment[],
  currentCommentId: string | null,
): ReviewComment | null {
  if (unresolvedComments.length === 0) {
    return null;
  }

  const currentIndex = currentCommentId
    ? unresolvedComments.findIndex((comment) => comment.id === currentCommentId)
    : -1;
  const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % unresolvedComments.length : 0;

  return unresolvedComments[nextIndex]!;
}

function toSortableTimestamp(isoTimestamp: string): number {
  const timestamp = Date.parse(isoTimestamp);
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}
