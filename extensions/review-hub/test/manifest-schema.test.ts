import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { loadManifest, type ReviewManifest } from "../lib/manifest.ts";

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

test("loadManifest normalizes legacy manifests without schemaVersion", async () => {
  const { manifestPath } = await writeManifestFixture({
    id: "review-legacy",
    source: "./doc.md",
    sourceHash: "legacy-hash",
    reviewType: "prd",
    language: "en",
    createdAt: "2026-03-03T00:00:00.000Z",
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
    comments: [
      {
        id: "c-legacy",
        sectionId: "s-intro",
        type: "change",
        priority: "medium",
        text: "Legacy comment",
        createdAt: "2026-03-03T00:01:00.000Z",
      },
    ],
  });

  const loaded = await loadManifest(manifestPath);

  assert.equal(loaded.schemaVersion, 2);
  assert.equal(loaded.comments.length, 1);
  assert.equal(loaded.comments[0]?.id, "c-legacy");
  assert.equal(loaded.comments[0]?.anchor, undefined);
});

test("loadManifest rejects unknown schema versions", async () => {
  const { manifestPath } = await writeManifestFixture({
    ...createManifestBase(),
    schemaVersion: 999,
  });

  await assert.rejects(
    () => loadManifest(manifestPath),
    /Unsupported manifest schemaVersion/i,
  );
});

test("loadManifest rejects invalid top-level enum fields", async () => {
  const { manifestPath } = await writeManifestFixture({
    ...createManifestBase(),
    schemaVersion: 2,
    reviewType: "spec",
  });

  await assert.rejects(
    () => loadManifest(manifestPath),
    /unsupported review type/i,
  );
});

test("loadManifest drops corrupt anchors and keeps comment", async () => {
  const { manifestPath } = await writeManifestFixture({
    ...createManifestBase(),
    schemaVersion: 2,
    comments: [
      {
        id: "c-corrupt",
        sectionId: "s-intro",
        type: "concern",
        priority: "high",
        text: "Anchor should degrade",
        createdAt: "2026-03-03T00:02:00.000Z",
        anchor: {
          version: 2,
          sectionId: "s-intro",
          quote: 42,
          anchorAlgoVersion: "v2-section-text",
        },
      },
      {
        id: "c-valid",
        sectionId: "s-intro",
        type: "question",
        priority: "low",
        text: "Anchor should survive",
        createdAt: "2026-03-03T00:03:00.000Z",
        anchor: {
          version: 2,
          sectionId: "s-other",
          quote: "Valid quote",
          prefix: "prefix",
          suffix: "suffix",
          startOffset: 5,
          endOffset: 16,
          sectionHashAtCapture: "   section-hash   ",
          anchorAlgoVersion: "v2-section-text",
        },
      },
    ],
  });

  const loaded = await loadManifest(manifestPath);

  assert.equal(loaded.comments.length, 2);
  assert.equal(loaded.comments[0]?.id, "c-corrupt");
  assert.equal(loaded.comments[0]?.anchor, undefined);

  assert.equal(loaded.comments[1]?.id, "c-valid");
  assert.equal(loaded.comments[1]?.anchor?.quote, "Valid quote");
  assert.equal(loaded.comments[1]?.anchor?.anchorAlgoVersion, "v2-section-text");
  assert.equal(loaded.comments[1]?.anchor?.sectionId, "s-intro");
  assert.equal(loaded.comments[1]?.anchor?.sectionHashAtCapture, undefined);
});

function createManifestBase(): Omit<ReviewManifest, "schemaVersion"> {
  return {
    id: "review-001",
    source: "./doc.md",
    sourceHash: "fixture-hash",
    reviewType: "prd",
    language: "en",
    createdAt: "2026-03-03T00:00:00.000Z",
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
  };
}

async function writeManifestFixture(manifest: Record<string, unknown>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-hub-manifest-schema-"));
  tmpDirs.push(dir);

  const manifestPath = path.join(dir, `${manifest.id ?? "review-001"}.manifest.json`);
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  return { dir, manifestPath };
}
