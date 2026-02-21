---
id: 010
status: done
depends: [005, 006, 007, 008, 009]
parent: null
created: 2026-02-19
---

# Final polish, QA, and usage documentation

Finalize command/shortcut behavior, README usage docs, and run a complete manual validation pass.

## What to do

- Verify all workflow stages and transitions in interactive session.
- Verify `/product`, `/product-run`, `/product-review`, and shortcuts.
- Verify `/open` integration from Product UI in idle + streaming-safe modes.
- Add/expand README usage section for Product Agent workflow and Review stage.
- Record known limitations and follow-ups.

## Acceptance criteria

- [ ] End-to-end workflow tested: Plan -> Design -> Tasks -> Implement -> Review.
- [ ] All required shortcuts and commands documented.
- [ ] Policy JSON docs and examples present and accurate.
- [ ] Manual verification notes added.
- [ ] `npm run typecheck` passes.

## Files

- `README.md`
- `extensions/product-agent-ui/**`

## Verify

```bash
npm run typecheck
```
