import { test } from "node:test";
import assert from "node:assert/strict";

import type { ReviewManifest } from "../lib/manifest.ts";
import {
  CommentService,
  ExportService,
  FinishService,
  AudioActionService,
} from "../lib/services/index.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

function createTestManifest(): ReviewManifest {
  return {
    id: "review-001",
    schemaVersion: 2,
    source: "test.md",
    sourceHash: "hash",
    reviewType: "prd",
    language: "en",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    status: "ready",
    sections: [{
      id: "s-intro",
      headingPath: ["Intro"],
      headingLevel: 1,
      occurrenceIndex: 0,
      sourceLineStart: 1,
      sourceLineEnd: 3,
      sourceTextHash: "hash",
    }],
    comments: [],
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

test("CommentService is constructible with manifest/dir accessors", () => {
  const service = new CommentService(
    () => null,
    () => "/tmp/test",
  );
  assert.ok(service);
  assert.equal(typeof service.upsert, "function");
  assert.equal(typeof service.delete, "function");
});

test("ExportService is constructible and has export method", () => {
  const service = new ExportService();
  assert.ok(service);
  assert.equal(typeof service.export, "function");
});

test("FinishService is constructible with bridge and export service", () => {
  const bridge = {
    handoffFeedbackToPi: async () => {},
    copyToClipboard: async () => ({ copied: true as const }),
    requestAudioRegeneration: async () => {},
  };
  const exportService = new ExportService();
  const service = new FinishService(bridge, exportService);
  assert.ok(service);
  assert.equal(typeof service.finish, "function");
});

test("AudioActionService is constructible with bridge", () => {
  const bridge = {
    handoffFeedbackToPi: async () => {},
    copyToClipboard: async () => ({ copied: true as const }),
    requestAudioRegeneration: async () => {},
  };
  const service = new AudioActionService(bridge);
  assert.ok(service);
  assert.equal(typeof service.getStatus, "function");
  assert.equal(typeof service.regenerate, "function");
});

test("CommentService returns error when manifest not ready", async () => {
  const service = new CommentService(
    () => null,
    () => "/tmp/test",
  );

  const result = await service.upsert({
    sectionId: "s-intro",
    type: "change",
    priority: "high",
    text: "test",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 503);
    assert.match(result.error, /not ready/i);
  }
});

test("ExportService exports only open comments by default", () => {
  const service = new ExportService();
  const manifest = createTestManifest();
  manifest.status = "in-progress";
  manifest.comments = [
    {
      id: "c1",
      sectionId: "s-intro",
      type: "change",
      priority: "high",
      text: "Fix this",
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "open",
    },
    {
      id: "c2",
      sectionId: "s-intro",
      type: "approval",
      priority: "low",
      text: "Looks good",
      createdAt: "2026-01-01T01:00:00.000Z",
      status: "resolved",
    },
  ];

  const result = service.export(manifest);

  assert.equal(result.stats.openComments, 1);
  assert.equal(result.stats.resolvedComments, 1);
  assert.equal(result.stats.totalComments, 2);
  assert.match(result.markdown, /Fix this/);
  assert.ok(!result.markdown.includes("Looks good"), "Resolved comment should be excluded");
  assert.ok(result.exportHash.length === 64, "exportHash should be SHA-256");
});

test("ExportService produces deterministic output", () => {
  const service = new ExportService();
  const manifest = createTestManifest();
  manifest.status = "in-progress";
  manifest.comments = [{
    id: "c1",
    sectionId: "s-intro",
    type: "change",
    priority: "high",
    text: "Fix this",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "open",
  }];

  const result1 = service.export(manifest);
  const result2 = service.export(manifest);

  assert.equal(result1.markdown, result2.markdown);
  assert.equal(result1.exportHash, result2.exportHash);
});

test("CommentService validates comment type", async () => {
  const manifest = createTestManifest();
  const service = new CommentService(
    () => manifest,
    () => "/tmp/nonexistent",
  );

  const result = await service.upsert({
    sectionId: "s-intro",
    type: "invalid" as any,
    priority: "high",
    text: "test",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.match(result.error, /Invalid comment type/);
  }
});

test("CommentService validates unknown sectionId", async () => {
  const manifest = createTestManifest();
  const service = new CommentService(
    () => manifest,
    () => "/tmp/nonexistent",
  );

  const result = await service.upsert({
    sectionId: "s-nonexistent",
    type: "change",
    priority: "high",
    text: "test",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 400);
    assert.match(result.error, /Unknown section/);
  }
});

test("CommentService delete returns 404 for unknown comment", async () => {
  const manifest = createTestManifest();
  const service = new CommentService(
    () => manifest,
    () => "/tmp/nonexistent",
  );

  const result = await service.delete("nonexistent-id");

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 404);
    assert.match(result.error, /not found/i);
  }
});

test("ExportService includes anchored quotes in export", () => {
  const service = new ExportService();
  const manifest = createTestManifest();
  manifest.comments = [{
    id: "c1",
    sectionId: "s-intro",
    type: "change",
    priority: "high",
    text: "Fix wording",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "open",
    anchor: {
      version: 2,
      sectionId: "s-intro",
      quote: "some selected text",
      anchorAlgoVersion: "v2-section-text",
    },
  }];

  const result = service.export(manifest);
  assert.match(result.markdown, /some selected text/);
});

test("ExportService handles empty comments gracefully", () => {
  const service = new ExportService();
  const manifest = createTestManifest();
  manifest.comments = [];

  const result = service.export(manifest);
  assert.equal(result.stats.totalComments, 0);
  assert.equal(result.stats.openComments, 0);
  assert.ok(result.exportHash.length === 64);
});

test("AudioActionService reports correct status from manifest", () => {
  const bridge = {
    handoffFeedbackToPi: async () => {},
    copyToClipboard: async () => ({ copied: true as const }),
    requestAudioRegeneration: async () => {},
  };
  const service = new AudioActionService(bridge);

  // not-requested
  const notRequested = service.getStatus({
    audioState: "not-requested",
  } as any);
  assert.equal(notRequested.state, "not-requested");

  // ready
  const ready = service.getStatus({
    audioState: "ready",
    audio: { file: "test.mp3", durationSeconds: 10, scriptFile: "test.script.md" },
  } as any);
  assert.equal(ready.state, "ready");

  // failed with reason
  const failed = service.getStatus({
    audioState: "failed",
    audioFailureReason: "TTS provider crashed",
  } as any);
  assert.equal(failed.state, "failed");
  assert.equal(failed.reason, "TTS provider crashed");

  // missing audioState with audio present
  const inferReady = service.getStatus({
    audio: { file: "test.mp3", durationSeconds: 10, scriptFile: "test.script.md" },
  } as any);
  assert.equal(inferReady.state, "ready");

  // missing audioState without audio
  const inferNotRequested = service.getStatus({} as any);
  assert.equal(inferNotRequested.state, "not-requested");
});
