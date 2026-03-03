---
id: 009
status: open
depends: [001, 002, 008]
parent: null
created: 2026-02-27
---

# Compact export endpoint (`/export-feedback`) with hash

Implement deterministic compact markdown export for open comments only, including export hash for finish verification.

## What to do

- Add `ExportService` to produce compact markdown.
- Include only `status=open` comments by default.
- Sort by document order then creation time.
- Include quote snippet or `[degraded-anchor]` marker.
- Return `exportHash` (hash of canonical markdown payload).

## Acceptance criteria

- [ ] Endpoint returns markdown + exportHash + stats
- [ ] Deterministic output for unchanged manifest
- [ ] Resolved comments excluded by default
- [ ] Degraded anchors are explicitly marked
- [ ] Output format remains concise/token-efficient

## Files

- `extensions/review-hub/lib/export-feedback.ts` (new)
- `extensions/review-hub/lib/server.ts`
- `extensions/review-hub/test/*` (new export tests)

## Verify

```bash
cd extensions/review-hub
npm test
```
