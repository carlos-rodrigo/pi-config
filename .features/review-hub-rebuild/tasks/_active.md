# Current Feature: Review Hub Rebuild (Charm Edition)

Started: 2026-02-27
PRD: `.features/review-hub-rebuild/prd.md`
Design: `.features/review-hub-rebuild/design.md`

## Progress

- [x] 001 - Manifest v2 schema + normalization
- [x] 002 - Runtime bridge + server service skeleton
- [x] 003 - Canonical visual model endpoint (`/visual-model`)
- [x] 004 - Fresh React shell (Read/Review) foundation
- [ ] 005 - Document viewport with `react-markdown`
- [ ] 006 - Text selection capture + anchor payload
- [ ] 007 - Re-anchor highlights + degraded fallback UX
- [ ] 008 - Comment rail workflow (CRUD, filters, unresolved nav)
- [ ] 009 - Compact export endpoint (`/export-feedback`) with hash
- [ ] 010 - Finish flow UX (copy/close/auto-paste + fallback)
- [ ] 011 - Audio status + regenerate flow integration
- [ ] 012 - Security hardening + migration/regression tests

## Dependency Notes

- Task 001 is the schema/migration base for all comment-anchor work.
- Task 002 introduces runtime bridge needed by finish and audio actions.
- Tasks 004-008 are the core frontend rebuild path.
- Tasks 009-010 deliver token-efficient handoff and completion behavior.
- Task 012 is the quality/security gate before loop execution.

## Guardrails

- Keep localhost-only + token-gated mutation security model.
- Preserve existing review generation and TTS provider pipeline behavior unless required by PRD.
- Avoid re-introducing legacy `web/` implementation patterns in the new app.
- Export format must stay compact and deterministic for token economy.
