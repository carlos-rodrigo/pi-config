import { test } from "node:test";
import assert from "node:assert/strict";

import type { ReviewComment, ReviewManifest } from "../lib/manifest.ts";
import {
  buildUnresolvedCountsBySection,
  getNextUnresolvedComment,
  sortUnresolvedComments,
} from "../web-app/src/lib/unresolved-navigation.ts";

type ReviewSection = ReviewManifest["sections"][number];

test("sortUnresolvedComments keeps a stable section-first order", () => {
  const sections: ReviewSection[] = [
    {
      id: "s-1",
      headingPath: ["First"],
      headingLevel: 1,
      occurrenceIndex: 0,
      sourceLineStart: 1,
      sourceLineEnd: 2,
      sourceTextHash: "hash-1",
    },
    {
      id: "s-2",
      headingPath: ["Second"],
      headingLevel: 1,
      occurrenceIndex: 0,
      sourceLineStart: 3,
      sourceLineEnd: 4,
      sourceTextHash: "hash-2",
    },
  ];

  const comments: ReviewComment[] = [
    {
      id: "c3",
      sectionId: "s-2",
      type: "change",
      priority: "medium",
      text: "later section",
      createdAt: "2026-01-01T00:03:00.000Z",
      status: "open",
    },
    {
      id: "c1",
      sectionId: "s-1",
      type: "question",
      priority: "high",
      text: "first section (newer)",
      createdAt: "2026-01-01T00:02:00.000Z",
      status: "open",
    },
    {
      id: "c0",
      sectionId: "s-1",
      type: "approval",
      priority: "low",
      text: "first section (older)",
      createdAt: "2026-01-01T00:01:00.000Z",
      status: "open",
    },
    {
      id: "cx",
      sectionId: "missing",
      type: "concern",
      priority: "high",
      text: "unknown section should come last",
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "open",
    },
    {
      id: "resolved",
      sectionId: "s-1",
      type: "approval",
      priority: "low",
      text: "resolved should be skipped",
      createdAt: "2026-01-01T00:04:00.000Z",
      status: "resolved",
    },
  ];

  const ordered = sortUnresolvedComments(comments, sections);
  assert.deepEqual(
    ordered.map((comment) => comment.id),
    ["c0", "c1", "c3", "cx"],
  );
});

test("buildUnresolvedCountsBySection ignores resolved comments", () => {
  const comments: ReviewComment[] = [
    {
      id: "c1",
      sectionId: "s-1",
      type: "change",
      priority: "medium",
      text: "open",
      createdAt: "2026-01-01T00:01:00.000Z",
      status: "open",
    },
    {
      id: "c2",
      sectionId: "s-1",
      type: "question",
      priority: "low",
      text: "resolved",
      createdAt: "2026-01-01T00:02:00.000Z",
      status: "resolved",
    },
    {
      id: "c3",
      sectionId: "s-2",
      type: "concern",
      priority: "high",
      text: "legacy open",
      createdAt: "2026-01-01T00:03:00.000Z",
    },
  ];

  const counts = buildUnresolvedCountsBySection(comments);
  assert.deepEqual(counts, {
    "s-1": 1,
    "s-2": 1,
  });
});

test("getNextUnresolvedComment cycles and wraps predictably", () => {
  const unresolved: ReviewComment[] = [
    {
      id: "c1",
      sectionId: "s-1",
      type: "change",
      priority: "medium",
      text: "one",
      createdAt: "2026-01-01T00:01:00.000Z",
      status: "open",
    },
    {
      id: "c2",
      sectionId: "s-2",
      type: "question",
      priority: "high",
      text: "two",
      createdAt: "2026-01-01T00:02:00.000Z",
      status: "open",
    },
  ];

  assert.equal(getNextUnresolvedComment(unresolved, null)?.id, "c1");
  assert.equal(getNextUnresolvedComment(unresolved, "c1")?.id, "c2");
  assert.equal(getNextUnresolvedComment(unresolved, "c2")?.id, "c1");
  assert.equal(getNextUnresolvedComment([], "c2"), null);
});
