---
id: 007
status: done
depends: [003, 004]
parent: null
created: 2026-02-19
---

# Build run loop orchestration and run console

Implement sequential autonomous execution over ready tasks with timeline visibility and checkpoint controls.

## What to do

- Compute next ready task (`open` and dependencies done).
- Implement run loop execution for one task at a time.
- Record run events: start, done, blocked, checkpoint, info.
- Add run console panel to display timeline and current state.
- Add controls: Continue, Pause, Request changes.

## Acceptance criteria

- [ ] Run loop starts only when policy gates are satisfied.
- [ ] Ready-task selection respects dependencies.
- [ ] Blocking conditions stop loop and log reason.
- [ ] Run console shows recent timeline and pending checkpoint.
- [ ] `npm run typecheck` passes.

## Files

- `extensions/product-agent-ui/services/runloop-service.ts`
- `extensions/product-agent-ui/components/run-console.ts`

## Verify

```bash
npm run typecheck
```
