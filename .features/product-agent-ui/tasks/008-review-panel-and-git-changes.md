---
id: 008
status: open
depends: [001]
parent: null
created: 2026-02-19
---

# Implement final Review panel with git file bundle and checklist

Build the Review stage panel listing changed files and enabling quick per-file review actions.

## What to do

- Create review service using git name-status output.
- Support statuses `A`, `M`, `D` in UI.
- Add pre-ship checklist summary (approvals + quality gates status).
- Add actions for selected file: view/diff/edit using dispatch helper.
- Re-validate file existence/state before action and show refresh warning if stale.

## Acceptance criteria

- [ ] Review panel lists changed files with A/M/D status.
- [ ] Checklist appears in Review panel.
- [ ] File actions work for valid files.
- [ ] Stale/deleted/mismatched file action shows clear warning and does not crash.
- [ ] `npm run typecheck` passes.

## Files

- `extensions/product-agent-ui/services/review-service.ts`
- `extensions/product-agent-ui/components/review-panel.ts`

## Verify

```bash
npm run typecheck
```
