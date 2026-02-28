---
id: 003
status: open
depends: [002]
created: 2026-02-27
---

# Web app core: layout, comment panel, and comment API

Build the review web app shell with the comment system — the core primitive that both audio and visual feed into.

## What to do

### Layout (`web/index.html`)

- Two-column layout: main content area (left, ~70%) + comment panel (right, ~30%)
- Top bar: document title, language badge, "Done Reviewing" button
- Bottom bar: current section indicator
- Main area has two zones (stacked):
  - Podcast player zone (top, collapsible — populated in task 010)
  - Visual presentation zone (scrollable — populated in task 005)
- Dark theme throughout

### Styling (`web/styles.css`)

- Dark theme: background `#0a0a0f`, text `#e2e8f0`, accents purple `#805ad5`
- Clean typography: system font stack, generous line-height
- Comment type colors: change=blue, question=amber, approval=green, concern=red
- Priority badges: high=red dot, medium=yellow dot, low=gray dot
- Smooth transitions on all interactive elements
- Responsive: min-width 900px, graceful narrowing of comment panel

### Comment Panel (`web/app.js` — CommentPanel module)

- Display list of all comments sorted by creation time
- Each comment shows:
  - Type icon (🔄 change, ❓ question, ✅ approval, ⚠️ concern)
  - Priority badge (colored dot)
  - Section title
  - Comment text
  - Timestamp (relative: "2 min ago")
  - Audio timestamp if present (clickable — wired in task 010)
- Filter bar: filter by type (all | change | question | approval | concern)
- "Add Comment" button opens inline form
- Comment form:
  - Section selector (dropdown of all sections from manifest)
  - Type selector (radio buttons with icons)
  - Priority selector (high | medium | low, default medium)
  - Text area for comment
  - Save button (auto-saves on blur too)
- Edit comment: click existing comment to edit inline
- Delete comment: small × button on each comment

### Comment API client (`web/app.js` — ApiClient module)

- `fetchManifest()` — GET /manifest.json
- `saveComment(comment)` — POST /comments with session token
- `deleteComment(id)` — DELETE /comments/:id with session token
- `completeReview()` — POST /complete with session token
- Auto-retry on network error (1 retry after 1s)
- Session token extracted from URL query param on load

### App initialization (`web/app.js` — ReviewApp module)

- On load: extract token from URL, fetch manifest, render layout
- State management: single `state` object, render on state change
- Section list populated from manifest
- Comments loaded from manifest and rendered in panel
- "Done Reviewing" flow:
  - Confirm dialog: "Mark review as complete? (N comments: X changes, Y questions...)"
  - POST /complete
  - Show summary screen with "Return to terminal" message

## Acceptance criteria

- [ ] Web app loads from the review server and displays the layout
- [ ] Comment panel shows existing comments from the manifest
- [ ] Can add a new comment with type, priority, section, and text
- [ ] New comments appear immediately in the panel
- [ ] Comments persist across page refresh (saved to server)
- [ ] Can edit an existing comment inline
- [ ] Can delete a comment
- [ ] Filter by comment type works
- [ ] "Done Reviewing" button marks review as complete
- [ ] Dark theme looks clean and professional
- [ ] Section selector dropdown shows all sections from the manifest
- [ ] No JavaScript errors in browser console

## Files

- `~/.pi/agent/extensions/review-hub/web/index.html`
- `~/.pi/agent/extensions/review-hub/web/styles.css`
- `~/.pi/agent/extensions/review-hub/web/app.js`

## Verify

```bash
# Start server with a test manifest, open browser, add/edit/delete comments
# Verify comments persist in the manifest JSON file on disk
```
