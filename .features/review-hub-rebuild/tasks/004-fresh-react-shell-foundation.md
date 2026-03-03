---
id: 004
status: open
depends: []
parent: null
created: 2026-02-27
---

# Fresh React shell foundation (Read/Review modes)

Rebuild the root app shell for readability-first review with explicit Read/Review mode behavior and responsive rails.

## What to do

- Rebuild `App.tsx` and shell layout components from scratch.
- Implement desktop 3-column layout and mobile drawer behavior.
- Implement Read mode vs Review mode visibility rules.
- Keep token bootstrap and loading/error states clean.

## Acceptance criteria

- [ ] Stable shell renders with no visual overlap/jank
- [ ] Read mode widens content and hides review-only rails
- [ ] Review mode shows TOC + comments surfaces
- [ ] Mobile controls open/close rails correctly
- [ ] No console errors while toggling modes

## Files

- `extensions/review-hub/web-app/src/App.tsx`
- `extensions/review-hub/web-app/src/components/shell/*` (new)
- `extensions/review-hub/web-app/src/index.css`

## Verify

```bash
cd extensions/review-hub
npm run typecheck:web
npm run build:web
```
