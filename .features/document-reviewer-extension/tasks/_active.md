# Current Feature: document-reviewer-extension

Started: 2026-03-05
PRD: `.features/document-reviewer-extension/prd.md`
Design: `.features/document-reviewer-extension/design.md`

## Progress

- [x] 001 - Scaffold `/review` extension command and launcher
- [x] 002 - Build local review session service (session/doc/health)
- [x] 003 - Build frontend reviewer shell + markdown rendering
- [x] 004 - Add Mermaid static rendering + graceful fallback
- [x] 005 - Implement Vim-style navigation + visual selection mode
- [x] 006 - Implement threaded comments API + UI (plain comments only)
- [x] 007 - Add sidecar persistence + anchor re-matching/stale handling
- [x] 008 - Implement End Review export + clipboard fallback UX
- [x] 009 - Harden reliability/security + docs and final QA

## Key Constraints

- Comment model is **plain comment text only** (no type/tag/severity/status fields).
- End review output format is plain-text bullet list.
- Feature is frontend-primary reviewer UI launched from Pi `/review` flow.

## Verification Approach

Current repo does not yet provide a dedicated automated test harness for this extension.
Tasks include concrete manual verification loops and command-level checks where possible.
