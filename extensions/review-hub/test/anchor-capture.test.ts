import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeTextForAnchoring,
  buildAnchorFromSelection,
  MAX_QUOTE_LENGTH,
  MAX_CONTEXT_LENGTH,
} from "../web-app/src/lib/anchor/capture.ts";

// ── normalizeTextForAnchoring tests ────────────────────────────────────────

test("normalizeTextForAnchoring converts CRLF to LF", () => {
  assert.equal(normalizeTextForAnchoring("hello\r\nworld"), "hello\nworld");
});

test("normalizeTextForAnchoring collapses runs of whitespace to single space", () => {
  assert.equal(normalizeTextForAnchoring("hello    world"), "hello world");
  assert.equal(normalizeTextForAnchoring("hello\t\tworld"), "hello world");
});

test("normalizeTextForAnchoring preserves single newlines", () => {
  assert.equal(normalizeTextForAnchoring("hello\nworld"), "hello\nworld");
});

test("normalizeTextForAnchoring trims", () => {
  assert.equal(normalizeTextForAnchoring("  hello  "), "hello");
});

// ── buildAnchorFromSelection tests ─────────────────────────────────────────

test("buildAnchorFromSelection builds correct payload from simple selection", () => {
  const sectionText = "This is section text with important content here.";
  const selectedQuote = "important content";
  const sectionId = "s-intro";
  const sectionHash = "abc123";

  const anchor = buildAnchorFromSelection({
    sectionId,
    sectionText,
    selectedQuote,
    sectionHashAtCapture: sectionHash,
  });

  assert.equal(anchor.version, 2);
  assert.equal(anchor.sectionId, sectionId);
  assert.equal(anchor.quote, "important content");
  assert.equal(anchor.anchorAlgoVersion, "v2-section-text");
  assert.equal(anchor.sectionHashAtCapture, sectionHash);
  assert.ok(typeof anchor.startOffset === "number");
  assert.ok(typeof anchor.endOffset === "number");
  assert.ok((anchor.endOffset ?? 0) > (anchor.startOffset ?? 0));
});

test("buildAnchorFromSelection captures prefix and suffix context", () => {
  const sectionText = "Before context. The selected text is here. After context.";
  const selectedQuote = "The selected text";

  const anchor = buildAnchorFromSelection({
    sectionId: "s-test",
    sectionText,
    selectedQuote,
  });

  assert.ok(anchor.prefix, "should have prefix context");
  assert.ok(anchor.suffix, "should have suffix context");
  assert.ok(anchor.prefix!.includes("Before"));
  assert.ok(anchor.suffix!.includes("After"));
});

test("buildAnchorFromSelection truncates long quotes", () => {
  const longText = "x".repeat(500);
  const sectionText = `Start ${longText} end.`;

  const anchor = buildAnchorFromSelection({
    sectionId: "s-test",
    sectionText,
    selectedQuote: longText,
  });

  assert.ok(anchor.quote.length <= MAX_QUOTE_LENGTH + 1, "quote should be truncated");
});

test("buildAnchorFromSelection returns null for empty/whitespace selection", () => {
  const anchor = buildAnchorFromSelection({
    sectionId: "s-test",
    sectionText: "Some text",
    selectedQuote: "   ",
  });

  assert.equal(anchor, null);
});

test("buildAnchorFromSelection returns null for empty string selection", () => {
  const anchor = buildAnchorFromSelection({
    sectionId: "s-test",
    sectionText: "Some text",
    selectedQuote: "",
  });

  assert.equal(anchor, null);
});

test("buildAnchorFromSelection handles selection at start of section", () => {
  const sectionText = "First words of the section. More content.";
  const selectedQuote = "First words";

  const anchor = buildAnchorFromSelection({
    sectionId: "s-test",
    sectionText,
    selectedQuote,
  });

  assert.ok(anchor);
  assert.equal(anchor.startOffset, 0);
  assert.ok(!anchor.prefix || anchor.prefix.length === 0);
});

test("buildAnchorFromSelection handles selection at end of section", () => {
  const sectionText = "Some content. Last words here";
  const selectedQuote = "Last words here";

  const anchor = buildAnchorFromSelection({
    sectionId: "s-test",
    sectionText,
    selectedQuote,
  });

  assert.ok(anchor);
  assert.ok(!anchor.suffix || anchor.suffix.length === 0);
});

test("buildAnchorFromSelection limits prefix/suffix to MAX_CONTEXT_LENGTH", () => {
  const longPrefix = "a".repeat(200);
  const longSuffix = "b".repeat(200);
  const sectionText = `${longPrefix}TARGET${longSuffix}`;

  const anchor = buildAnchorFromSelection({
    sectionId: "s-test",
    sectionText,
    selectedQuote: "TARGET",
  });

  assert.ok(anchor);
  assert.ok((anchor.prefix?.length ?? 0) <= MAX_CONTEXT_LENGTH);
  assert.ok((anchor.suffix?.length ?? 0) <= MAX_CONTEXT_LENGTH);
});
