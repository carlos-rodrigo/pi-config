# Product Agent UI QA Notes

Date: 2026-02-20
Feature: `product-agent-ui`
Task: `010 - Final polish, QA, and usage documentation`

## Verification Summary

### Automated checks

- `npm run typecheck`
- `npm run test:product-agent-ui`

### Coverage added in this task

- Extension registration coverage for:
  - `/product`
  - `/product-run`
  - `/product-review`
  - global shortcut registration (`Ctrl+Alt+W`)
- Dispatch coverage for `/open` integration:
  - idle dispatch
  - streaming-safe follow-up dispatch (`deliverAs: "followUp"`)
- Run-loop service coverage for next-ready task selection and gate blocking behavior.

### Interactive checklist (run in live Pi TUI)

- [ ] End-to-end stage progression: Plan → Design → Tasks → Implement → Review
- [ ] `/product` opens expected feature shell
- [ ] `/product-run` queues one ready task and updates run timeline/checkpoint
- [ ] `/product-review` opens review-stage shell with changed files + checklist
- [ ] Task/review file actions (`o/d/e`) work in both idle and streaming sessions

## Known Limitations and Follow-ups

1. There is no dedicated automated harness for `ctx.ui.custom()` interactions yet; keyboard-driven stage transitions still require live interactive smoke tests.
2. `/product-run` currently triggers one run-loop continuation per command (intentional sequential behavior); future work could add optional bounded multi-step execution with explicit max-task policy controls in-command.
3. Review-stage file action validation refreshes git change state on each action for safety; add TTL caching + explicit refresh controls if large-repo latency becomes noticeable.
4. Add dedicated unit tests for `review-service.ts` stale/deleted/path-mismatch validation branches.
5. Add a dedicated `/product-policy` readout command (listed in design, not implemented in this milestone) to inspect active policy source without opening the shell.
