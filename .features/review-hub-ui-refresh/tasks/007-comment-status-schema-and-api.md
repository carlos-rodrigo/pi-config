---
id: 007
status: open
depends: [006]
parent: null
created: 2026-02-27
---

# Add additive comment status persistence (open/resolved) in manifest/API

Extend manifest comment model and `/comments` handling to support persisted resolution state without breaking old manifests.

## What to do

- Add optional `status` and `updatedAt` to `ReviewComment` type.
- Update server validation and normalization for additive fields.
- Default missing status to `open` in new writes.
- Keep backward compatibility with old manifest files.

## Acceptance criteria

- [ ] Existing manifests load without migration errors.
- [ ] Comment status persists through save/reload.
- [ ] `updatedAt` reflects status/edit updates.
- [ ] No breaking API contract changes for existing fields.

## Files

- `extensions/review-hub/lib/manifest.ts`
- `extensions/review-hub/lib/server.ts`
- `extensions/review-hub/web-app/src/types/*` (if separate frontend types)

## Verify

```bash
cd ~/.pi/agent/extensions/review-hub
npx tsc --noEmit --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2022 index.ts lib/**/*.ts
# Open review, resolve/unresolve a comment, refresh page.
# Confirm persisted status remains correct.
```
