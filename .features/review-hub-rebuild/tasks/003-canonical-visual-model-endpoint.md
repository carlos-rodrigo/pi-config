---
id: 003
status: done
depends: [001]
parent: null
created: 2026-02-27
---

# Canonical visual model endpoint (`/visual-model`)

Expose backend-generated section render payload so frontend does not derive section identity independently.

## What to do

- Add server endpoint `GET /visual-model`.
- Build `RenderSection[]` from manifest + source line ranges.
- Include deterministic ordering and section metadata required by frontend.
- Keep `/visual` and `/visual-styles` working during migration.

## Acceptance criteria

- [ ] `/visual-model` returns section array with stable `sectionId`
- [ ] Payload matches manifest section order
- [ ] Missing source/invalid state returns explicit non-500 error where possible
- [ ] Existing reserved API path behavior remains intact

## Files

- `extensions/review-hub/lib/server.ts`
- `extensions/review-hub/lib/visual-model.ts` (new)
- `extensions/review-hub/test/review-flow.test.ts` (or new test file)

## Verify

```bash
cd extensions/review-hub
npm test
```
