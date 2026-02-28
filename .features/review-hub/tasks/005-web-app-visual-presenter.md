---
id: 005
status: done
depends: [003, 004]
created: 2026-02-27
---

# Web app visual presenter with scroll animations and commenting

Integrate the visual generator output into the web app with scroll-triggered animations and section-level commenting.

## What to do

### Server integration

- Add GET `/visual` route to the server that:
  - Reads the source markdown
  - Calls `generateVisual(manifest, source)` to produce HTML
  - Returns the HTML fragment (not a full page)
  - Cache the result (regenerate only if source changes)

### Visual presenter (`web/app.js` — VisualPresenter module)

- On load: fetch `/visual` and inject HTML into the visual presentation zone
- Set up Intersection Observer on all `.review-section` elements:
  - When section enters viewport (threshold 0.2) → add `visible` class
  - Track current section → update bottom bar indicator
  - Update state → `ReviewApp.state.currentSection`
- Stagger animations:
  - List items: delay based on `--stagger-index` CSS variable
  - Table rows: similar stagger
  - Code blocks: fade + slight slide

### Section commenting

- Comment button (💬) on each section:
  - On click → open CommentPanel's add form with `sectionId` pre-filled
  - Highlight the section briefly
- Click a comment in the panel → scroll visual to that section with highlight animation

### Scroll sync with comment panel

- When user scrolls, update `SyncManager.onVisualScroll(sectionId)`
- SyncManager highlights the active section's comments in the panel
- Does NOT auto-seek audio (visual browsing is independent)

### Progress sidebar

- Floating nav on the left side with section titles
- Current section highlighted as user scrolls
- Click to smooth-scroll to section
- Collapsible on narrow viewports

### CSS additions (`web/styles.css`)

- Scroll animation keyframes and transitions
- Section hover states
- Comment button positioning and hover effect
- Progress sidebar styling
- Stagger delay system for list items and table rows
- Code block syntax highlight colors (dark theme)
- Smooth scroll behavior

## Acceptance criteria

- [ ] Visual presentation loads and renders all sections from the markdown
- [ ] Sections animate in on scroll (fade + slide)
- [ ] List items stagger their appearance
- [ ] Code blocks have syntax highlighting
- [ ] Progress sidebar shows all sections, highlights current
- [ ] Click section in sidebar → smooth scroll to it
- [ ] Comment button on each section opens comment form with section pre-filled
- [ ] Click comment in panel → scrolls to the referenced section
- [ ] Current section indicator updates in bottom bar
- [ ] Animations are smooth (no jank)
- [ ] No JavaScript errors in console

## Files

- `~/.pi/agent/extensions/review-hub/web/app.js` (VisualPresenter + SyncManager modules)
- `~/.pi/agent/extensions/review-hub/web/styles.css` (animation + visual styles)
- `~/.pi/agent/extensions/review-hub/lib/server.ts` (add `/visual` route)

## Verify

```bash
# Start server with a real PRD manifest, open browser
# Scroll through presentation, verify animations trigger
# Click comment buttons, verify section is pre-selected
# Click comments in panel, verify scroll-to-section works
```
