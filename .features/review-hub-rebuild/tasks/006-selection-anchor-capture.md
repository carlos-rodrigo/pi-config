---
id: 006
status: open
depends: [005]
parent: null
created: 2026-02-27
---

# Text selection capture + anchor payload

Implement single-range text selection commenting with automatic composer opening and v2 anchor payload capture.

## What to do

- Capture selection events within section root only.
- Enforce single continuous range behavior.
- Build anchor payload:
  - `quote`, `prefix`, `suffix`, `startOffset`, `endOffset`, `sectionHashAtCapture`
- Auto-open composer with captured anchor + section prefill.
- Handle invalid selection (whitespace/empty) gracefully.

## Acceptance criteria

- [ ] Selecting text opens composer automatically
- [ ] Saved comment includes anchor payload in API request
- [ ] Cross-section selection is clamped/degraded with warning
- [ ] Selection capture does not trigger outside document viewport

## Files

- `extensions/review-hub/web-app/src/lib/anchor/capture.ts` (new)
- `extensions/review-hub/web-app/src/hooks/use-selection-anchor.ts` (new)
- `extensions/review-hub/web-app/src/components/comments/*`
- `extensions/review-hub/lib/server.ts` (`/comments` anchor validation)

## Verify

```bash
cd extensions/review-hub
npm run typecheck:web
npm run build:web
npm test
```
