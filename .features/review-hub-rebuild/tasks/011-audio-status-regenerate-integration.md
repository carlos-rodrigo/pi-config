---
id: 011
status: done
depends: [002, 004]
parent: null
created: 2026-02-27
---

# Audio status + regenerate integration

Integrate audio lifecycle UX with backend actions for `not-requested`, `generating`, `ready`, `failed` states.

## What to do

- Add `GET /audio/status` and `POST /audio/regenerate`.
- Wire runtime bridge callback in `index.ts` to trigger regeneration.
- Build frontend status hook + UI cards/actions.
- Keep existing playback flow for `ready` state.

## Acceptance criteria

- [ ] UI state reflects backend audio lifecycle correctly
- [ ] Regenerate action is available in failed/not-requested states
- [ ] Generating state updates without app breakage
- [ ] Ready state transitions to active player UX
- [ ] Existing review flow continues if audio actions fail

## Files

- `extensions/review-hub/lib/server.ts`
- `extensions/review-hub/index.ts`
- `extensions/review-hub/web-app/src/hooks/use-audio-status.ts` (new)
- `extensions/review-hub/web-app/src/components/audio/*`

## Verify

```bash
cd extensions/review-hub
npm test
npm run typecheck:web
npm run build:web
```
