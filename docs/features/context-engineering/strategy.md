# Context Engineering — Strategy

## Problem

Agents lose context across sessions, guess without focused research, and create noisy verification output unless the repo gives them concise source-of-truth docs and deterministic feedback loops.

## Goals

1. Keep agent-facing knowledge in `docs/` and short `AGENTS.md` files.
2. Use repo-local playbooks for recurring implementation patterns.
3. Use deterministic backpressure through `scripts/verify.sh` and `scripts/run_silent.sh`.
4. Keep feature knowledge in strategy-first packets under `docs/features/<slug>/` when durable context is worth preserving.
5. Keep operational task state in ignored `.features/<feature>/tasks/` only when a task loop is needed.

## Non-goals

- Build a knowledge graph or custom vector store for feature docs.
- Modify Pi core or SDK.
- Require feature packets for every small change.

## Success criteria

- `AGENTS.md` stays concise and points agents to the right docs/tools.
- `docs/README.md` explains the current docs layout.
- `scripts/verify.sh` provides the project regression gate and is silent on success.
- Feature packets use `strategy.md`, `system-model.md`, `decisions.md`, `proof.md`, and optional execution/review artifacts.

## References

- [Advanced Context Engineering](https://www.humanlayer.dev/blog/advanced-context-engineering)
- [Context-Efficient Backpressure](https://www.humanlayer.dev/blog/context-efficient-backpressure)
- [Harness Engineering](https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents)
