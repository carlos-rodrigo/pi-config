---
id: 001
status: done
depends: []
parent: null
created: 2026-03-05
---

# Scaffold `/review` command and launcher

Create a new extension entrypoint for document review and register a `/review <path>` command.

## What to do

- Add `extensions/document-reviewer.ts` as the feature entry point.
- Register `/review` command with argument parsing and usage/help text.
- Validate path exists, is file, and is markdown-compatible.
- Add browser launcher helper (`open` / `xdg-open` / `start`) with clear error handling.
- Return clear status notifications in Pi for success/failure states.

## Acceptance criteria

- [x] `/review <valid-md>` starts command flow without crashing.
- [x] Missing/invalid path shows actionable error.
- [x] Non-markdown input is rejected with clear message.
- [x] Browser launcher function is implemented with cross-platform fallback logic.

## Files

- `extensions/document-reviewer.ts` (new)
- `extensions/lib/open-external.ts` (new or equivalent helper)
- `extensions/README.md` (update command docs)

## Verify

- In Pi interactive mode:
  1. Run `/review .features/document-reviewer-extension/prd.md` → shows launch/start status.
  2. Run `/review does-not-exist.md` → error explains file not found.
  3. Run `/review package.json` → unsupported type message.

## Execution notes

- Automated tests are not available yet in this repository (no test runner/config present for extensions).
- Validation run in this task:
  - `git diff --check -- extensions/document-reviewer.ts extensions/lib/open-external.ts extensions/README.md`
- Follow-up/manual verification required in Pi interactive mode using the Verify steps above.
