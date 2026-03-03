---
id: 004
status: done
depends: [003]
parent: null
created: 2026-02-27
---

# Build 3-column app shell with Read/Review mode

Implement the main desktop-first layout and mode toggle behavior using React + shadcn.

## What to do

- Create app shell with:
  - Left TOC rail
  - Center content column
  - Right comment rail
  - Sticky top bar
- Add Read/Review mode toggle that changes layout density and chrome visibility.
- Add responsive behavior for tablet/mobile (collapsible TOC/comment rails).

## Acceptance criteria

- [ ] Desktop uses clear 3-column layout.
- [ ] Read mode reduces UI chrome and improves reading focus.
- [ ] Review mode exposes full commenting/navigation controls.
- [ ] Tablet/mobile layouts remain usable.

## Files

- `extensions/review-hub/web-app/src/components/layout/*`
- `extensions/review-hub/web-app/src/App.tsx`
- `extensions/review-hub/web-app/src/styles/*`

## Verify

```bash
cd ~/.pi/agent/extensions/review-hub
npm run build:web
# Open a generated review URL.
# Toggle modes and resize browser to desktop/tablet widths.
```
