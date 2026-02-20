---
id: 004
status: done
depends: [001]
parent: null
created: 2026-02-19
---

# Implement task parsing and grouped list view

Build task service that reads `.features/{feature}/tasks/*.md`, parses frontmatter, and renders grouped list in strict order.

## What to do

- Parse task frontmatter fields: `id`, `status`, `depends`, title.
- Normalize statuses to UI groups:
  - `open` -> TODO
  - `in-progress` -> In Progress
  - `done` -> Done
  - `blocked` -> TODO + blocked badge
- Render list sections in strict order: TODO, In Progress, Done.
- Add empty-state messages per section.

## Acceptance criteria

- [ ] List sections are always ordered TODO -> In Progress -> Done.
- [ ] Blocked tasks remain visible in TODO with blocked marker.
- [ ] Task counts and rows reflect parsed markdown files.
- [ ] Parsing errors are handled with clear UI warning, not crash.
- [ ] `npm run typecheck` passes.

## Files

- `extensions/product-agent-ui/services/task-service.ts`
- `extensions/product-agent-ui/components/task-list.ts`

## Verify

```bash
npm run typecheck
```
