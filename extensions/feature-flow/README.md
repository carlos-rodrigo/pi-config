# feature-flow

Strategy-first feature orchestration with isolated Git worktrees and `docs/features/` learning packets.

## Install

```bash
pi install ./extensions/feature-flow
```

## What it adds

| Command | Description |
| --- | --- |
| `/feature <brief>` | Creates an isolated feature workspace, scaffolds `docs/features/<slug>/`, opens Pi in tmux, and starts a strategy-first kickoff prompt. |
| `/feature <brief> --slug <name>` | Same as above with explicit slug override. |
| `/feature <brief> --window` | Same workflow, but launches in a new tmux window instead of a split pane. |
| `/feature list` | Lists active `feat/*` worktrees. |
| `/feature status [slug]` | Summarizes feature packet docs, work orders, diagrams, execution reports, proof gaps, and next action. |
| `/feature next [slug]` | Writes the next recommended strategic prompt to the editor. |
| `/feature work-order <title> [--slug <name>]` | Creates a draft Work Order v2 delegation brief. |
| `/feature report <work-order> [--slug <name>]` | Creates a draft execution report linked to a work order id/path/title. |
| `/feature review [slug]` | Writes a strategy-review prompt that compares intent, execution, proof, and optional `/reown --remember` memory. |
| `/feature view [slug]` | Regenerates/opens `docs/features/<slug>/index.html`. |
| `/feature open <slug> [--window]` | Opens feature workspace in tmux (`pi -c`) as pane by default or window with `--window`. |
| `/feature reopen <slug> [--window]` | Alias for `/feature open <slug> [--window]`. |
| `/feature close <slug>` | Removes feature workspace with dirty-check confirmation. |

When `[slug]` is omitted, feature-flow infers it only when there is exactly one `docs/features/` packet.

## Feature packet

`/feature <brief>` creates durable source docs under:

```text
docs/features/<slug>/
  feature.json
  strategy.md
  system-model.md
  decisions.md
  proof.md
  review.md
  work-orders/
  execution/
  diagrams/
  index.html
```

Markdown is the source of truth. `index.html` is a generated learning site that aggregates strategy, system model, decisions, proof, work orders, execution reports, strategy review, and diagrams. The top dashboard summarizes state, next action, work-order/report counts, proof/decision gaps, diagram links, and review/remember guidance.

The packet is designed for strategic ownership:

- the user owns product/system rules, tradeoffs, scope, and proof,
- the agent owns implementation details and mechanical execution,
- strategic ambiguity should be escalated before implementation.

## Work Order v2

Work orders are optional delegation briefs for execution that should be split, approved, or handed off. Small approved changes may execute directly from strategy/model/decision/proof docs. Work orders live in `docs/features/<slug>/work-orders/` and use frontmatter:

```yaml
---
id: WO-001
status: draft # draft | ready | blocked | done
order: 1
created: 2026-05-26
---
```

Status semantics:

- `draft` — not approved for execution.
- `ready` — user approved; agent may execute.
- `blocked` — waiting on a decision/dependency/proof.
- `done` — implemented and execution report exists.

When work orders exist, `/feature next` only recommends implementation for one marked `ready`. If no work orders exist, `/feature next` suggests direct execution from approved docs or creating a work order only when delegation/splitting is useful. If a work order is marked `done` before an execution report exists, `/feature next` prioritizes writing the missing report.

## Execution Reports v1

Execution reports live in `docs/features/<slug>/execution/` and use frontmatter:

```yaml
---
id: ER-001
workOrder: WO-001
status: draft # draft | complete
created: 2026-05-26
---
```

Status semantics:

- `draft` — report still needs proof/evidence.
- `complete` — report captures repo-relative files changed, deviations, proof results, and strategic follow-up.

Use `/feature report WO-001` after implementation has started from a `ready` or `done` work order, then fill evidence and mark the report `complete`. Duplicate reports for the same work order are rejected.

## Fallback behavior

If worktree creation fails, the extension automatically:

- creates `feat/<slug>` from `main` in the current repo,
- checks it out when the repo is clean,
- and continues the feature kickoff there.
