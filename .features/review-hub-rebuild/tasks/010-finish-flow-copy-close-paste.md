---
id: 010
status: open
depends: [002, 008, 009]
parent: null
created: 2026-02-27
---

# Finish flow (copy -> close -> auto-paste) with fallback

Deliver the canonical completion flow with client-first clipboard, backend fallback, server-authoritative finish verification, and pi handoff.

## What to do

- Add `POST /finish` with:
  - idempotency key handling (durable in manifest metadata)
  - exportHash verification against canonical server export
  - status/`completedAt` update on success
  - runtime bridge call to `handoffFeedbackToPi`
- Add `POST /clipboard/copy` backend helper for clipboard permission fallback.
- Build frontend finish hook/UI:
  1. call `/export-feedback`
  2. try browser copy
  3. optional `/clipboard/copy`
  4. call `/finish`
  5. close tab on success

## Acceptance criteria

- [ ] End-to-end finish handoff sends compact markdown to pi chat
- [ ] Browser clipboard failure falls back to backend helper with warning path
- [ ] Duplicate clicks/retries do not duplicate handoff
- [ ] Finish marks manifest reviewed atomically
- [ ] Failure path keeps payload available for manual paste

## Files

- `extensions/review-hub/lib/server.ts`
- `extensions/review-hub/index.ts`
- `extensions/review-hub/web-app/src/hooks/use-finish-flow.ts` (new)
- `extensions/review-hub/web-app/src/components/export/*`

## Verify

```bash
cd extensions/review-hub
npm test
npm run typecheck:web
npm run build:web
```
