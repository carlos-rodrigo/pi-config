import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { AudioActionService, type AudioStatus } from "../lib/services/audio-action-service.ts";
import { createNoOpBridge, type ReviewRuntimeBridge } from "../lib/runtime-bridge.ts";
import type { ReviewManifest } from "../lib/manifest.ts";
import { createReviewServer } from "../lib/server.ts";

function makeManifest(overrides: Partial<ReviewManifest> = {}): ReviewManifest {
  return {
    id: "test-review",
    schemaVersion: 2,
    source: "/test/source.md",
    language: "en",
    status: "in-progress",
    sections: [
      { id: "s-intro", headingPath: ["Introduction"], headingLevel: 1, sourceTextHash: "h1" },
    ],
    comments: [],
    reviewDir: "/tmp/test",
    ...overrides,
  };
}

// ── AudioActionService unit tests ──────────────────────────────────────────

describe("AudioActionService", () => {
  test("getStatus returns not-requested when no audio", () => {
    const service = new AudioActionService(createNoOpBridge());
    const manifest = makeManifest();
    const status = service.getStatus(manifest);
    assert.equal(status.state, "not-requested");
  });

  test("getStatus returns ready when audio exists", () => {
    const service = new AudioActionService(createNoOpBridge());
    const manifest = makeManifest({ audio: { file: "narration.mp3", durationSeconds: 120 } });
    const status = service.getStatus(manifest);
    assert.equal(status.state, "ready");
  });

  test("getStatus returns failed with reason", () => {
    const service = new AudioActionService(createNoOpBridge());
    const manifest = makeManifest({ audioState: "failed", audioFailureReason: "TTS quota exceeded" });
    const status = service.getStatus(manifest);
    assert.equal(status.state, "failed");
    assert.equal(status.reason, "TTS quota exceeded");
  });

  test("regenerate calls bridge and returns accepted", async () => {
    let regenCalled = false;
    const bridge: ReviewRuntimeBridge = {
      ...createNoOpBridge(),
      requestAudioRegeneration: async () => { regenCalled = true; },
    };

    const service = new AudioActionService(bridge);
    const manifest = makeManifest({ audioState: "failed" });
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "audio-test-"));

    try {
      await fs.writeFile(path.join(tmpDir, "manifest.json"), JSON.stringify(manifest));
      const result = await service.regenerate(manifest, tmpDir);
      assert.equal(result.accepted, true);
      assert.equal(result.status, "generating");
      assert.ok(regenCalled);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("regenerate rejects when already generating", async () => {
    const service = new AudioActionService(createNoOpBridge());
    // Simulate generating: review status=generating, no audio, no audioState
    const manifest = makeManifest({ status: "generating" });
    const status = service.getStatus(manifest);
    assert.equal(status.state, "generating");

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "audio-test-"));
    try {
      await fs.writeFile(path.join(tmpDir, "manifest.json"), JSON.stringify(manifest));
      const result = await service.regenerate(manifest, tmpDir);
      assert.equal(result.accepted, false);
      assert.equal(result.status, "generating");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("regenerate handles bridge failure", async () => {
    const bridge: ReviewRuntimeBridge = {
      ...createNoOpBridge(),
      requestAudioRegeneration: async () => { throw new Error("TTS service down"); },
    };

    const service = new AudioActionService(bridge);
    const manifest = makeManifest({ audioState: "failed" });
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "audio-test-"));

    try {
      await fs.writeFile(path.join(tmpDir, "manifest.json"), JSON.stringify(manifest));
      const result = await service.regenerate(manifest, tmpDir);
      assert.equal(result.accepted, false);
      assert.equal(result.status, "failed");
      assert.equal(manifest.audioFailureReason, "TTS service down");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Endpoint integration tests ─────────────────────────────────────────────

describe("GET /audio/status endpoint", () => {
  test("returns audio status", async () => {
    const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), "audio-ep-"));
    const sourcePath = path.join(reviewDir, "source.md");
    await fs.writeFile(sourcePath, "# Test\n\nContent.\n");

    const manifest = makeManifest({
      source: sourcePath,
      audioState: "failed",
      audioFailureReason: "quota exceeded",
    });
    await fs.writeFile(path.join(reviewDir, "manifest.json"), JSON.stringify(manifest));

    const server = createReviewServer();
    const { url } = await server.start(manifest, reviewDir);

    try {
      const parsedUrl = new URL(url);
      const token = parsedUrl.searchParams.get("token")!;

      const res = await fetch(`${parsedUrl.origin}/audio/status?token=${token}`);
      assert.equal(res.status, 200);

      const result = await res.json() as AudioStatus;
      assert.equal(result.state, "failed");
      assert.equal(result.reason, "quota exceeded");
    } finally {
      await server.stop();
      await fs.rm(reviewDir, { recursive: true, force: true });
    }
  });
});

describe("POST /audio/regenerate endpoint", () => {
  test("accepts regeneration request", async () => {
    const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), "audio-regen-"));
    const sourcePath = path.join(reviewDir, "source.md");
    await fs.writeFile(sourcePath, "# Test\n\nContent.\n");

    const manifest = makeManifest({
      source: sourcePath,
      audioState: "failed",
    });
    await fs.writeFile(path.join(reviewDir, "manifest.json"), JSON.stringify(manifest));

    const server = createReviewServer();
    const { url } = await server.start(manifest, reviewDir);

    try {
      const parsedUrl = new URL(url);
      const token = parsedUrl.searchParams.get("token")!;

      const res = await fetch(`${parsedUrl.origin}/audio/regenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Session-Token": token },
        body: JSON.stringify({}),
      });

      assert.equal(res.status, 200);
      const result = await res.json() as { accepted: boolean; status: string };
      assert.equal(result.accepted, true);
      assert.equal(result.status, "generating");
    } finally {
      await server.stop();
      await fs.rm(reviewDir, { recursive: true, force: true });
    }
  });
});
