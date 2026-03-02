---
id: 006
status: open
depends: [004,003]
parent: null
created: 2026-02-27
---

# Migrate comment CRUD UI to React shadcn comment rail

Rebuild comment panel UX with shadcn components while preserving current CRUD behavior and manifest mapping.

## What to do

- Implement comment rail with filters and count summary.
- Implement comment composer for create/edit.
- Keep section anchoring and priority/type fields.
- Implement delete and complete-review actions.

## Acceptance criteria

- [ ] Create/edit/delete comment works end-to-end.
- [ ] Filter controls update visible comment list.
- [ ] Section/title mapping displays correctly.
- [ ] Done Reviewing updates manifest status as before.

## Files

- `extensions/review-hub/web-app/src/components/comments/*`
- `extensions/review-hub/web-app/src/components/layout/CommentRail.tsx`

## Verify

```bash
cd ~/.pi/agent/extensions/review-hub
npm run build:web
# In browser: create/edit/delete comments and click Done Reviewing.
# Confirm manifest updates and no regressions.
```
