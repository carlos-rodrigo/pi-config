# Current Feature: Review Hub UI Refresh

Started: 2026-02-27
PRD: `.features/review-hub-ui-refresh/prd.md`
Design: `.features/review-hub-ui-refresh/design.md`

## Progress

- [x] 001 - Create React + Vite + Tailwind + shadcn frontend workspace
- [x] 002 - Update review server to safely serve built frontend dist
- [x] 003 - Implement typed React API client and session token boot flow
- [x] 004 - Build 3-column app shell with Read/Review mode
- [x] 005 - Integrate server-generated visual content and TOC active-section sync
- [x] 006 - Migrate comment CRUD UI to React shadcn comment rail
- [x] 007 - Add additive comment status persistence (open/resolved) in manifest/API
- [x] 008 - Add unresolved workflow and section-level unresolved badges
- [ ] 009 - Build sticky bottom narration player with sync controls and audio-state UX
- [ ] 010 - Replace functional emojis with Lucide icons across app and visual controls
- [ ] 011 - Add Framer Motion system with reduced-motion behavior
- [ ] 012 - Accessibility hardening, parity smoke checks, and README migration docs

## Dependency Notes

- Task 001 is the frontend foundation.
- Task 002 enables runtime serving of the new build output.
- Tasks 003-006 establish parity UI behavior.
- Task 007 unlocks true unresolved comment workflow for task 008.
- Tasks 009-011 polish interaction quality.
- Task 012 is the release-safety gate.

## Patterns / Guardrails

- Keep backend review pipeline behavior unchanged except additive schema/server serving changes.
- Preserve manifest compatibility with existing review files.
- Prefer additive API evolution; avoid breaking route contracts.
- Respect localhost-only and token-based mutation security model.
