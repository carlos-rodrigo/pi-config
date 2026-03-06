---
id: 004
status: done
depends: [003]
parent: null
created: 2026-03-05
---

# Add Mermaid static rendering with graceful fallback

Support Mermaid blocks in reviewed markdown while preserving readability and stability.

## What to do

- Detect Mermaid fenced code blocks in markdown render pipeline.
- Render Mermaid diagrams statically in the document viewport.
- Apply calm diagram styling that does not compete with comment highlights.
- Add local fallback for invalid/unsupported Mermaid syntax (show source block + warning).

## Acceptance criteria

- [x] Valid Mermaid fences render as diagrams.
- [x] Invalid Mermaid fences do not crash UI and show readable fallback.
- [x] Multiple diagrams in one document render independently.
- [x] Rendering is responsive on long documents.

## Files

- `extensions/document-reviewer/ui/mermaid-block.js` (new)
- `extensions/document-reviewer/ui/app.js`
- `extensions/document-reviewer/ui/styles.css`
- `extensions/document-reviewer/server.ts` (asset mapping for Mermaid module)

## Verify

1. Open markdown containing at least two Mermaid blocks.
2. Confirm diagrams render in-place.
3. Break one Mermaid block intentionally → fallback appears for that block only.
4. Scroll and interact through full document without freeze.

## Execution notes

- Validation commands run:
  - `node --check extensions/document-reviewer/ui/app.js`
  - `node --check extensions/document-reviewer/ui/mermaid-block.js`
  - `git diff --check -- extensions/document-reviewer/server.ts extensions/document-reviewer/ui/app.js extensions/document-reviewer/ui/mermaid-block.js extensions/document-reviewer/ui/styles.css`
  - `npx --yes tsx <<'TS' ... TS` (local review service smoke test validating `/review` shell + Mermaid asset serving)
- Oracle review pass completed for code quality, security, performance, and testing; actionable fixes were applied (renderer retry cache reset, sanitized SVG insertion path, resilient fallback rendering).
- Remaining hardening item: Mermaid module is still loaded from a pinned CDN URL; vendoring/local-only script policy is deferred to task 009 hardening.
- Manual Pi interactive verification from the Verify checklist remains required.
