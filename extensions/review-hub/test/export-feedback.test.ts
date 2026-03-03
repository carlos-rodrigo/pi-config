import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";

import { ExportService, type ExportResult } from "../lib/services/export-service.ts";
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
      { id: "s-body", headingPath: ["Body"], headingLevel: 1, sourceTextHash: "h2" },
    ],
    comments: [],
    reviewDir: "/tmp/test-review",
    ...overrides,
  };
}

function makeComment(id: string, sectionId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    sectionId,
    type: "change" as const,
    priority: "medium" as const,
    text: `Comment ${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "open" as const,
    ...overrides,
  };
}

describe("ExportService", () => {
  const service = new ExportService();

  test("returns markdown + exportHash + stats", () => {
    const manifest = makeManifest({
      comments: [makeComment("c1", "s-intro")],
    });

    const result = service.export(manifest);

    assert.ok(result.markdown.includes("# Review Feedback"));
    assert.ok(result.exportHash.length === 64, "exportHash should be SHA-256 hex");
    assert.equal(result.stats.totalComments, 1);
    assert.equal(result.stats.openComments, 1);
    assert.equal(result.stats.resolvedComments, 0);
  });

  test("deterministic output for unchanged manifest", () => {
    const manifest = makeManifest({
      comments: [
        makeComment("c1", "s-intro"),
        makeComment("c2", "s-body"),
      ],
    });

    const result1 = service.export(manifest);
    const result2 = service.export(manifest);

    assert.equal(result1.markdown, result2.markdown);
    assert.equal(result1.exportHash, result2.exportHash);
  });

  test("resolved comments excluded by default (scope=open)", () => {
    const manifest = makeManifest({
      comments: [
        makeComment("c1", "s-intro", { status: "open" }),
        makeComment("c2", "s-body", { status: "resolved" }),
      ],
    });

    const result = service.export(manifest);

    assert.ok(result.markdown.includes("c1"));
    assert.ok(!result.markdown.includes("c2"));
    assert.equal(result.stats.openComments, 1);
    assert.equal(result.stats.resolvedComments, 1);
  });

  test("scope=all includes resolved comments", () => {
    const manifest = makeManifest({
      comments: [
        makeComment("c1", "s-intro", { status: "open" }),
        makeComment("c2", "s-body", { status: "resolved" }),
      ],
    });

    const result = service.export(manifest, { scope: "all" });

    assert.ok(result.markdown.includes("c1"));
    assert.ok(result.markdown.includes("c2"));
  });

  test("sorts by document order then creation time", () => {
    const manifest = makeManifest({
      comments: [
        makeComment("c1", "s-body", { createdAt: "2026-01-01T00:00:00.000Z" }),
        makeComment("c2", "s-intro", { createdAt: "2026-01-02T00:00:00.000Z" }),
        makeComment("c3", "s-intro", { createdAt: "2026-01-01T00:00:00.000Z" }),
      ],
    });

    const result = service.export(manifest);

    // s-intro comes before s-body in sections array
    const c3Pos = result.markdown.indexOf("Comment c3");
    const c2Pos = result.markdown.indexOf("Comment c2");
    const c1Pos = result.markdown.indexOf("Comment c1");

    assert.ok(c3Pos < c2Pos, "c3 (s-intro, earlier) should come before c2 (s-intro, later)");
    assert.ok(c2Pos < c1Pos, "c2 (s-intro) should come before c1 (s-body)");
  });

  test("includes quote snippet for anchored comments", () => {
    const manifest = makeManifest({
      comments: [
        makeComment("c1", "s-intro", {
          anchor: {
            version: 2,
            sectionId: "s-intro",
            quote: "important text here",
            anchorAlgoVersion: "v2-section-text",
          },
        }),
      ],
    });

    const result = service.export(manifest);

    assert.ok(result.markdown.includes("important text here"));
  });

  test("marks comments without anchors as [no anchor]", () => {
    const manifest = makeManifest({
      comments: [makeComment("c1", "s-intro")],
    });

    const result = service.export(manifest);

    assert.ok(result.markdown.includes("[no anchor]"));
  });

  test("output is concise/token-efficient", () => {
    const manifest = makeManifest({
      comments: [
        makeComment("c1", "s-intro"),
        makeComment("c2", "s-body"),
      ],
    });

    const result = service.export(manifest);
    const lines = result.markdown.split("\n").filter(Boolean);

    // Header lines + 2 comments × 3 lines each = roughly 10 lines
    assert.ok(lines.length < 20, `Expected concise output, got ${lines.length} lines`);
  });

  test("empty comments returns valid markdown with zero stats", () => {
    const manifest = makeManifest({ comments: [] });

    const result = service.export(manifest);

    assert.ok(result.markdown.includes("# Review Feedback"));
    assert.equal(result.stats.totalComments, 0);
    assert.equal(result.stats.openComments, 0);
    assert.equal(result.stats.resolvedComments, 0);
    assert.ok(result.exportHash.length === 64);
  });
});

// ── Endpoint integration test ──────────────────────────────────────────────

describe("POST /export-feedback endpoint", () => {
  test("returns export result via HTTP", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");

    // Create temp review dir with source + manifest
    const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), "export-test-"));
    const sourcePath = path.join(reviewDir, "source.md");
    await fs.writeFile(sourcePath, "# Test\n\nContent here.\n");

    const manifest: ReviewManifest = {
      ...makeManifest({ source: sourcePath }),
      comments: [makeComment("c1", "s-intro")],
    };

    // Write manifest file for loadManifest
    await fs.writeFile(
      path.join(reviewDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );

    const server = createReviewServer();
    const { url } = await server.start(manifest, reviewDir);

    try {
      const parsedUrl = new URL(url);
      const token = parsedUrl.searchParams.get("token")!;

      const res = await fetch(`${parsedUrl.origin}/export-feedback`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Token": token,
        },
        body: JSON.stringify({}),
      });

      assert.equal(res.status, 200);

      const result = await res.json() as ExportResult;
      assert.ok(result.markdown.includes("# Review Feedback"));
      assert.ok(result.exportHash.length === 64);
      assert.equal(result.stats.totalComments, 1);
    } finally {
      await server.stop();
      await fs.rm(reviewDir, { recursive: true, force: true });
    }
  });
});
