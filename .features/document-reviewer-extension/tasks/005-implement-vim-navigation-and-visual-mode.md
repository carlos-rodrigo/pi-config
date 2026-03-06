---
id: 005
status: done
depends: [003]
parent: null
created: 2026-03-05
---

# Implement Vim-style navigation and visual selection mode

Enable keyboard-first review interactions in the frontend reviewer.

## What to do

- Implement keymap for `j`, `k`, `h`, `l`, `Ctrl+u`, `Ctrl+d`.
- Add mode management: NORMAL, VISUAL, COMMENT.
- Implement visual selection entry/exit and visible selection highlighting.
- Keep mode indicator always visible and synchronized with key handling state.

## Acceptance criteria

- [x] `j/k` navigate reliably through document content.
- [x] `Ctrl+u/d` page-scroll works predictably.
- [x] `h/l` behavior is defined and consistent (horizontal movement/pane focus per design).
- [x] Visual mode allows selecting ranges and exiting without stuck state.

## Files

- `extensions/document-reviewer/ui/keymap.js` (new)
- `extensions/document-reviewer/ui/selection.js` (new)
- `extensions/document-reviewer/ui/app.js`
- `extensions/document-reviewer/ui/styles.css`

## Verify

1. In review UI, use `j/k` and confirm line/block movement.
2. Use `Ctrl+d` then `Ctrl+u` and confirm page-chunk navigation.
3. Enter visual mode, expand selection over multiple lines, exit mode.
4. Repeat rapid key presses and confirm no mode/input lockups.

## Execution notes

- Validation commands run:
  - `node --test extensions/document-reviewer/ui/keymap.test.js extensions/document-reviewer/ui/selection.test.js`
  - `node --check extensions/document-reviewer/ui/app.js`
  - `node --check extensions/document-reviewer/ui/keymap.js`
  - `node --check extensions/document-reviewer/ui/selection.js`
  - `git diff --check -- extensions/document-reviewer/server.ts extensions/document-reviewer/ui/app.js extensions/document-reviewer/ui/index.html extensions/document-reviewer/ui/styles.css extensions/document-reviewer/ui/keymap.js extensions/document-reviewer/ui/selection.js extensions/document-reviewer/ui/keymap.test.js extensions/document-reviewer/ui/selection.test.js`
  - `npx --yes tsx <<'TS' ... TS` (local service smoke test for `/review` shell + `keymap.js`/`selection.js` asset delivery)
- Oracle review pass completed (code quality, security, performance, testing). Applied fixes in this task scope:
  - switched rapid `j/k/h/l` motion to non-animated scroll to avoid animation queue buildup;
  - cached visual-selection state transitions to avoid redundant DOM churn;
  - added keydown listener teardown and stronger selection-controller teardown test coverage;
  - added explicit keymap test coverage for `c` → COMMENT mode.
- Deferred hardening issues already tracked for later tasks (session auth headers/path redaction and Mermaid CDN vendoring in task 009).
- Manual Pi interactive verification from the Verify checklist remains required.
