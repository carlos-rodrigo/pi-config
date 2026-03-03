---
id: 008
status: open
depends: [004, 006]
parent: null
created: 2026-02-27
---

# Comment rail workflow (CRUD, filters, unresolved navigation)

Rebuild the review-side comment workflow around anchored comments while preserving fast unresolved navigation.

## What to do

- Rebuild comment rail/list/composer interactions.
- Keep CRUD behavior and persist status `open/resolved`.
- Keep unresolved filters + next-unresolved button/shortcut.
- Link comments to section/highlight jumps.

## Acceptance criteria

- [ ] Create/edit/delete comment flow works end-to-end
- [ ] Resolve/reopen updates unresolved counts correctly
- [ ] Next-unresolved navigation cycles predictably
- [ ] Comment click jumps to the correct section/highlight
- [ ] Empty states and filter states are clear

## Files

- `extensions/review-hub/web-app/src/components/comments/*`
- `extensions/review-hub/web-app/src/components/layout/comment-rail.tsx`
- `extensions/review-hub/web-app/src/hooks/use-unresolved-navigation.ts`
- `extensions/review-hub/lib/server.ts` (`/comments` behavior if needed)

## Verify

```bash
cd extensions/review-hub
npm run typecheck:web
npm run build:web
npm test
```
