---
id: 010
status: done
depends: [006,009,005]
parent: null
created: 2026-02-27
---

# Replace functional emojis with Lucide icons across app and visual controls

Remove functional emoji usage and standardize iconography with Lucide components.

## What to do

- Replace emoji controls/status markers in React UI with Lucide icons.
- Ensure icon-only buttons include `aria-label`.
- Update visual generator section action affordance to avoid emoji content.
- Keep visual semantics equivalent after replacement.

## Acceptance criteria

- [ ] No emoji remain in functional controls.
- [ ] Lucide icons are used consistently across key actions.
- [ ] Icon-only controls pass accessibility naming checks.
- [ ] Visual comment affordance no longer depends on emoji glyphs.

## Files

- `extensions/review-hub/web-app/src/components/**/*`
- `extensions/review-hub/lib/visual-generator.ts`

## Verify

```bash
cd ~/.pi/agent/extensions/review-hub
npm run build:web
rg -n "[😀-🙏🌀-🛿🚀-🛿☀-⛿✀-➿]" web-app/src lib/visual-generator.ts || true
# Manual check: controls render with icons and labels.
```
