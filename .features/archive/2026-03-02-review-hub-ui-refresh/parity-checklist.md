# Review Hub UI Refresh — Parity Smoke Checklist

Date: 2026-03-02
Feature: `review-hub-ui-refresh`

## Build / Type Safety

- [x] `npm run build:web` passes
- [x] Backend TypeScript check passes
- [x] Extension test suite passes (`npm test`)

## Core Review Flows

- [x] Review manifest loads and renders in 3-column shell
- [x] Comment create/edit/delete works and persists
- [x] Comment resolve/reopen persists and updates unresolved counts
- [x] Next-unresolved navigation works (button + `N` shortcut)
- [x] TOC unresolved badges track open comment state
- [x] Done Reviewing updates completion state

## Audio / Narration Flows

- [x] Sticky bottom narration bar renders for ready audio
- [x] Play/pause/skip/speed/sync controls wired
- [x] Audio state UX handles generating/ready/failed/not-requested
- [x] Section sync uses timestamp mapping and can be toggled

## Accessibility / Keyboard

- [x] Icon-only controls include accessible names (`aria-label`)
- [x] Primary controls keyboard operable (mode toggle, next unresolved, done reviewing, player controls)
- [x] Error/status messaging uses `role="alert"` / `role="status"` where appropriate
- [x] Reduced-motion support gates nonessential animation

## Notes

- Browser/manual pass remains recommended in a live `/review` session (visual-only and with-audio) before release cut.
