---
id: 009
status: done
depends: [001, 002, 003, 004, 005, 006, 007, 008]
parent: null
created: 2026-03-05
---

# Harden security/reliability and run final QA pass

Apply production hardening and final verification before implementation sign-off.

## What to do

- Ensure local service binds `127.0.0.1` only.
- Add ephemeral session token validation for frontend API requests.
- Add robust browser launch fallback messaging for headless/remote environments.
- Verify keyboard-only end-to-end flow and reduce cognitive-load regressions.
- Update extension docs with usage, keybindings, limitations, and troubleshooting.

## Acceptance criteria

- [x] Loopback-only binding confirmed.
- [x] Session token guard rejects unauthorized calls.
- [x] Browser launch failure path is actionable and non-blocking.
- [x] Keyboard-only review path works from open → comment → export.
- [x] `extensions/README.md` includes final reviewer docs.

## Files

- `extensions/document-reviewer.ts`
- `extensions/document-reviewer/server.ts`
- `extensions/document-reviewer/ui/*`
- `extensions/README.md`

## Verify

1. Attempt request without valid token → rejected.
2. Run full manual user flow on PRD doc using keyboard only.
3. Validate docs by following setup and usage steps from README.
4. Smoke-check existing extensions (`/open`, `/feature`) still work.
