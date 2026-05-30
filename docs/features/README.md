# Feature Packets

`docs/features/` is the durable home for feature strategy, system design, execution slices, proof, and review notes.

Use it when you want to keep product/system ownership while delegating implementation mechanics to agents.

## Packet shape

```text
docs/features/<slug>/
  feature.json
  strategy.md       # intent, scope, constraints, success evidence
  system-model.md   # current flow, intended flow, concepts, boundaries, design
  decisions.md      # user-owned architecture/product decisions
  proof.md          # targeted checks, manual checks, regression gates
  work-orders/      # optional approved execution slices
  execution/        # reports after implementation
  diagrams/         # optional system diagrams
  review.md         # final alignment / teach-back
  index.html        # generated dashboard; markdown remains source of truth
```

## Example: start a new feature

```text
/feature Add saved filters to semantic search --slug saved-search-filters
```

This creates a feature worktree and scaffolds:

```text
docs/features/saved-search-filters/
```

Then use the strategy-first loop:

```text
/feature status saved-search-filters
/feature design saved-search-filters
/feature view saved-search-filters
```

After the design is reviewed, create optional execution slices:

```text
/feature work-order "Persist saved filters" --slug saved-search-filters
/feature work-order "Expose saved filters in search UI" --slug saved-search-filters
```

Manually mark only approved Work Orders as ready:

```yaml
status: ready
```

After implementation, capture proof:

```text
/feature report WO-001 --slug saved-search-filters
/feature review saved-search-filters
```

## Example: migrate legacy feature docs

If a feature still has legacy artifacts:

```text
docs/features/pr-review-comments/prd.md
docs/features/pr-review-comments/design.md
.features/pr-review-comments/tasks/*.md
```

Run:

```text
/feature migrate pr-review-comments
```

Migration preserves old sources and creates strategy-first docs plus draft Work Orders. Review the migrated strategy, system model, decisions, and proof before marking any Work Order `ready`.

## Ownership rule

- User owns strategy, system model, solution architecture, scope, tradeoffs, slicing, and proof.
- Agent owns execution mechanics, code edits, tests, and execution reports.
- Ambiguity in product/system/design should be resolved before implementation.
