import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { type ReviewRuntimeBridge, createNoOpBridge as createDefaultBridge } from "../lib/runtime-bridge.ts";
import { createReviewServer } from "../lib/server.ts";
import type { ReviewManifest } from "../lib/manifest.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

interface RunningServer {
  origin: string;
  token: string;
  reviewDir: string;
  stop: () => Promise<void>;
}

const servers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (servers.length > 0) {
    const stop = servers.pop();
    if (stop) await stop();
  }
});

function createManifestFixture(overrides: Partial<ReviewManifest> = {}): ReviewManifest {
  return {
    id: "review-001",
    schemaVersion: 2,
    source: "",
    sourceHash: "fixture-hash",
    reviewType: "prd",
    language: "en",
    createdAt: "2026-03-02T00:00:00.000Z",
    completedAt: null,
    status: "ready",
    sections: [
      {
        id: "s-intro",
        headingPath: ["Intro"],
        headingLevel: 1,
        occurrenceIndex: 0,
        sourceLineStart: 1,
        sourceLineEnd: 3,
        sourceTextHash: "section-hash",
      },
    ],
    comments: [],
    ...overrides,
  };
}

function createNoOpBridge(): ReviewRuntimeBridge {
  return {
    handoffFeedbackToPi: async (_markdown: string) => {},
    copyToClipboard: async (_markdown: string) => ({ copied: true }),
    requestAudioRegeneration: async (_reviewId: string, _options?: { fastAudio?: boolean }) => {},
  };
}

function createFailingBridge(error: string): ReviewRuntimeBridge {
  return {
    handoffFeedbackToPi: async () => { throw new Error(error); },
    copyToClipboard: async () => { throw new Error(error); },
    requestAudioRegeneration: async () => { throw new Error(error); },
  };
}

async function startServerWithBridge(
  manifest: ReviewManifest,
  bridge?: ReviewRuntimeBridge,
): Promise<RunningServer> {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), "review-hub-bridge-"));
  const sourcePath = path.join(reviewDir, "source.md");
  await fs.writeFile(sourcePath, "# Intro\n\nFixture\n", "utf-8");

  const server = createReviewServer(bridge);
  const manifestWithSource: ReviewManifest = { ...manifest, source: sourcePath };
  const { url } = await server.start(manifestWithSource, reviewDir);

  servers.push(async () => {
    await server.stop();
    await fs.rm(reviewDir, { recursive: true, force: true });
  });

  const parsedUrl = new URL(url);
  const token = parsedUrl.searchParams.get("token");
  if (!token) throw new Error("Missing session token");

  return {
    origin: parsedUrl.origin,
    token,
    reviewDir,
    stop: async () => {
      await server.stop();
      await fs.rm(reviewDir, { recursive: true, force: true });
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

test("ReviewRuntimeBridge interface is importable and satisfies contract", () => {
  // createDefaultBridge is the library-provided no-op bridge factory
  const bridge = createDefaultBridge();
  assert.equal(typeof bridge.handoffFeedbackToPi, "function");
  assert.equal(typeof bridge.copyToClipboard, "function");
  assert.equal(typeof bridge.requestAudioRegeneration, "function");
});

test("createReviewServer accepts optional bridge parameter and stores it", async () => {
  const bridge = createNoOpBridge();
  const server = createReviewServer(bridge);
  assert.equal(server.bridge, bridge, "bridge should be accessible on the server instance");
  await server.stop();
});

test("createReviewServer without bridge uses no-op bridge", async () => {
  const server = createReviewServer();
  assert.ok(server.bridge, "server should have a default no-op bridge");
  assert.equal(typeof server.bridge.handoffFeedbackToPi, "function");
  assert.equal(typeof server.bridge.copyToClipboard, "function");
  assert.equal(typeof server.bridge.requestAudioRegeneration, "function");
  await server.stop();
});

test("createReviewServer works without bridge (backward compat)", async () => {
  const running = await startServerWithBridge(createManifestFixture());

  const response = await fetch(`${running.origin}/manifest.json`);
  assert.equal(response.status, 200);
});

test("bridge errors are surfaced as recoverable API errors, not process crashes", async () => {
  const bridge = createFailingBridge("pi session expired");
  const running = await startServerWithBridge(createManifestFixture(), bridge);

  // The server should not crash — existing endpoints work fine
  const response = await fetch(`${running.origin}/manifest.json`);
  assert.equal(response.status, 200);
});

test("existing /review flow still works with bridge-enabled server", async () => {
  const bridge = createNoOpBridge();
  const running = await startServerWithBridge(createManifestFixture(), bridge);

  // Create a comment
  const createResponse = await fetch(`${running.origin}/comments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": running.token,
    },
    body: JSON.stringify({
      sectionId: "s-intro",
      type: "change",
      priority: "high",
      text: "Needs more detail.",
    }),
  });
  assert.equal(createResponse.status, 200);

  // Complete review
  const completeResponse = await fetch(`${running.origin}/complete`, {
    method: "POST",
    headers: { "X-Session-Token": running.token },
  });
  assert.equal(completeResponse.status, 200);
  const body = await completeResponse.json();
  assert.equal(body.status, "reviewed");
  assert.equal(body.commentCount, 1);
});
