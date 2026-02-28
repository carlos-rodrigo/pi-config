---
id: 004
status: open
depends: [001]
created: 2026-02-27
---

# Visual generator (markdown → cinematic HTML)

Transform a markdown document into cinematic scroll-driven HTML with section annotations for the review web app.

## What to do

### Visual generator (`lib/visual-generator.ts`)

- Implement `generateVisual(manifest, sourceContent): string`
- Returns an HTML string (not a file) that gets embedded in the review web app

### Markdown → HTML transformation

- Parse markdown into sections using the manifest's section map
- Each section wrapped in `<section data-section-id="{id}" class="review-section">`
- Transform markdown elements:
  - **Headings** → `<h1>`–`<h6>` with cinematic large typography
  - **Paragraphs** → `<p>` with comfortable reading width
  - **Bullet lists** → `<ul>` with staggered animation classes
  - **Numbered lists** → `<ol>` with staggered animation classes
  - **Code blocks** → `<pre><code>` with syntax highlighting (use a simple highlight approach — keyword-based, no heavy library)
  - **Inline code** → `<code>` with subtle background
  - **Bold/italic** → standard `<strong>`/`<em>`
  - **Tables** → `<table>` with row animation classes
  - **Blockquotes** → styled `<blockquote>` with left accent border
  - **Horizontal rules** → visual section dividers with animation
  - **Checkboxes** (`- [ ]` / `- [x]`) → styled checkboxes
- Add `data-section-id` attributes to heading elements for scroll tracking
- Add comment button (`💬`) floating at the top-right of each section

### Scroll animation classes

- Each section gets class `review-section` (initially hidden)
- JavaScript Intersection Observer adds class `visible` when section enters viewport
- List items get stagger delay: `style="--stagger-index: N"`
- Code blocks get a subtle slide-in
- Tables get row-by-row reveal

### Progress indicator

- Generate a sidebar/floating nav with section titles
- Current section highlighted as user scrolls
- Click section title to scroll to it

### No external dependencies

- Pure string concatenation — no markdown library needed
- The markdown is already structured; we parse it ourselves using the manifest section boundaries
- Regex-based inline formatting (bold, italic, code, links)

## Acceptance criteria

- [ ] `generateVisual()` produces valid HTML from a real PRD markdown file
- [ ] Every manifest section is wrapped in a `<section>` with correct `data-section-id`
- [ ] Headings, lists, code blocks, tables, blockquotes all render correctly
- [ ] Code blocks have basic syntax highlighting (keywords, strings, comments)
- [ ] Each section has a comment button (💬) that will be wired to the comment panel
- [ ] Progress indicator lists all sections
- [ ] HTML is self-contained (no external dependencies — styles inline or via the shared CSS file)
- [ ] Checkbox items render as styled checkboxes

## Files

- `~/.pi/agent/extensions/review-hub/lib/visual-generator.ts`

## Verify

```bash
# Generate HTML from the review-hub PRD and inspect output
# Open in browser to verify rendering
```
