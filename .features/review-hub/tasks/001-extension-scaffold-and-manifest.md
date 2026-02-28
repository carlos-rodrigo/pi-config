---
id: 001
status: done
depends: []
created: 2026-02-27
---

# Extension scaffold and manifest system

Set up the directory-based extension structure and implement the core manifest system that everything else depends on.

## What to do

### Extension scaffold

- Create `~/.pi/agent/extensions/review-hub/` directory
- Create `package.json` with extension metadata and pi entry point
- Create `index.ts` — minimal entry point that exports default function, registers placeholder commands
- Create `lib/` directory structure
- Run `npm install` if any dependencies needed at this stage

### Manifest system (`lib/manifest.ts`)

- Implement markdown section parser:
  - Split on heading lines (`#`, `##`, `###`, etc.)
  - Track heading hierarchy to build `headingPath` arrays
  - Count duplicate heading occurrences for `occurrenceIndex`
  - Record `sourceLineStart` and `sourceLineEnd` for each section
  - Compute `sourceTextHash` (SHA-256 of section content)
- Implement `generateSectionId(headingPath, occurrenceIndex)` — slugify heading path, join with `--`, add occurrence suffix if > 0
- Implement `createManifest(sourcePath, reviewType, language)`:
  - Read source file
  - Parse sections
  - Generate manifest with stable section IDs
  - Compute `sourceHash` of full file
- Implement `loadManifest(manifestPath)` — read and parse JSON
- Implement `saveManifest(manifest, dir)` — atomic write (temp file + rename)
- Implement `detectDrift(manifest)` — compare current file hash vs manifest's `sourceHash`, per-section drift
- Export TypeScript types: `ReviewManifest`, `ReviewSection`, `ReviewComment`, `DriftResult`

## Acceptance criteria

- [ ] Extension directory exists at `~/.pi/agent/extensions/review-hub/`
- [ ] `index.ts` exports a valid default function that pi can load
- [ ] Manifest parser correctly handles a real PRD file (use `.features/review-hub/prd.md` as test)
- [ ] Section IDs are stable — parsing the same file twice produces identical IDs
- [ ] Duplicate headings get distinct IDs via `occurrenceIndex`
- [ ] `sourceHash` and `sourceTextHash` are computed correctly
- [ ] `saveManifest` writes atomically (no partial writes on crash)
- [ ] `detectDrift` correctly reports when source file has changed
- [ ] `loadManifest` round-trips: save → load produces identical object
- [ ] All types are exported and well-documented

## Files

- `~/.pi/agent/extensions/review-hub/package.json`
- `~/.pi/agent/extensions/review-hub/index.ts`
- `~/.pi/agent/extensions/review-hub/lib/manifest.ts`

## Verify

```bash
# Extension loads without error
pi -e ~/.pi/agent/extensions/review-hub/index.ts -p "hello" 2>&1 | head -5

# TypeScript types compile
cd ~/.pi/agent/extensions/review-hub && npx tsc --noEmit --esModuleInterop --module nodenext --moduleResolution nodenext lib/manifest.ts 2>&1 || true
```
