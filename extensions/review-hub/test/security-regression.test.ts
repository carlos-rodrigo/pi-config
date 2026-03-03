/**
 * Security hardening + regression tests for the review-hub rebuild.
 *
 * Covers:
 * - Token validation on mutation endpoints
 * - Security response headers
 * - Full lifecycle regression (create → anchor → export → finish)
 * - Negative paths on new endpoints
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createReviewServer } from "../lib/server.ts";
import type { ReviewManifest } from "../lib/manifest.ts";
import {
  readSessionTokenFromHash,
  readSessionTokenFromPath,
  readSessionTokenFromSearch,
} from "../web-app/src/hooks/use-session-token.ts";

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
    reviewDir: "/tmp/test",
    ...overrides,
  };
}

async function startServer(manifestOverrides: Partial<ReviewManifest> = {}) {
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), "sec-test-"));
  const sourcePath = path.join(reviewDir, "source.md");
  await fs.writeFile(sourcePath, "# Introduction\n\nHello world.\n\n## Body\n\nContent here.\n");

  const manifest = makeManifest({ source: sourcePath, ...manifestOverrides });
  await fs.writeFile(path.join(reviewDir, "manifest.json"), JSON.stringify(manifest));

  const server = createReviewServer();
  const { url } = await server.start(manifest, reviewDir);
  const parsedUrl = new URL(url);
  const token = parsedUrl.searchParams.get("token")!;

  return {
    origin: parsedUrl.origin,
    token,
    reviewDir,
    cleanup: async () => {
      await server.stop();
      await fs.rm(reviewDir, { recursive: true, force: true });
    },
  };
}

// ── Token validation tests ─────────────────────────────────────────────────

describe("Token validation on mutation endpoints", () => {
  test("POST /comments without token returns 401", async () => {
    const { origin, cleanup } = await startServer();
    try {
      const res = await fetch(`${origin}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sectionId: "s-intro", type: "change", priority: "medium", text: "test" }),
      });
      assert.equal(res.status, 401);
    } finally {
      await cleanup();
    }
  });

  test("POST /comments with wrong token returns 401", async () => {
    const { origin, cleanup } = await startServer();
    try {
      const res = await fetch(`${origin}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Session-Token": "wrong-token" },
        body: JSON.stringify({ sectionId: "s-intro", type: "change", priority: "medium", text: "test" }),
      });
      assert.equal(res.status, 401);
    } finally {
      await cleanup();
    }
  });

  test("POST /finish without token returns 401", async () => {
    const { origin, cleanup } = await startServer();
    try {
      const res = await fetch(`${origin}/finish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey: "k", exportHash: "h", clipboardMode: "browser" }),
      });
      assert.equal(res.status, 401);
    } finally {
      await cleanup();
    }
  });

  test("POST /export-feedback without token returns 401", async () => {
    const { origin, cleanup } = await startServer();
    try {
      const res = await fetch(`${origin}/export-feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(res.status, 401);
    } finally {
      await cleanup();
    }
  });

  test("POST /audio/regenerate without token returns 401", async () => {
    const { origin, cleanup } = await startServer();
    try {
      const res = await fetch(`${origin}/audio/regenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(res.status, 401);
    } finally {
      await cleanup();
    }
  });

  test("POST /clipboard/copy without token returns 401", async () => {
    const { origin, cleanup } = await startServer();
    try {
      const res = await fetch(`${origin}/clipboard/copy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown: "test" }),
      });
      assert.equal(res.status, 401);
    } finally {
      await cleanup();
    }
  });
});

// ── Security headers tests ─────────────────────────────────────────────────

describe("Security response headers", () => {
  test("responses include Referrer-Policy and X-Content-Type-Options", async () => {
    const { origin, token, cleanup } = await startServer();
    try {
      const res = await fetch(`${origin}/manifest.json?token=${token}`);
      assert.equal(res.headers.get("referrer-policy"), "no-referrer");
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(res.headers.get("x-frame-options"), "DENY");
    } finally {
      await cleanup();
    }
  });
});

// ── Negative path tests ────────────────────────────────────────────────────

describe("Negative path: /finish with wrong hash", () => {
  test("returns failure with hash mismatch warning", async () => {
    const { origin, token, cleanup } = await startServer();
    try {
      const res = await fetch(`${origin}/finish`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Session-Token": token },
        body: JSON.stringify({
          idempotencyKey: "test-key",
          exportHash: "0".repeat(64),
          clipboardMode: "browser",
        }),
      });
      assert.equal(res.status, 200);
      const result = await res.json() as { success: boolean; warning?: string };
      assert.equal(result.success, false);
      assert.ok(result.warning?.includes("hash mismatch"));
    } finally {
      await cleanup();
    }
  });
});

// ── Token hygiene ──────────────────────────────────────────────────────────

describe("Token hygiene", () => {
  test("readSessionTokenFromSearch extracts token correctly", () => {
    assert.equal(readSessionTokenFromSearch("?token=abc123"), "abc123");
    assert.equal(readSessionTokenFromSearch("?token="), null);
    assert.equal(readSessionTokenFromSearch("?other=value"), null);
    assert.equal(readSessionTokenFromSearch(""), null);
    assert.equal(readSessionTokenFromSearch("?token=  "), null);
  });

  test("readSessionTokenFromPath extracts /t/<token> format", () => {
    assert.equal(readSessionTokenFromPath("/t/abc123"), "abc123");
    assert.equal(readSessionTokenFromPath("/t/abc123/"), "abc123");
    assert.equal(readSessionTokenFromPath("/t/e028fa4d-f617-4558-8b2f-5b6f55e8dcb6"), "e028fa4d-f617-4558-8b2f-5b6f55e8dcb6");
    assert.equal(readSessionTokenFromPath("/"), null);
    assert.equal(readSessionTokenFromPath("/t/"), null);
  });

  test("readSessionTokenFromHash extracts #token=<token> format", () => {
    assert.equal(readSessionTokenFromHash("#token=abc123"), "abc123");
    assert.equal(readSessionTokenFromHash("token=abc123"), "abc123");
    assert.equal(readSessionTokenFromHash("#other=value"), null);
    assert.equal(readSessionTokenFromHash(""), null);
  });
});

// ── Full lifecycle regression test ─────────────────────────────────────────

describe("Full lifecycle regression: comment → export → finish", () => {
  test("end-to-end flow from comment creation to finish handoff", async () => {
    const { origin, token, cleanup } = await startServer();
    try {
      const headers = { "Content-Type": "application/json", "X-Session-Token": token };

      // 1. Create a comment with anchor
      const commentRes = await fetch(`${origin}/comments`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          sectionId: "s-intro",
          type: "change",
          priority: "high",
          text: "Fix the introduction",
          anchor: {
            version: 2,
            sectionId: "s-intro",
            quote: "Hello world",
            anchorAlgoVersion: "v2-section-text",
          },
        }),
      });
      assert.equal(commentRes.status, 200);
      const comment = await commentRes.json() as { id: string; anchor?: unknown };
      assert.ok(comment.id);
      assert.ok(comment.anchor, "anchor should be persisted");

      // 2. Create a second comment without anchor
      const comment2Res = await fetch(`${origin}/comments`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          sectionId: "s-body",
          type: "question",
          priority: "medium",
          text: "Why is this here?",
        }),
      });
      assert.equal(comment2Res.status, 200);

      // 3. Export feedback
      const exportRes = await fetch(`${origin}/export-feedback`, {
        method: "POST",
        headers,
        body: "{}",
      });
      assert.equal(exportRes.status, 200);
      const exported = await exportRes.json() as {
        markdown: string;
        exportHash: string;
        stats: { totalComments: number; openComments: number };
      };
      assert.equal(exported.stats.totalComments, 2);
      assert.equal(exported.stats.openComments, 2);
      assert.ok(exported.markdown.includes("Hello world"), "export should include anchor quote");
      assert.ok(exported.markdown.includes("[no anchor]"), "export should mark unanchored comment");
      assert.equal(exported.exportHash.length, 64);

      // 4. Finish flow
      const finishRes = await fetch(`${origin}/finish`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          idempotencyKey: "lifecycle-key-1",
          exportHash: exported.exportHash,
          clipboardMode: "browser",
        }),
      });
      assert.equal(finishRes.status, 200);
      const finishResult = await finishRes.json() as { success: boolean; handedOff: boolean };
      assert.equal(finishResult.success, true);

      // 5. Verify manifest is now reviewed
      const manifestRes = await fetch(`${origin}/manifest.json?token=${token}`);
      const manifest = await manifestRes.json() as ReviewManifest;
      assert.equal(manifest.status, "reviewed");
      assert.ok(manifest.completedAt);
      assert.equal(manifest.finishMeta?.lastFinishIdempotencyKey, "lifecycle-key-1");

      // 6. Duplicate finish returns idempotent success
      const dupRes = await fetch(`${origin}/finish`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          idempotencyKey: "lifecycle-key-1",
          exportHash: exported.exportHash,
          clipboardMode: "browser",
        }),
      });
      assert.equal(dupRes.status, 200);
      const dupResult = await dupRes.json() as { success: boolean; warning?: string };
      assert.equal(dupResult.success, true);
      assert.ok(dupResult.warning?.includes("Idempotent"));
    } finally {
      await cleanup();
    }
  });
});
