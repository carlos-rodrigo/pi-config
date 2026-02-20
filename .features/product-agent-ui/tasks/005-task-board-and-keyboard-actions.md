---
id: 005
status: open
depends: [004]
parent: null
created: 2026-02-19
---

# Add task board toggle and keyboard interactions

Implement list/board toggle with keyboard controls and selection behavior in Product UI.

## What to do

- Add board component with columns: TODO, In Progress, Done.
- Add toggle action (`v`) between List and Board views.
- Add selected item navigation keys.
- Add shortcut key support to open selected file (`o`), diff (`d`), edit (`e`) via dispatch helper.

## Acceptance criteria

- [ ] Board view renders exactly 3 columns matching list groups.
- [ ] View toggle works and persists in state snapshot.
- [ ] Keyboard navigation updates selection and re-renders correctly.
- [ ] `o/d/e` actions dispatch for selected task file.
- [ ] `npm run typecheck` passes.

## Files

- `extensions/product-agent-ui/components/task-board.ts`
- `extensions/product-agent-ui/components/product-shell.ts`

## Verify

```bash
npm run typecheck
```
