---
id: 007
status: open
depends: [006]
parent: null
created: 2026-02-27
---

# Re-anchor highlights + degraded fallback

Render persisted anchored comments back onto document text with deterministic re-anchor strategy and degraded fallback handling.

## What to do

- Implement re-anchor strategy:
  1. offset-based match + quote verification
  2. quote/context fallback match
  3. section-level degraded fallback
- Render highlight decorations for exact/reanchored comments.
- Show degraded indicator for comments that cannot be anchored precisely.
- Clicking comment should navigate to highlight or section fallback.

## Acceptance criteria

- [ ] Existing anchored comments highlight correctly after refresh
- [ ] Reanchored matches are differentiated from exact matches
- [ ] Unresolvable anchors degrade to section-level with explicit warning
- [ ] No hard crash on corrupt/missing anchor payloads

## Files

- `extensions/review-hub/web-app/src/lib/anchor/reanchor.ts` (new)
- `extensions/review-hub/web-app/src/components/document/highlight-layer.tsx` (new)
- `extensions/review-hub/web-app/src/components/comments/*`

## Verify

```bash
cd extensions/review-hub
npm run typecheck:web
npm run build:web
npm test
```
