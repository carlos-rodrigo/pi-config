# Feature Packets

`docs/features/` is the durable home for feature strategy, system design, execution slices, proof, and review notes.

Use it when you want to keep product/system ownership while delegating implementation mechanics to agents.

> Note: this repo no longer ships a feature orchestration extension or `/feature` commands. Create/update these files directly, or ask the relevant planning/task skill to maintain them.

## Packet shape

```text
docs/features/<slug>/
  feature.json      # optional durable packet metadata: title, status, next action, verification summary
  strategy.md       # intent, scope, constraints, success evidence
  system-model.md   # current flow, intended flow, concepts, boundaries, design
  decisions.md      # user-owned architecture/product decisions
  proof.md          # targeted checks, manual checks, regression gates
  work-orders/      # optional approved execution slices
  execution/        # reports after implementation
  diagrams/         # optional system diagrams
  review.md         # final alignment / teach-back
  index.html        # optional generated dashboard; markdown remains source of truth
```

## Example: start a new feature

1. Create a slugged packet directory:

```bash
mkdir -p docs/features/saved-search-filters/{work-orders,execution,diagrams}
```

2. Draft the strategy/system files you need:

```text
docs/features/saved-search-filters/strategy.md
docs/features/saved-search-filters/system-model.md
docs/features/saved-search-filters/proof.md
```

3. If execution needs delegation or sequencing, create approved work orders or `.features/<slug>/tasks/` briefs with concrete feedback loops.

4. Use `.features/<slug>/tasks/_active.md` only as an ignored, operational task-loop board while actively executing `.features/` task briefs. Do not treat it as durable feature state.

5. After implementation, record evidence in the packet's `execution/` directory or in ignored `.features/<slug>/execution/`, depending on the workflow being used.

## Example: migrate legacy feature docs

If a feature still has legacy artifacts:

```text
docs/features/legacy-feature/prd.md
docs/features/legacy-feature/design.md
.features/legacy-feature/tasks/*.md
```

Manually preserve old sources, create/update the strategy-first docs, and only mark work orders/tasks `ready` after the strategy, system model, decisions, and proof are clear.

## Ownership rule

- User owns strategy, system model, solution architecture, scope, tradeoffs, slicing, and proof.
- Agent owns execution mechanics, code edits, tests, and execution reports.
- Ambiguity in product/system/design should be resolved before implementation.
