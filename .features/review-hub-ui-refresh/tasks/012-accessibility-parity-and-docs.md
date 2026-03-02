---
id: 012
status: open
depends: [002,008,010,011]
parent: null
created: 2026-02-27
---

# Accessibility hardening, parity smoke checks, and README migration docs

Finalize migration quality gates: keyboard/accessibility polish, parity checklist against legacy behavior, and updated documentation.

## What to do

- Audit keyboard flows (navigation, compose, resolve, done reviewing, player controls).
- Ensure landmarks/ARIA labels/focus management are consistent.
- Run parity smoke checklist for visual-only and with-audio review flows.
- Update README with frontend stack, build/run commands, troubleshooting, and fallback guidance.

## Acceptance criteria

- [ ] Primary review flows are keyboard operable.
- [ ] No critical accessibility violations in core screens.
- [ ] Parity checklist passes for required behaviors.
- [ ] README documents migration workflow and common failure recovery.

## Files

- `extensions/review-hub/README.md`
- `extensions/review-hub/web-app/src/components/**/*`
- `.features/review-hub-ui-refresh/*` (if checklist artifact is added)

## Verify

```bash
cd ~/.pi/agent/extensions/review-hub
npm run build:web
npx tsc --noEmit --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2022 index.ts lib/**/*.ts
# Manual: run full smoke flow via /review visual-only and /review --with-audio.
```
