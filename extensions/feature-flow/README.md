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
| `/feature design [slug]` | Writes a non-execution solution-design prompt for system model, decisions, proof, and draft Work Orders. |
| `/feature migrate <slug>` | Upgrades legacy `prd.md` / `design.md` / `.features` tasks into the strategy-first packet shape. |
| `/feature work-order <title> [--slug <name>]` | Creates a draft Work Order v2 delegation brief. |
| `/feature report <work-order> [--slug <name>]` | Creates a draft execution report linked to a work order id/path/title. |
| `/feature review [slug]` | Writes a strategy-review prompt that compares intent, execution, proof, and optional `/reown --remember` memory. |
| `/feature view [slug]` | Regenerates/opens `docs/features/<slug>/index.html`. |
| `/feature open <slug> [--window]` | Opens feature workspace in tmux (`pi -c`) as pane by default or window with `--window`. |
| `/feature reopen <slug> [--window]` | Alias for `/feature open <slug> [--window]`. |
| `/feature close <slug>` | Removes feature workspace with dirty-check confirmation. |

When `[slug]` is omitted, feature-flow infers it only when there is exactly one `docs/features/` packet.

## Conversational routing

Commands are the stable API, but you can also use natural language for safe workflow actions when a feature packet is active:

| Say | Equivalent behavior |
| --- | --- |
| "what's next?" | writes the `/feature next` prompt |
| "show feature status" | writes `/feature status` output |
| "let's design the solution" | writes the `/feature design` prompt |
| "open the dashboard" | regenerates/opens `/feature view` |
| "review this feature" | writes the `/feature review` prompt |
| "write the report for WO-001" | creates `/feature report WO-001` when the work order is ready/done |

Conversational routing does not auto-implement code or mark work orders ready. If the active feature is ambiguous, the message passes through to the agent instead of guessing.

## Legacy migration

Use `/feature migrate <slug>` when a feature already has old workflow artifacts:

```text
docs/features/<slug>/prd.md
docs/features/<slug>/design.md
.features/<slug>/tasks/*.md
```

Migration preserves those sources and creates any missing strategy-first packet docs:

```text
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

Legacy `.features` tasks become **draft** Work Orders with their original content embedded. Review the migrated design, decisions, proof, and Work Orders before marking anything `ready`.

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

The packet is designed for ownership boundaries:

- the user owns product strategy, system design, solution architecture, slicing, tradeoffs, scope, and proof,
- the agent owns execution mechanics: code edits, tests, proof runs, status updates, and execution reports,
- product/system/design ambiguity should be escalated before implementation.

## Solution design bridge

`/feature design [slug]` is the bridge from strategy to executable work. It writes a prompt that asks the agent to inspect the codebase with you as solution architect, then update:

- `system-model.md` — current flow, intended flow, solution design, execution slices, concepts, boundaries, code anchors,
- `decisions.md` — architecture/system decisions the user must own,
- `proof.md` — targeted checks, manual/E2E checks, regression gates,
- `work-orders/` — draft execution slices derived from the design.

It explicitly says **do not implement yet** and **do not mark work orders ready**. The user reviews the design and approves slices before execution.

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
