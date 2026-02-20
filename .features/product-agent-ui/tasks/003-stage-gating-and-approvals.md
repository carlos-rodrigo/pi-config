---
id: 003
status: done
depends: [001, 002]
parent: null
created: 2026-02-19
---

# Add stage gating and approval persistence

Implement strict workflow transitions with explicit approval actions for PRD/Design/Tasks according to policy.

## What to do

- Add stage transition guard `canTransition(...)`.
- Implement approval/rejection actions with note, actor, timestamp.
- Persist approval snapshots via `pi.appendEntry("product-agent-state", ...)`.
- Show stage and gate status in shell (`Draft`, `Needs Approval`, `Approved`, etc.).

## Acceptance criteria

- [ ] Cannot transition to blocked stage when required approval is missing.
- [ ] PRD/Design/Tasks approvals persist across session reload.
- [ ] Rejection keeps stage unapproved and stores rationale.
- [ ] Stage header and status text reflect real gate state.
- [ ] `npm run typecheck` passes.

## Files

- `extensions/product-agent-ui/services/state-service.ts`
- `extensions/product-agent-ui/services/workflow-service.ts`
- `extensions/product-agent-ui/components/stage-header.ts`

## Verify

```bash
npm run typecheck
```
