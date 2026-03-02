import { test } from "node:test";
import assert from "node:assert/strict";

import { shouldHandleNextUnresolvedShortcut } from "../web-app/src/lib/unresolved-shortcut.ts";

test("shortcut only triggers on plain N in review mode with unresolved comments", () => {
  assert.equal(
    shouldHandleNextUnresolvedShortcut(
      {
        key: "n",
        defaultPrevented: false,
      },
      { mode: "review", unresolvedCount: 2 },
    ),
    true,
  );

  assert.equal(
    shouldHandleNextUnresolvedShortcut(
      {
        key: "N",
        defaultPrevented: false,
        target: { tagName: "DIV" },
      },
      { mode: "review", unresolvedCount: 1 },
    ),
    true,
  );
});

test("shortcut ignores modifier keys and editable targets", () => {
  assert.equal(
    shouldHandleNextUnresolvedShortcut(
      {
        key: "n",
        defaultPrevented: false,
        metaKey: true,
      },
      { mode: "review", unresolvedCount: 1 },
    ),
    false,
  );

  assert.equal(
    shouldHandleNextUnresolvedShortcut(
      {
        key: "n",
        defaultPrevented: false,
        ctrlKey: true,
      },
      { mode: "review", unresolvedCount: 1 },
    ),
    false,
  );

  assert.equal(
    shouldHandleNextUnresolvedShortcut(
      {
        key: "n",
        defaultPrevented: false,
        target: { tagName: "INPUT" },
      },
      { mode: "review", unresolvedCount: 1 },
    ),
    false,
  );

  assert.equal(
    shouldHandleNextUnresolvedShortcut(
      {
        key: "n",
        defaultPrevented: false,
        target: { tagName: "DIV", isContentEditable: true },
      },
      { mode: "review", unresolvedCount: 1 },
    ),
    false,
  );
});

test("shortcut ignores read mode and all-caught-up state", () => {
  assert.equal(
    shouldHandleNextUnresolvedShortcut(
      {
        key: "n",
        defaultPrevented: false,
      },
      { mode: "read", unresolvedCount: 2 },
    ),
    false,
  );

  assert.equal(
    shouldHandleNextUnresolvedShortcut(
      {
        key: "n",
        defaultPrevented: false,
      },
      { mode: "review", unresolvedCount: 0 },
    ),
    false,
  );
});
