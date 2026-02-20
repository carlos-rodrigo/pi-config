---
id: 001
status: done
depends: []
parent: null
created: 2026-02-19
---

# Scaffold product-agent-ui extension and workflow shell

Create the extension skeleton at `extensions/product-agent-ui/` with a minimal Product shell command and shortcut.

## What to do

- Create `extensions/product-agent-ui/index.ts` entrypoint.
- Register `/product` command and global shortcut `Ctrl+Alt+W`.
- Add base in-memory state model for feature name and current stage.
- Render a minimal `ctx.ui.custom()` shell with stage header placeholder.
- Wire extension into package discovery if needed.

## Acceptance criteria

- [ ] `extensions/product-agent-ui/index.ts` exists and loads without runtime errors.
- [ ] `/product` opens Product UI shell in interactive mode.
- [ ] `Ctrl+Alt+W` opens Product UI shell.
- [ ] Stage header shows 5 stages: Plan, Design, Tasks, Implement, Review.
- [ ] `npm run typecheck` passes.

## Files

- `extensions/product-agent-ui/index.ts`
- `extensions/product-agent-ui/types.ts`
- `package.json` (only if extension registration needs updates)

## Verify

```bash
npm run typecheck
```
