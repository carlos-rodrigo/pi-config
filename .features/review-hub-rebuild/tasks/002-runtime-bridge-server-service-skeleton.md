---
id: 002
status: open
depends: [001]
parent: null
created: 2026-02-27
---

# Runtime bridge + server service skeleton

Add a runtime bridge contract between `index.ts` and `server.ts` for privileged actions (pi handoff, clipboard fallback, audio regenerate) and create server-side service boundaries.

## What to do

- Define `ReviewRuntimeBridge` interface.
- Update server factory signature to accept bridge callbacks.
- Wire bridge implementation in `index.ts`:
  - `handoffFeedbackToPi(markdown)` using `pi.sendUserMessage`
  - `copyToClipboard(markdown)` fallback helper
  - `requestAudioRegeneration(...)`
- Create service-layer structure in server module (or split files):
  - `CommentService`, `ExportService`, `FinishService`, `AudioActionService` (initial scaffolding)

## Acceptance criteria

- [ ] Server can call runtime bridge without direct pi API dependency
- [ ] Existing `/review` flow still starts server and opens browser
- [ ] No regression in existing server tests
- [ ] Bridge errors are surfaced as recoverable API errors (not process crash)

## Files

- `extensions/review-hub/index.ts`
- `extensions/review-hub/lib/server.ts`
- `extensions/review-hub/lib/*service*.ts` (if split)

## Verify

```bash
cd extensions/review-hub
npm test
npm run typecheck:web
```
