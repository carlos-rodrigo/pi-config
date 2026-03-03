import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createReviewServer } from "../lib/server.ts";
import { loadManifest, type ReviewManifest } from "../lib/manifest.ts";

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

test("GET / serves React dist shell and preserves reserved API routing", async () => {
  const running = await startServerWithManifest(createManifestFixture());

  const rootResponse = await fetch(`${running.origin}/`);
  assert.equal(rootResponse.status, 200);
  const rootHtml = await rootResponse.text();
  assert.match(rootHtml, /<div id="root"><\/div>/);
  assert.match(rootHtml, /assets\/index-.*\.js/);

  const cssAssetMatch = rootHtml.match(/assets\/(index-[^\"]+\.css)/);
  assert.ok(cssAssetMatch, "expected root html to include a css asset");

  const cssResponse = await fetch(`${running.origin}/assets/${cssAssetMatch[1]}`);
  assert.equal(cssResponse.status, 200);
  const cssText = await cssResponse.text();
  assert.match(cssText, /review-hub-visual-host\[data-embedded-progress-nav=hidden\] \.progress-nav\{display:none\}/);

  const manifestResponse = await fetch(`${running.origin}/manifest.json`);
  assert.equal(manifestResponse.status, 200);
  const manifestBody = (await manifestResponse.json()) as ReviewManifest;
  assert.equal(manifestBody.id, "review-001");

  const reservedApiResponse = await fetch(`${running.origin}/comments`);
  assert.equal(reservedApiResponse.status, 404);
  const reservedApiBody = await reservedApiResponse.json();
  assert.equal(reservedApiBody.error, "Not Found");

  const missingAssetResponse = await fetch(`${running.origin}/assets/does-not-exist.js`);
  assert.equal(missingAssetResponse.status, 404);

  const spaRouteResponse = await fetch(`${running.origin}/review/session/abc`);
  assert.equal(spaRouteResponse.status, 200);
  const spaHtml = await spaRouteResponse.text();
  assert.match(spaHtml, /<div id="root"><\/div>/);
});

test("visual-only and with-audio flows expose safe /audio behavior", async () => {
  const visualOnly = await startServerWithManifest(
    createManifestFixture({
      audioState: "not-requested",
    }),
  );

  const noAudioResponse = await fetch(`${visualOnly.origin}/audio`);
  assert.equal(noAudioResponse.status, 404);
  assert.match(await noAudioResponse.text(), /No audio available/);

  const withAudio = await startServerWithManifest(
    createManifestFixture({
      audioState: "ready",
      audio: {
        file: "review-001.mp3",
        durationSeconds: 12,
        scriptFile: "review-001.script.md",
      },
    }),
    async (reviewDir) => {
      await fs.writeFile(path.join(reviewDir, "review-001.mp3"), Buffer.from([1, 2, 3, 4]));
    },
  );

  const audioResponse = await fetch(`${withAudio.origin}/audio`);
  assert.equal(audioResponse.status, 200);
  assert.match(audioResponse.headers.get("content-type") ?? "", /audio\/mpeg/);
  const audioBytes = Buffer.from(await audioResponse.arrayBuffer());
  assert.deepEqual([...audioBytes], [1, 2, 3, 4]);
});

test("comment CRUD + complete review persists lifecycle state", async () => {
  const running = await startServerWithManifest(createManifestFixture());

  const createCommentResponse = await fetch(`${running.origin}/comments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": running.token,
    },
    body: JSON.stringify({
      sectionId: "s-intro",
      type: "change",
      priority: "high",
      text: "Please clarify acceptance criteria.",
    }),
  });
  assert.equal(createCommentResponse.status, 200);

  const completeResponse = await fetch(`${running.origin}/complete`, {
    method: "POST",
    headers: {
      "X-Session-Token": running.token,
    },
  });
  assert.equal(completeResponse.status, 200);
  const completeBody = await completeResponse.json();
  assert.equal(completeBody.status, "reviewed");
  assert.equal(completeBody.commentCount, 1);
  assert.ok(Number.isFinite(Date.parse(String(completeBody.completedAt))));

  const manifestResponse = await fetch(`${running.origin}/manifest.json`);
  assert.equal(manifestResponse.status, 200);
  const manifestBody = (await manifestResponse.json()) as ReviewManifest;
  assert.equal(manifestBody.status, "reviewed");
  assert.equal(manifestBody.comments.length, 1);
  assert.ok(manifestBody.completedAt);

  const persistedManifest = await loadManifest(path.join(running.reviewDir, "review-001.manifest.json"));
  assert.equal(persistedManifest.status, "reviewed");
  assert.equal(persistedManifest.comments.length, 1);
});

async function startServerWithManifest(
  manifest: ReviewManifest,
  setupReviewDir?: (reviewDir: string) => Promise<void>,
): Promise<RunningServer> {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), "review-hub-flow-"));
  const sourcePath = path.join(reviewDir, "source.md");
  await fs.writeFile(sourcePath, "# Intro\n\nFixture\n", "utf-8");

  if (setupReviewDir) {
    await setupReviewDir(reviewDir);
  }

  const server = createReviewServer();
  const manifestWithSource: ReviewManifest = { ...manifest, source: sourcePath };
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
        sourceLineEnd: 3,
        sourceTextHash: "section-hash",
      },
    ],
    comments: [],
    ...overrides,
  };
}
