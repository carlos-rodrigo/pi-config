---
id: 009
status: open
depends: [003, 004, 007]
parent: null
created: 2026-02-19
---

# Harden state reconciliation and session recovery

Implement deterministic recovery so file-backed state remains canonical and event-log metadata is replayed safely.

## What to do

- On `session_start`, rebuild state from `.features/{feature}` files first.
- Replay `product-agent-state` / run events as metadata-only overlay.
- Handle orphan events gracefully (task not found anymore).
- Define precedence: frontmatter task status overrides `_active.md` hints.
- Show non-fatal warnings for state inconsistencies.

## Acceptance criteria

- [ ] Session reload reconstructs current feature and stage without corrupting file truth.
- [ ] Event replay does not overwrite canonical file-derived task state.
- [ ] Orphan events are visible in timeline as orphaned metadata.
- [ ] Status precedence and inconsistency warnings are implemented.
- [ ] `npm run typecheck` passes.

## Files

- `extensions/product-agent-ui/services/state-service.ts`
- `extensions/product-agent-ui/services/reconcile-service.ts`

## Verify

```bash
npm run typecheck
```
