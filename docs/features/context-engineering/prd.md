# Context Engineering — PRD

## Problem

Agents lose context across sessions, produce slop without research phases, lack backpressure mechanisms, and store knowledge in a flat LEARNINGS.md that grows unbounded. The handoff system produces chat summaries instead of structured context packets.

## Goals

1. **Structured knowledge** — Replace LEARNINGS.md with auto-maintained `docs/` (playbooks + feature specs)
2. **Research before coding** — Add research phase to implement-task with sub-agent context isolation
3. **Backpressure** — Add deterministic hooks (`verify.sh`, `run_silent.sh`) with fail-fast and output control
4. **Structured handoff** — Rewrite handoff to produce context packets (status, decisions, blockers, files) not summaries
5. **Verification workflows** — Each feature gets `workflows/` describing how to test each scenario
6. **Leaner AGENTS.md** — Trim global AGENTS.md under 120 lines by moving policies to docs

## Non-goals

- Changing the task file format or simple-tasks skill fundamentals
- Building a knowledge graph or vector store
- Modifying pi core or SDK

## Success criteria

- No LEARNINGS.md anywhere in the workflow
- implement-task includes Research → Code → Review → Finalize with auto-doc
- Handoff produces structured context packets
- `scripts/verify.sh` provides silent-success / verbose-failure backpressure
- Global AGENTS.md under 120 lines
- Playbooks contain all recoverable knowledge from deleted LEARNINGS.md

## References

- [Advanced Context Engineering](https://www.humanlayer.dev/blog/advanced-context-engineering)
- [Context-Efficient Backpressure](https://www.humanlayer.dev/blog/context-efficient-backpressure)
- [Harness Engineering](https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents)
