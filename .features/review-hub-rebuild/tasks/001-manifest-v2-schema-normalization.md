---
id: 001
status: done
depends: []
parent: null
created: 2026-02-27
---

# Manifest v2 schema + normalization

Introduce explicit schema versioning and anchored comment types in `lib/manifest.ts`, with safe normalization for legacy manifests.

## What to do

- Add `schemaVersion: 2` to `ReviewManifest`.
- Extend `ReviewComment` with optional `anchor` payload (`quote/prefix/suffix/offsets/hash`).
- Add runtime normalization function:
  - missing schemaVersion => treat as v1
  - v1 comments remain valid
  - unknown future versions => throw actionable error
  - corrupt anchor on single comment => drop anchor + keep comment
- Keep `saveManifest` atomic behavior unchanged.

## Acceptance criteria

- [ ] `ReviewManifest` and `ReviewComment` types include v2 anchor model
- [ ] Legacy manifests load without crash and normalize to runtime shape
- [ ] Unknown schema versions fail fast with clear error
- [ ] Corrupt anchor data degrades non-fatally per comment
- [ ] Existing manifest parser and drift behavior still pass current tests

## Files

- `extensions/review-hub/lib/manifest.ts`
- `extensions/review-hub/test/*` (new/updated tests as needed)

## Verify

```bash
cd extensions/review-hub
npm test
```
