---
id: 002
status: done
depends: [001]
parent: null
created: 2026-03-05
---

# Build local review session service (session/document/health)

Implement the local loopback HTTP service used by the frontend reviewer UI.

## What to do

- Create service module to run on `127.0.0.1` with ephemeral port.
- Implement session creation endpoint returning `{ sessionId, reviewUrl, title }`.
- Implement document payload endpoint for markdown source data.
- Implement session health endpoint.
- Add in-memory session lifecycle tracking with timeout/cleanup hooks.

## Acceptance criteria

- [ ] `POST /api/review/session` works for valid markdown files.
- [ ] `GET /api/review/session/:id/document` returns expected payload.
- [ ] `GET /api/review/session/:id/health` returns session status.
- [ ] Service binds localhost only and fails safely if port allocation fails.

## Files

- `extensions/document-reviewer/server.ts` (new)
- `extensions/document-reviewer/session-store.ts` (new)
- `extensions/document-reviewer.ts` (wire command → service)

## Verify

- Start `/review` and inspect logs/status messages.
- Hit health endpoint via browser/CLI URL shown by extension → receives `{ ok: true }`.
- Create invalid session request path → receives validation error without crash.
