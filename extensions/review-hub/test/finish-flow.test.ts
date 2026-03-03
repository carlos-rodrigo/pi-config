import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { FinishService, type FinishRequest } from "../lib/services/finish-service.ts";
import { ExportService } from "../lib/services/export-service.ts";
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
    comments: [
      {
        id: "c1",
        sectionId: "s-intro",
        type: "change",
        priority: "medium",
        text: "Fix this",
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "open",
      },
    ],
    reviewDir: "/tmp/test",
    ...overrides,
  };
}

// ── FinishService unit tests ───────────────────────────────────────────────

describe("FinishService", () => {
  test("finish succeeds with valid export hash", async () => {
    const bridge = createNoOpBridge();
    const exportService = new ExportService();
    const finishService = new FinishService(bridge, exportService);

    const manifest = makeManifest();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "finish-test-"));

    try {
      await fs.writeFile(path.join(tmpDir, "manifest.json"), JSON.stringify(manifest));

      const exported = exportService.export(manifest);
      const result = await finishService.finish(manifest, tmpDir, {
        idempotencyKey: "key-1",
        exportHash: exported.exportHash,
        clipboardMode: "browser",
      });

      assert.equal(result.success, true);
      assert.equal(result.handedOff, true);
      assert.equal(manifest.status, "reviewed");
      assert.ok(manifest.completedAt);
      assert.equal(manifest.finishMeta?.lastFinishIdempotencyKey, "key-1");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("finish rejects mismatched export hash", async () => {
    const bridge = createNoOpBridge();
    const exportService = new ExportService();
    const finishService = new FinishService(bridge, exportService);

    const manifest = makeManifest();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "finish-test-"));

    try {
      await fs.writeFile(path.join(tmpDir, "manifest.json"), JSON.stringify(manifest));

      const result = await finishService.finish(manifest, tmpDir, {
        idempotencyKey: "key-1",
        exportHash: "wrong-hash",
        clipboardMode: "browser",
      });

      assert.equal(result.success, false);
      assert.ok(result.warning?.includes("hash mismatch"));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("finish returns idempotent success for duplicate key", async () => {
    const bridge = createNoOpBridge();
    const exportService = new ExportService();
    const finishService = new FinishService(bridge, exportService);

    const manifest = makeManifest();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "finish-test-"));

    try {
      await fs.writeFile(path.join(tmpDir, "manifest.json"), JSON.stringify(manifest));

      const exported = exportService.export(manifest);

      // First finish
      await finishService.finish(manifest, tmpDir, {
        idempotencyKey: "key-dup",
        exportHash: exported.exportHash,
        clipboardMode: "browser",
      });

      // Duplicate finish with same key
      const result = await finishService.finish(manifest, tmpDir, {
        idempotencyKey: "key-dup",
        exportHash: exported.exportHash,
        clipboardMode: "browser",
      });

      assert.equal(result.success, true);
      // Should not error even though already finished
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("finish uses backend clipboard fallback", async () => {
    let clipboardContent = "";
    const bridge: ReviewRuntimeBridge = {
      ...createNoOpBridge(),
      copyToClipboard: async (md) => {
        clipboardContent = md;
        return { copied: true };
      },
    };

    const exportService = new ExportService();
    const finishService = new FinishService(bridge, exportService);

    const manifest = makeManifest();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "finish-test-"));

    try {
      await fs.writeFile(path.join(tmpDir, "manifest.json"), JSON.stringify(manifest));

      const exported = exportService.export(manifest);
      const result = await finishService.finish(manifest, tmpDir, {
        idempotencyKey: "key-clip",
        exportHash: exported.exportHash,
        clipboardMode: "backend-fallback",
      });

      assert.equal(result.success, true);
      assert.equal(result.copiedByBackend, true);
      assert.ok(clipboardContent.includes("# Review Feedback"));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("finish succeeds even if handoff fails (non-fatal)", async () => {
    const bridge: ReviewRuntimeBridge = {
      ...createNoOpBridge(),
      handoffFeedbackToPi: async () => {
        throw new Error("pi not available");
      },
    };

    const exportService = new ExportService();
    const finishService = new FinishService(bridge, exportService);

    const manifest = makeManifest();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "finish-test-"));

    try {
      await fs.writeFile(path.join(tmpDir, "manifest.json"), JSON.stringify(manifest));

      const exported = exportService.export(manifest);
      const result = await finishService.finish(manifest, tmpDir, {
        idempotencyKey: "key-hf",
        exportHash: exported.exportHash,
        clipboardMode: "browser",
      });

      assert.equal(result.success, true);
      assert.equal(result.handedOff, false);
      assert.ok(result.warning?.includes("handoff failed"));
      assert.equal(manifest.status, "reviewed"); // Still marked reviewed
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Endpoint integration test ──────────────────────────────────────────────

describe("POST /finish endpoint", () => {
  test("finish flow via HTTP returns success", async () => {
    const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), "finish-ep-"));
    const sourcePath = path.join(reviewDir, "source.md");
    await fs.writeFile(sourcePath, "# Test\n\nContent.\n");

    const manifest = makeManifest({ source: sourcePath });
    await fs.writeFile(path.join(reviewDir, "manifest.json"), JSON.stringify(manifest));

    const server = createReviewServer();
    const { url } = await server.start(manifest, reviewDir);

    try {
      const parsedUrl = new URL(url);
      const token = parsedUrl.searchParams.get("token")!;

      // First get the export hash
      const exportRes = await fetch(`${parsedUrl.origin}/export-feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Session-Token": token },
        body: "{}",
      });
      const exportResult = await exportRes.json() as { exportHash: string };

      // Then finish
      const finishRes = await fetch(`${parsedUrl.origin}/finish`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Session-Token": token },
        body: JSON.stringify({
          idempotencyKey: "test-key-1",
          exportHash: exportResult.exportHash,
          clipboardMode: "browser",
        }),
      });

      assert.equal(finishRes.status, 200);
      const finishResult = await finishRes.json() as { success: boolean; handedOff: boolean };
      assert.equal(finishResult.success, true);
    } finally {
      await server.stop();
      await fs.rm(reviewDir, { recursive: true, force: true });
    }
  });
});

describe("POST /clipboard/copy endpoint", () => {
  test("copies markdown to clipboard via bridge", async () => {
    const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), "clip-ep-"));
    const sourcePath = path.join(reviewDir, "source.md");
    await fs.writeFile(sourcePath, "# Test\n\nContent.\n");

    const manifest = makeManifest({ source: sourcePath });
    await fs.writeFile(path.join(reviewDir, "manifest.json"), JSON.stringify(manifest));

    const server = createReviewServer();
    const { url } = await server.start(manifest, reviewDir);

    try {
      const parsedUrl = new URL(url);
      const token = parsedUrl.searchParams.get("token")!;

      const res = await fetch(`${parsedUrl.origin}/clipboard/copy`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Session-Token": token },
        body: JSON.stringify({ markdown: "# Test feedback" }),
      });

      assert.equal(res.status, 200);
      const result = await res.json() as { copied: boolean };
      assert.equal(result.copied, true);
    } finally {
      await server.stop();
      await fs.rm(reviewDir, { recursive: true, force: true });
    }
  });
});
