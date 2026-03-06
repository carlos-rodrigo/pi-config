---
id: 008
status: done
depends: [006, 007]
parent: null
created: 2026-03-05
---

# Implement End Review export and clipboard flow

Compile all comments into plain-text bullets and copy to clipboard at end of review.

## What to do

- Implement export formatter for plain-text bullet output.
- Add export endpoint returning compiled text and count.
- Add End Review action in UI and clipboard write call.
- On clipboard failure, display manual-copy fallback text in UI.

## Acceptance criteria

- [x] End Review generates bullet-formatted plain text.
- [x] Clipboard copy success is confirmed with clear feedback.
- [x] Clipboard failure shows fallback export text for manual copy.
- [x] Export includes context snippet + comment text for each item.

## Files

- `extensions/document-reviewer/export.ts` (new)
- `extensions/document-reviewer/server.ts`
- `extensions/document-reviewer/ui/end-review.js` (new)
- `extensions/document-reviewer/ui/app.js`

## Verify

1. Create at least 3 comments across 2 sections.
2. Trigger End Review → success message includes exported comment count.
3. Paste into plain-text editor → bullets + context are readable.
4. Simulate clipboard failure (deny permission) → manual-copy fallback appears.
