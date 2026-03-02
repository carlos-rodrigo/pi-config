---
id: 011
status: open
depends: [004,005,006,009]
parent: null
created: 2026-02-27
---

# Add Framer Motion system with reduced-motion behavior

Introduce motion primitives and apply purposeful transitions to navigation, panels, and state changes.

## What to do

- Define shared motion tokens/utilities (durations/easing/springs).
- Add transitions for mode toggle, rail reveal/hide, comment card state transitions, section focus.
- Integrate reduced-motion handling using user preference.
- Ensure motion does not block interactions or cause layout jank.

## Acceptance criteria

- [ ] Key transitions use consistent motion primitives.
- [ ] `prefers-reduced-motion` significantly reduces nonessential animation.
- [ ] Interaction responsiveness remains high during transitions.
- [ ] No regressions in comment/audio/scroll behavior.

## Files

- `extensions/review-hub/web-app/src/lib/motion.ts`
- `extensions/review-hub/web-app/src/components/**/*`

## Verify

```bash
cd ~/.pi/agent/extensions/review-hub
npm run build:web
# Manual: exercise mode toggles, panel open/close, comment state changes.
# Manual: enable reduced motion in OS/browser and verify simplified behavior.
```
