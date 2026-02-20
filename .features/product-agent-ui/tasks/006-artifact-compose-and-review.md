---
id: 006
status: done
depends: [003]
parent: null
created: 2026-02-19
---

# Implement artifact workspace compose/refine flow

Support interactive composition/refinement for PRD, Design, and Tasks stages and integrate artifact review actions.

## What to do

- Add artifact panel for `prd.md` and `design.md` display.
- Add actions to trigger composition/refinement via existing skills:
  - `/skill:prd`
  - `/skill:design-solution`
  - `/skill:simple-tasks`
- Keep approval action separate from generation.
- Add review actions to open artifact files via `/open` (`view`/`diff`/`edit`).

## Acceptance criteria

- [ ] User can trigger interactive compose/refine from stage panel.
- [ ] Resulting artifacts are written under `.features/{feature}/`.
- [ ] Artifact open/diff/edit actions work from panel.
- [ ] Approval remains explicit and independent from generation.
- [ ] `npm run typecheck` passes.

## Files

- `extensions/product-agent-ui/components/artifact-panel.ts`
- `extensions/product-agent-ui/services/artifact-service.ts`
- `extensions/product-agent-ui/services/dispatch-service.ts`

## Verify

```bash
npm run typecheck
```
