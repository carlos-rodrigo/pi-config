---
id: 005
status: done
depends: [003, 004]
parent: null
created: 2026-02-27
---

# Document viewport with `react-markdown`

Build new document renderer using `react-markdown` and the canonical `/visual-model` payload.

## What to do

- Add markdown rendering stack (`react-markdown`, `remark-gfm`, `rehype-slug`).
- Render section-scoped markdown blocks from `/visual-model`.
- Implement active-section observation and TOC sync.
- Preserve readable typography for long PRDs.

## Acceptance criteria

- [ ] Document content renders fully from `/visual-model`
- [ ] Section IDs are consumed from server, not derived client-side
- [ ] TOC click -> smooth scroll; scroll -> active section update
- [ ] Large docs (100+ sections) remain usable and scrollable

## Files

- `extensions/review-hub/web-app/src/components/document/*` (new)
- `extensions/review-hub/web-app/src/hooks/*` (viewport/section sync hooks)
- `extensions/review-hub/web-app/package.json` (deps)

## Verify

```bash
cd extensions/review-hub
npm run typecheck:web
npm run build:web
npm test
```
