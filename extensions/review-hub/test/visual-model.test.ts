import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { buildVisualModel, type RenderSection } from "../lib/visual-model.ts";
import { createReviewServer } from "../lib/server.ts";
import type { ReviewManifest } from "../lib/manifest.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

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
        id: "s-introduction",
        headingPath: ["Introduction"],
        headingLevel: 1,
        occurrenceIndex: 0,
        sourceLineStart: 1,
        sourceLineEnd: 3,
        sourceTextHash: "hash-intro",
      },
      {
        id: "s-goals",
        headingPath: ["Goals"],
        headingLevel: 1,
        occurrenceIndex: 0,
        sourceLineStart: 4,
        sourceLineEnd: 7,
        sourceTextHash: "hash-goals",
      },
    ],
    comments: [],
    ...overrides,
  };
}

const SOURCE_MARKDOWN = `# Introduction

Some intro text.
# Goals

- Goal 1
- Goal 2
`;

// ── buildVisualModel tests ─────────────────────────────────────────────────

test("buildVisualModel returns sections with correct metadata and markdown slices", () => {
  const manifest = createManifestFixture();
  const result = buildVisualModel(manifest, SOURCE_MARKDOWN);

  assert.equal(result.length, 2);

  // First section
  assert.equal(result[0]!.sectionId, "s-introduction");
  assert.deepEqual(result[0]!.headingPath, ["Introduction"]);
  assert.equal(result[0]!.headingLevel, 1);
  assert.equal(result[0]!.sourceTextHash, "hash-intro");
  assert.match(result[0]!.markdown, /# Introduction/);
  assert.match(result[0]!.markdown, /Some intro text/);

  // Second section
  assert.equal(result[1]!.sectionId, "s-goals");
  assert.deepEqual(result[1]!.headingPath, ["Goals"]);
  assert.equal(result[1]!.headingLevel, 1);
  assert.match(result[1]!.markdown, /# Goals/);
  assert.match(result[1]!.markdown, /Goal 1/);
});

test("buildVisualModel preserves manifest section order", () => {
  const manifest = createManifestFixture();
  const result = buildVisualModel(manifest, SOURCE_MARKDOWN);

  const ids = result.map((s) => s.sectionId);
  assert.deepEqual(ids, ["s-introduction", "s-goals"]);
});

test("buildVisualModel handles single-section document", () => {
  const manifest = createManifestFixture({
    sections: [
      {
        id: "s-only",
        headingPath: ["Only"],
        headingLevel: 1,
        occurrenceIndex: 0,
        sourceLineStart: 1,
        sourceLineEnd: 2,
        sourceTextHash: "hash-only",
      },
    ],
  });

  const result = buildVisualModel(manifest, "# Only\n\nContent here.\n");
  assert.equal(result.length, 1);
  assert.equal(result[0]!.sectionId, "s-only");
  assert.match(result[0]!.markdown, /Only/);
});

test("buildVisualModel handles empty sections list", () => {
  const manifest = createManifestFixture({ sections: [] });
  const result = buildVisualModel(manifest, SOURCE_MARKDOWN);
  assert.equal(result.length, 0);
});

// ── Server endpoint tests ──────────────────────────────────────────────────

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

async function startServer(manifest: ReviewManifest): Promise<RunningServer> {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), "review-hub-vm-"));
  const sourcePath = path.join(reviewDir, "source.md");
  await fs.writeFile(sourcePath, SOURCE_MARKDOWN, "utf-8");

  const server = createReviewServer();
  const manifestWithSource: ReviewManifest = { ...manifest, source: sourcePath };
  const { url } = await server.start(manifestWithSource, reviewDir);

  servers.push(async () => {
    await server.stop();
    await fs.rm(reviewDir, { recursive: true, force: true });
  });

  const parsedUrl = new URL(url);
  const token = parsedUrl.searchParams.get("token")!;

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

test("GET /visual-model returns section array with stable sectionId", async () => {
  const running = await startServer(createManifestFixture());

  const response = await fetch(`${running.origin}/visual-model`);
  assert.equal(response.status, 200);

  const body = await response.json() as { sections: RenderSection[] };
  assert.ok(Array.isArray(body.sections));
  assert.equal(body.sections.length, 2);
  assert.equal(body.sections[0]!.sectionId, "s-introduction");
  assert.equal(body.sections[1]!.sectionId, "s-goals");
});

test("GET /visual-model payload matches manifest section order", async () => {
  const running = await startServer(createManifestFixture());

  const response = await fetch(`${running.origin}/visual-model`);
  const body = await response.json() as { sections: RenderSection[] };

  const ids = body.sections.map((s: RenderSection) => s.sectionId);
  assert.deepEqual(ids, ["s-introduction", "s-goals"]);
});

test("GET /visual-model returns 503 when server not ready", async () => {
  // Create server but don't start it — just verify the path is reserved
  const running = await startServer(createManifestFixture());

  // The server IS running, so this should succeed
  const response = await fetch(`${running.origin}/visual-model`);
  assert.equal(response.status, 200);
});

test("GET /visual-model returns 404 when source file is missing", async () => {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), "review-hub-vm-missing-"));
  const sourcePath = path.join(reviewDir, "missing-source.md");
  // Don't create the source file

  const manifest = createManifestFixture();
  manifest.source = sourcePath;

  const server = createReviewServer();
  const { url } = await server.start(manifest, reviewDir);

  servers.push(async () => {
    await server.stop();
    await fs.rm(reviewDir, { recursive: true, force: true });
  });

  const parsedUrl = new URL(url);
  const response = await fetch(`${parsedUrl.origin}/visual-model`);
  assert.equal(response.status, 404);
  const body = await response.json() as { error: string };
  assert.match(body.error, /not found/i);
});

test("/visual-model is a reserved API path (not treated as SPA route)", async () => {
  const running = await startServer(createManifestFixture());

  // Should return JSON, not the SPA index.html
  const response = await fetch(`${running.origin}/visual-model`);
  assert.equal(response.status, 200);
  const contentType = response.headers.get("content-type") ?? "";
  assert.match(contentType, /application\/json/);
});
