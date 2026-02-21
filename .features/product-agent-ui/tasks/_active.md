# Active Feature: Product Agent UI

Started: 2026-02-19
Feature: product-agent-ui

## Execution Order

- [x] 001 - Scaffold extension and workflow state shell
- [x] 002 - Policy service with JSON config + strict defaults + README docs
- [x] 003 - Stage gating + approvals persistence
- [x] 004 - Task parsing + status normalization + grouped list
- [x] 005 - Task board toggle + keyboard interactions
- [x] 006 - Artifact compose/refine orchestration (PRD/Design/Tasks)
- [x] 007 - Run loop + run console timeline
- [x] 008 - Review panel (git changes + checklist + file actions)
- [x] 009 - State reconstruction and reconciliation hardening
- [x] 010 - End-to-end QA pass and docs polish

## Notes

- Canonical state for artifacts/tasks comes from `.features/{feature}` markdown files.
- `pi.appendEntry` is metadata/timeline state, not authoritative file state.
- Review actions must reuse `/open` flow with streaming-safe dispatch.
