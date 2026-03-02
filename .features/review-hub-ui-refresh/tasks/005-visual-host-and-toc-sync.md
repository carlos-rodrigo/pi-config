---
id: 005
status: open
depends: [004]
parent: null
created: 2026-02-27
---

# Integrate server-generated visual content and TOC active sync

Embed `/visual` output in React and wire section tracking to TOC highlighting/navigation.

## What to do

- Fetch and render `/visual` HTML in center content host.
- Load `/visual-styles` safely (or merge with host styling strategy).
- Track active section via intersection observer.
- Sync TOC active item and click-to-scroll behavior.

## Acceptance criteria

- [ ] Visual content renders correctly in new React shell.
- [ ] TOC active section updates during scroll.
- [ ] Clicking TOC entry scrolls to target section.
- [ ] No broken visual formatting vs legacy experience.

## Files

- `extensions/review-hub/web-app/src/components/visual/*`
- `extensions/review-hub/web-app/src/components/layout/TocRail.tsx`

## Verify

```bash
cd ~/.pi/agent/extensions/review-hub
npm run build:web
# Open review URL and scroll through sections.
# Confirm TOC highlight + click navigation behavior.
```
