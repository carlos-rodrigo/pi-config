---
id: 003
status: done
depends: [002]
parent: null
created: 2026-03-05
---

# Build frontend reviewer shell and markdown UI

Create the web reviewer interface with low-cognitive-load visual design and markdown rendering.

## What to do

- Add frontend static assets (`index.html`, `app.js`, `styles.css`).
- Implement two-pane layout: document viewport + threads panel.
- Render markdown content with readable spacing/hierarchy.
- Add mode/status strip (NORMAL / VISUAL / COMMENT) and compact key legend.
- Ensure calm visual aesthetic (editorial, minimal noise).

## Acceptance criteria

- [x] Opening review URL shows structured reviewer shell.
- [x] Markdown headings/lists/code blocks render correctly.
- [x] Layout remains usable on medium/small viewport widths.
- [x] UI communicates current mode and review state clearly.

## Files

- `extensions/document-reviewer/ui/index.html` (new)
- `extensions/document-reviewer/ui/app.js` (new)
- `extensions/document-reviewer/ui/styles.css` (new)
- `extensions/document-reviewer/server.ts` (serve static assets)

## Verify

1. Launch `/review` on a PRD markdown file.
2. Confirm page shows document and comments pane.
3. Scroll long document and verify readability/hierarchy remains clear.
4. Resize browser window and confirm layout adapts without overlap.

## Execution notes

- Validation commands run:
  - `npx --yes tsx <<'TS' ... TS` (service/UI smoke test for review page, static assets, and document endpoint)
  - `node --check extensions/document-reviewer/ui/app.js`
  - `git diff --check -- extensions/document-reviewer/server.ts extensions/document-reviewer/ui/index.html extensions/document-reviewer/ui/app.js extensions/document-reviewer/ui/styles.css`
- Manual Pi interactive verification from the Verify checklist remains required.
