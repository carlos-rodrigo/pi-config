---
id: 011
status: done
depends: [001, 003]
created: 2026-02-27
---

# Comment applicator (apply review → update source)

Implement the system that reads review comments and applies them back to the source markdown document via LLM.

## What to do

### Applicator (`lib/applicator.ts`)

- Implement `applyReview(manifest, ctx): Promise<ApplyResult>`
- Export `ApplyResult` type: `{ updatedContent, diff, changeSummary }`

### Application flow

1. **Load manifest** with completed review comments
2. **Check status** — must be "reviewed" (not "in-progress" or already "applied")
3. **Detect drift** — compare current source hash vs manifest's `sourceHash`
   - If drifted: show warning via `ctx.ui.confirm()` listing which sections changed
   - User can proceed (apply to current version) or cancel
4. **Group comments by section** — build a map of `sectionId → comment[]`
5. **Build LLM prompt** with:
   - Full current source document
   - Comments annotated per-section with type and priority
   - Clear instructions for each comment type
6. **Send to LLM** — use the main pi session (the agent itself applies changes)
7. **Generate diff** — compare original vs updated content
8. **Show diff for approval** — use `ctx.ui.editor()` to show the updated document for review
9. **Apply on approval** — write updated content to source file
10. **Update manifest** — set `status: "applied"`, `completedAt: now`

### Prompt construction

```
You are editing a {reviewType} document based on structured review feedback.

## Current Document
{sourceContent}

## Review Comments (grouped by section)

### Section: {sectionTitle} (id: {sectionId})
- [CHANGE] (high priority): "Missing edge case: what if user has 2FA enabled?"
- [APPROVAL]: "This section looks good"

### Section: {anotherSection}
- [CONCERN] (medium): "This might conflict with the existing rate limiter"
- [QUESTION]: "Should we support batch operations?"

## Instructions
- For CHANGE comments: modify the section content as requested
- For CONCERN comments: address by adding context, caveats, or modifications
- For QUESTION comments: add to the "Open Questions" section (create if it doesn't exist)
- For APPROVAL comments: leave the section unchanged
- Prioritize HIGH priority comments over MEDIUM and LOW
- Preserve document structure, formatting, and sections not mentioned in comments
- Do not remove sections unless explicitly requested
- Do not add new sections unless a comment explicitly requests it

Output the complete updated document in markdown.
```

### Diff generation

- Use a simple line-by-line diff (can use the `diff` npm package already used by `file-opener.ts`)
- Format as a human-readable summary:
  - "N sections modified, M lines added, K lines removed"
  - List of modified section titles

### Change summary

- Generate a brief text summary for the LLM tool result:
  - "Applied 5 comments to prd.md: 2 changes, 1 concern addressed, 2 questions added to Open Questions"

## Acceptance criteria

- [ ] `applyReview()` reads a completed manifest and generates updated document
- [ ] Drift detection warns when source has changed since review
- [ ] Comments are correctly grouped by section in the prompt
- [ ] LLM produces an updated document that addresses change and concern comments
- [ ] Question comments are added to Open Questions section
- [ ] Approval comments leave sections unchanged
- [ ] Diff is generated comparing original vs updated
- [ ] User can review the updated document before it's written
- [ ] Source file is updated only after approval
- [ ] Manifest status updated to "applied" after successful application
- [ ] Change summary is concise and accurate
- [ ] Handles edge case: no actionable comments (all approvals) → no changes needed

## Files

- `~/.pi/agent/extensions/review-hub/lib/applicator.ts`

## Verify

```bash
# Create a test manifest with comments of different types
# Run applyReview() and verify:
# - Changes are applied to the correct sections
# - Questions end up in Open Questions
# - Approvals are untouched
# - Diff shows only expected changes
```
