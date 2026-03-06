---
id: 007
status: done
depends: [006]
parent: null
created: 2026-03-05
---

# Add sidecar persistence and stale-anchor handling

Persist comments by document and make anchors resilient to document edits.

## What to do

- Create sidecar repository (`.review/<docHash>.comments.json`).
- Persist/load threads and replies across sessions.
- Store anchor selectors (`exact`, `prefix/suffix`, offsets when available).
- Implement re-anchor on load and mark unmatched threads as `stale: true`.
- Ignore unknown/legacy metadata fields safely.

## Acceptance criteria

- [x] Threads persist after closing/reopening review session.
- [x] Anchor re-matching restores context for unchanged docs.
- [x] Changed docs mark unmatched anchors as stale, not lost.
- [x] Legacy extra fields in sidecar do not break loading.

## Files

- `extensions/document-reviewer/repository.ts` (new)
- `extensions/document-reviewer/anchors.ts` (new)
- `extensions/document-reviewer/server.ts`

## Verify

1. Add comments, close review, reopen same doc → comments are present.
2. Edit source doc minimally and reopen → most anchors remap.
3. Edit/remove anchored text and reopen → thread marked stale.
4. Add unknown field manually in sidecar JSON → load still succeeds.
