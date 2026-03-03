import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveAnchor,
  type AnchorResolution,
} from "../web-app/src/lib/anchor/reanchor.ts";

// ── resolveAnchor: exact offset match ──────────────────────────────────────

test("resolveAnchor returns exact match when offset + quote match", () => {
  const sectionText = "This is the section with important content here.";
  const result = resolveAnchor({
    quote: "important content",
    startOffset: 25,
    endOffset: 42,
    sectionText,
  });

  assert.equal(result.state, "exact");
  assert.equal(result.startOffset, 25);
  assert.equal(result.endOffset, 42);
  assert.equal(result.warning, undefined);
});

test("resolveAnchor returns exact match when offsets are omitted but quote is found", () => {
  const sectionText = "Section with target text in it.";
  const result = resolveAnchor({
    quote: "target text",
    sectionText,
  });

  assert.equal(result.state, "exact");
  assert.equal(result.startOffset, 13);
  assert.equal(result.endOffset, 24);
});

// ── resolveAnchor: reanchored (quote found at different offset) ────────────

test("resolveAnchor returns reanchored when offset is wrong but quote found", () => {
  const sectionText = "Edited section now has important content here.";
  const result = resolveAnchor({
    quote: "important content",
    startOffset: 100, // stale offset
    endOffset: 117,
    sectionText,
  });

  assert.equal(result.state, "reanchored");
  assert.ok(typeof result.startOffset === "number");
  assert.ok(typeof result.endOffset === "number");
  assert.ok(result.warning);
});

// ── resolveAnchor: reanchored via prefix/suffix context ────────────────────

test("resolveAnchor uses prefix/suffix to disambiguate when quote appears multiple times", () => {
  const sectionText = "The cat sat. The dog ran. The cat played.";
  const result = resolveAnchor({
    quote: "The cat",
    prefix: "ran.",
    suffix: "played",
    startOffset: 100, // stale
    endOffset: 107,
    sectionText,
  });

  // Should find the second "The cat" (near "ran." prefix and "played" suffix)
  assert.ok(result.state === "exact" || result.state === "reanchored");
  assert.equal(result.startOffset, 26);
  assert.equal(result.endOffset, 33);
});

// ── resolveAnchor: degraded ────────────────────────────────────────────────

test("resolveAnchor returns degraded when quote not found", () => {
  const sectionText = "Completely rewritten section content.";
  const result = resolveAnchor({
    quote: "original text that no longer exists",
    startOffset: 0,
    endOffset: 34,
    sectionText,
  });

  assert.equal(result.state, "degraded");
  assert.equal(result.startOffset, undefined);
  assert.equal(result.endOffset, undefined);
  assert.ok(result.warning);
});

test("resolveAnchor returns degraded for empty quote", () => {
  const result = resolveAnchor({
    quote: "",
    sectionText: "Some section text",
  });

  assert.equal(result.state, "degraded");
});

// ── resolveAnchor: normalization ───────────────────────────────────────────

test("resolveAnchor normalizes whitespace for matching", () => {
  const sectionText = "This  has   extra   spaces.";
  const result = resolveAnchor({
    quote: "has extra spaces",
    sectionText,
  });

  assert.ok(result.state === "exact" || result.state === "reanchored");
  assert.ok(typeof result.startOffset === "number");
});

// ── resolveAnchor: edge cases ──────────────────────────────────────────────

test("resolveAnchor handles truncated quote (with ellipsis)", () => {
  const longContent = "x".repeat(300);
  const sectionText = `Start ${longContent} end.`;
  // The captured quote was truncated with ellipsis
  const truncatedQuote = "x".repeat(280) + "…";

  const result = resolveAnchor({
    quote: truncatedQuote,
    sectionText,
  });

  // Should find using the non-ellipsis prefix
  assert.ok(result.state !== "degraded", "should not degrade for truncated quotes");
});

test("resolveAnchor handles missing sectionText gracefully", () => {
  const result = resolveAnchor({
    quote: "something",
    sectionText: "",
  });

  assert.equal(result.state, "degraded");
});
