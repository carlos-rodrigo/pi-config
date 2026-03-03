import { test } from "node:test";
import assert from "node:assert/strict";

import type { ReviewManifest } from "../lib/manifest.ts";
import { findSectionAtTime, formatAudioTime, resolveAudioUxState } from "../web-app/src/lib/audio-player.ts";

test("resolveAudioUxState handles generating/ready/failed/not-requested", () => {
  const base = createManifestFixture();

  assert.equal(resolveAudioUxState({ ...base, status: "generating" }), "generating");
  assert.equal(
    resolveAudioUxState({
      ...base,
      status: "ready",
      audio: { file: "review.mp3", durationSeconds: 120, scriptFile: "review-script.md" },
    }),
    "ready",
  );
  assert.equal(resolveAudioUxState({ ...base, audioState: "failed" }), "failed");
  assert.equal(
    resolveAudioUxState({
      ...base,
      audioState: "failed",
      audio: { file: "review.mp3", durationSeconds: 120, scriptFile: "review-script.md" },
    }),
    "failed",
  );
  assert.equal(resolveAudioUxState({ ...base, audioState: "ready" }), "ready");
  assert.equal(
    resolveAudioUxState({
      ...base,
      audioState: "not-requested",
      audio: { file: "stale.mp3", durationSeconds: 120, scriptFile: "stale.md" },
    }),
    "not-requested",
  );
  assert.equal(resolveAudioUxState({ ...base, status: "ready" }), "not-requested");
});

test("formatAudioTime returns mm:ss", () => {
  assert.equal(formatAudioTime(0), "00:00");
  assert.equal(formatAudioTime(65), "01:05");
  assert.equal(formatAudioTime(360), "06:00");
  assert.equal(formatAudioTime(Number.NaN), "00:00");
});

test("findSectionAtTime resolves section from timestamps", () => {
  const sections = createManifestFixture().sections.map((section, index) => ({
    ...section,
    audioStartTime: index * 10,
    audioEndTime: index * 10 + 10,
  }));

  assert.equal(findSectionAtTime(sections, 2)?.id, "s-1");
  assert.equal(findSectionAtTime(sections, 10)?.id, "s-2");
  assert.equal(findSectionAtTime(sections, 12)?.id, "s-2");
  assert.equal(findSectionAtTime(sections, -2), null);
  assert.equal(findSectionAtTime(sections, 40), null);
});

function createManifestFixture(): ReviewManifest {
  return {
    id: "review-001",
    schemaVersion: 2,
    source: "doc.md",
    sourceHash: "hash",
    reviewType: "prd",
    language: "en",
    createdAt: "2026-03-02T00:00:00.000Z",
    completedAt: null,
    status: "ready",
    sections: [
      {
        id: "s-1",
        headingPath: ["One"],
        headingLevel: 1,
        occurrenceIndex: 0,
        sourceLineStart: 1,
        sourceLineEnd: 2,
        sourceTextHash: "hash-1",
      },
      {
        id: "s-2",
        headingPath: ["Two"],
        headingLevel: 1,
        occurrenceIndex: 0,
        sourceLineStart: 3,
        sourceLineEnd: 4,
        sourceTextHash: "hash-2",
      },
    ],
    comments: [],
  };
}
