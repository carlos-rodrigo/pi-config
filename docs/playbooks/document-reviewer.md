# Document Reviewer Extension

> When to use: Working on the document-reviewer or PR review features.

## Overview

The document-reviewer extension provides browser-based review with inline commenting for markdown files and pull requests. It runs a localhost server that renders documents and collects comments, then exports them back to the source file or PR.

## Patterns

### Localhost server security model

- Require a per-session ephemeral token on all session-scoped endpoints
- Inject the token via server-rendered bootstrap data
- Route every frontend request through one fetch helper that always applies the token header
- Scope cross-origin access to the server's own origin

```typescript
// Single fetch helper with auto-auth
async function apiFetch(path: string, options?: RequestInit) {
  return fetch(path, {
    ...options,
    headers: { ...options?.headers, "x-session-token": SESSION_TOKEN },
  });
}
```

### Selection anchoring and re-anchoring

Store a normalized `exact` selector with optional prefix/suffix + offsets. On session load, re-anchor against the current document and mark unresolved matches as `stale` rather than dropping threads.

This keeps annotations resilient across minor document edits and backward-compatible with legacy `quote` selectors.

### Comment persistence and export

- Keep per-thread reply drafts and error state in keyed maps
- If a panel re-renders via `innerHTML`, preserve pending/error updates from keyed maps
- Update active anchor marker classes in-place when possible instead of rebuilding all anchors

### Export flow state machine

Model clipboard/export flow as explicit states: `copied`, `manual-copy`, `empty`, `error`. Only clear fallback text on successful or empty outcomes to prevent accidental loss during retry failures.

### PR mode vs document mode

Both modes share the review UI but differ in:
- **Document mode:** Comments are inserted as `<!-- REVIEW: ... -->` annotations into the original file
- **PR mode:** Comments are collected and can be submitted as PR review comments

Lift payload builders and mode-specific copy into exported pure helpers for testability.

### Vim-style navigation

A pure keymap resolver (`event + mode → action`) combined with a focused selection controller keeps keyboard behavior testable and prevents state drift between mode badges, scrolling, and DOM selection.

## Constraints

- Server validates selection offsets against the source document — browser-provided line/inline hints are UX metadata, not trusted truth
- Automation-owned worktrees live under a dedicated reserved root (e.g., `<repo>-pr-review-worktrees/pr-<n>`) — never reuse or collide with user worktrees
- Worktree cleanup derives paths from validated metadata, not caller-provided strings

## Gotchas

- Mermaid diagrams in markdown: parse and sanitize returned SVG before DOM insertion; keep per-block fallback so diagram failures degrade locally
- `innerHTML` re-renders wipe form state — use keyed maps to restore drafts
- SSH/headless environments need manual-open + SSH tunnel fallback instructions (generate in a pure helper for testability)
