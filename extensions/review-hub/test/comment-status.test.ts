import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { loadManifest, type ReviewManifest } from "../lib/manifest.ts";
import { createReviewServer } from "../lib/server.ts";

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
    if (stop) {
      await stop();
    }
  }
});

test("POST /comments defaults missing status to open and persists it", async () => {
  const running = await startServerWithManifest(createManifestFixture());

  const created = await postComment(running, {
    sectionId: "s-intro",
    type: "change",
    priority: "medium",
    text: "Please tighten this section.",
  });

  assert.equal(created.status, "open");
  assert.ok(Number.isFinite(Date.parse(String(created.createdAt))));
  assert.ok(Number.isFinite(Date.parse(String(created.updatedAt))));

  const savedManifest = await loadManifest(path.join(running.reviewDir, "review-001.manifest.json"));
  assert.equal(savedManifest.comments.length, 1);
  assert.equal(savedManifest.comments[0]?.status, "open");
});

test("existing comments without status stay backward compatible on update", async () => {
  const legacyCreatedAt = "2026-01-01T00:00:00.000Z";
  const running = await startServerWithManifest(
    createManifestFixture({
      comments: [
        {
          id: "legacy-comment",
          sectionId: "s-intro",
          type: "question",
          priority: "low",
          text: "Legacy comment",
          createdAt: legacyCreatedAt,
        },
      ],
    }),
  );

  const updated = await postComment(running, {
    id: "legacy-comment",
    sectionId: "s-intro",
    type: "question",
    priority: "low",
    text: "Legacy comment (edited)",
  });

  assert.equal(updated.createdAt, legacyCreatedAt);
  assert.equal(updated.status, "open");
  assert.ok(Number.isFinite(Date.parse(String(updated.updatedAt))));
  assert.notEqual(updated.updatedAt, legacyCreatedAt);

  const savedManifest = await loadManifest(path.join(running.reviewDir, "review-001.manifest.json"));
  assert.equal(savedManifest.comments.length, 1);
  assert.equal(savedManifest.comments[0]?.id, "legacy-comment");
  assert.equal(savedManifest.comments[0]?.status, "open");
});

test("resolved comments stay resolved when edited without status", async () => {
  const running = await startServerWithManifest(
    createManifestFixture({
      comments: [
        {
          id: "resolved-comment",
          sectionId: "s-intro",
          type: "change",
          priority: "medium",
          text: "Already resolved",
          createdAt: "2026-01-02T00:00:00.000Z",
          status: "resolved",
          updatedAt: "2026-01-02T00:10:00.000Z",
        },
      ],
    }),
  );

  const updated = await postComment(running, {
    id: "resolved-comment",
    sectionId: "s-intro",
    type: "change",
    priority: "medium",
    text: "Already resolved (edited)",
  });

  assert.equal(updated.status, "resolved");

  const savedManifest = await loadManifest(path.join(running.reviewDir, "review-001.manifest.json"));
  assert.equal(savedManifest.comments.length, 1);
  assert.equal(savedManifest.comments[0]?.status, "resolved");
});

test("POST /comments rejects invalid status", async () => {
  const running = await startServerWithManifest(createManifestFixture());

  const response = await fetch(`${running.origin}/comments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": running.token,
    },
    body: JSON.stringify({
      sectionId: "s-intro",
      type: "change",
      priority: "high",
      text: "Invalid status example",
      status: "closed",
    }),
  });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(String(body.error), /Invalid status/);

  const manifestResponse = await fetch(`${running.origin}/manifest.json`);
  assert.equal(manifestResponse.status, 200);
  const manifestBody = (await manifestResponse.json()) as ReviewManifest;
  assert.equal(manifestBody.comments.length, 0);
});

async function postComment(running: RunningServer, payload: Record<string, unknown>) {
  const response = await fetch(`${running.origin}/comments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": running.token,
    },
    body: JSON.stringify(payload),
  });

  assert.equal(response.status, 200);
  return response.json();
}

async function startServerWithManifest(manifest: ReviewManifest): Promise<RunningServer> {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), "review-hub-status-"));
  const sourcePath = path.join(reviewDir, "source.md");
  await fs.writeFile(sourcePath, "# Intro\n\nFixture\n", "utf-8");

  const manifestWithSource: ReviewManifest = { ...manifest, source: sourcePath };

  const server = createReviewServer();
  const { url } = await server.start(manifestWithSource, reviewDir);

  servers.push(async () => {
    await server.stop();
    await fs.rm(reviewDir, { recursive: true, force: true });
  });

  const parsedUrl = new URL(url);
  const token = parsedUrl.searchParams.get("token");
  if (!token) {
    throw new Error("Missing session token in review server URL");
  }

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
        sourceLineEnd: 2,
        sourceTextHash: "section-hash",
      },
    ],
    comments: [],
    ...overrides,
  };
}
