# Feature Packets

`docs/features/` is the durable home for feature strategy and current system design.

Use it when you want to keep product/system ownership while delegating implementation mechanics to agents.

> Note: this repo no longer ships a feature orchestration extension or `/feature` commands. Create/update these files directly, or ask the relevant planning/task skill to maintain them.

## Packet shape

```text
docs/features/<slug>/
  feature.json      # optional durable packet metadata: title, status, next action
  strategy.md       # intent, scope, constraints, success signal
  system-model.md   # current flow, intended flow, concepts, boundaries, design
  diagrams/         # optional system diagrams
  index.html        # optional generated dashboard; markdown remains source of truth
```

## Example: start a new feature

1. Create a slugged packet directory:

```bash
mkdir -p docs/features/saved-search-filters/diagrams
```

2. Draft the strategy/system files you need:

```text
docs/features/saved-search-filters/strategy.md
docs/features/saved-search-filters/system-model.md
```

3. If implementation needs delegation or sequencing, create approved `.features/<slug>/tasks/` briefs with concrete feedback loops.

4. Use `.features/<slug>/tasks/_active.md` only as an ignored, operational task-loop board while actively executing `.features/` task briefs. Do not treat it as durable feature state.

5. After implementation, record results in the task file's `## Result` section. If the next task needs context, add it directly to that next task.

## Example: migrate legacy feature docs

If a feature still has legacy artifacts:

```text
docs/features/legacy-feature/prd.md
docs/features/legacy-feature/design.md
.features/legacy-feature/tasks/*.md
```

Manually preserve old sources, create/update the strategy and system model, and only mark work orders/tasks `ready` after scope, architecture, and task feedback loops are clear.

## Ownership rule

- User owns strategy, system model, solution architecture, scope, tradeoffs, and slicing.
- Agent owns implementation mechanics, code edits, tests, and task-local results.
- Ambiguity in product/system/design should be resolved before implementation.
