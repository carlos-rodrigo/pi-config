---
id: 006
status: done
depends: [002, 005]
parent: null
created: 2026-03-05
---

# Implement threaded comments (plain-text only)

Allow adding comments to selected ranges and viewing thread conversations.

## What to do

- Add API endpoint to create a new thread from current selection anchor.
- Add API endpoint to append replies to an existing thread.
- Build comment composer and threads panel in frontend.
- Enforce plain-text comment model only (no type/tag/severity/status classification fields).
- Validate empty comments and show friendly error states.

## Acceptance criteria

- [x] New thread can be created from selected text.
- [x] Replies can be added to an existing thread.
- [x] Comment UI has no classification controls.
- [x] Empty comments are rejected with clear message.
- [x] Thread list and anchor focus stay in sync.

## Files

- `extensions/document-reviewer/server.ts`
- `extensions/document-reviewer/ui/comment-composer.js` (new)
- `extensions/document-reviewer/ui/threads-panel.js` (new)
- `extensions/document-reviewer/ui/app.js`

## Verify

1. Select text, add comment `C1` → thread appears.
2. Add reply `C1.1` → thread updates in order.
3. Confirm no type/tag/severity inputs exist.
4. Submit empty comment → validation message shown, nothing saved.

## Execution notes

- Validation commands run:
  - `node --test extensions/document-reviewer/ui/keymap.test.js extensions/document-reviewer/ui/selection.test.js extensions/document-reviewer/ui/comment-composer.test.js extensions/document-reviewer/ui/threads-panel.test.js`
  - `npx --yes tsx --test extensions/document-reviewer/server.comments.test.ts`
  - `node --check extensions/document-reviewer/ui/app.js`
  - `node --check extensions/document-reviewer/ui/comment-composer.js`
  - `node --check extensions/document-reviewer/ui/threads-panel.js`
  - `git diff --check -- extensions/document-reviewer/server.ts extensions/document-reviewer/ui/index.html extensions/document-reviewer/ui/styles.css extensions/document-reviewer/ui/app.js extensions/document-reviewer/ui/comment-composer.js extensions/document-reviewer/ui/threads-panel.js extensions/document-reviewer/ui/comment-composer.test.js extensions/document-reviewer/ui/threads-panel.test.js extensions/document-reviewer/server.comments.test.ts`
  - `npx --yes tsx <<'TS' ... TS` (local review service smoke test covering review shell render, threaded comment endpoints, and new UI asset delivery)
- Oracle review pass completed (code quality, security, performance, testing). Applied task-scope fixes:
  - hardened comment payload validation to reject non-object JSON with 400 (instead of bubbling to 500);
  - enforced JSON content-type for comment/reply POSTs;
  - preserved reply drafts across rerenders and stabilized threads summary suffix behavior;
  - reduced avoidable UI churn by removing duplicate thread-list rerenders on focus and avoiding full thread refetch after successful thread creation;
  - expanded automated coverage for reply validation edge cases and comment-composer boundary/error behavior.
- Remaining hardening (localhost request token/origin policy) is intentionally deferred to task 009 security hardening scope.
- Manual Pi interactive verification from the Verify checklist remains required.
