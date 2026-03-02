---
id: 008
status: open
depends: [007,006,005]
parent: null
created: 2026-02-27
---

# Add unresolved workflow and section-level unresolved badges

Use persisted comment status to add “next unresolved” navigation and unresolved counts per section in TOC/comment rail.

## What to do

- Add unresolved queue computation from comments.
- Implement “next unresolved” action and keyboard shortcut.
- Show unresolved badges in TOC section items.
- Reflect resolved/open state in comment cards.

## Acceptance criteria

- [ ] Next-unresolved cycles through open comments predictably.
- [ ] TOC unresolved counts match comment state.
- [ ] Resolving a comment updates counts immediately.
- [ ] “All caught up” state appears when no unresolved items remain.

## Files

- `extensions/review-hub/web-app/src/components/comments/*`
- `extensions/review-hub/web-app/src/components/layout/TocRail.tsx`
- `extensions/review-hub/web-app/src/hooks/*`

## Verify

```bash
cd ~/.pi/agent/extensions/review-hub
npm run build:web
# Create several comments, mark some resolved, use next-unresolved navigation.
# Validate TOC counts and terminal "all caught up" state.
```
