---
id: 005
status: done
depends: [003, 004]
parent: null
created: 2026-03-15
---

# Implement PR submit pipeline (mapping, fallback, retry, cleanup)

Implement finish-time PR submission behavior and safety rules.

## What to do

- Add `extensions/document-reviewer/pr-diff-map.ts` with:
  - patch parser for changed RIGHT-side lines per file
  - eligibility checks for single-line inline comments
- In PR finish path (`server.ts` + `github-pr.ts`):
  - refresh PR metadata and files
  - recompute mapping from refreshed patch data
  - downgrade all comments to fallback if `headSha` changed
  - partition inline vs fallback
  - submit one grouped review (`event: COMMENT`)
  - if grouped submit fails on inline validation (e.g. 422), retry once fallback-only
  - skip submit when there are zero comments
  - always attempt worktree cleanup after finish paths
- Build single aggregated fallback section:
  - heading `### Fallback comments`
  - safe snippet truncation + escaped content

## Acceptance criteria

- [ ] Inline comments are submitted only for valid single-line RIGHT-side mappings.
- [ ] Multi-line and unmappable comments are preserved in fallback section.
- [ ] Head SHA change downgrades to fallback safely.
- [ ] One retry path exists for inline-validation failure.
- [ ] No-comment finish returns success and still triggers cleanup attempt.
- [ ] Finish summary returns inline/fallback/error counts.

## Files

- `extensions/document-reviewer/pr-diff-map.ts` (new)
- `extensions/document-reviewer/github-pr.ts`
- `extensions/document-reviewer/server.ts`

## Verify

```bash
npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler --skipLibCheck extensions/document-reviewer/pr-diff-map.ts extensions/document-reviewer/github-pr.ts extensions/document-reviewer/server.ts
```

Manual:
1. Finish review with mappable + unmappable comments → inline + fallback body both appear in PR review.
2. Finish with no comments → no GitHub review posted, cleanup still attempted.
3. Simulate stale head SHA → comments degrade to fallback safely.
