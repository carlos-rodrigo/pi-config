---
id: 012
status: done
depends: [002, 005, 006, 008, 009, 010, 011]
created: 2026-02-27
---

# Pi commands and tools (entry point wiring)

Wire everything together in `index.ts` — register all commands, tools, lifecycle handlers, and the full generation pipeline.

## What to do

### Update `index.ts` — Lifecycle

- `session_start`: call `cleanupOrphanServers()` to recover from crashed sessions
- `session_shutdown`: call `server.stop()` to clean up HTTP server

### Register commands

#### `/review <path> [--audio-only] [--visual-only] [--lang en|es]`

- Parse args: extract file path and flags
- Validate file exists and is a `.md` file
- Run the full generation pipeline:
  1. `ctx.ui.setStatus("review-hub", "📋 Parsing document...")`
  2. Create manifest from source file
  3. Generate podcast script via sub-agent (skip if `--visual-only`)
  4. Ensure TTS available + generate audio (skip if `--visual-only`)
  5. Generate visual (skip if `--audio-only`)
  6. Save all artifacts to `.features/{feature}/reviews/`
  7. Start review server
  8. Open browser: `pi.exec("open", [url])` on macOS
  9. `ctx.ui.notify("Review Hub is ready!", "success")`
  10. `ctx.ui.setStatus("review-hub", "📝 Review live at {url}")`
- Handle errors gracefully: if TTS fails, fall back to visual-only

#### `/review-apply <manifest-path>`

- Load manifest from path
- Validate status is "reviewed"
- Call `applyReview(manifest, ctx)`
- Show diff to user
- On approval: write updated file, update manifest status
- `ctx.ui.notify("Review applied to {source}", "success")`

#### `/review-list [feature-name]`

- Scan `.features/*/reviews/` for manifest files (or specific feature if provided)
- For each manifest: show id, source, status, comment count, date
- Format as a readable list via `ctx.ui.notify()` or multi-line text

### Register tools

#### `review_document`

- Parameters: `path` (string), `audioOnly` (optional bool), `visualOnly` (optional bool), `language` (optional "en" | "es")
- Same logic as `/review` command
- Return: manifest path and URL in tool result
- Custom `renderCall`: show file path being reviewed
- Custom `renderResult`: show status + URL

#### `review_apply`

- Parameters: `manifestPath` (string)
- Same logic as `/review-apply` command
- Return: change summary and diff in tool result

### Argument parsing

- Implement `parseReviewArgs(args: string)`:
  - Extract file path (first non-flag argument)
  - Extract `--audio-only`, `--visual-only` flags
  - Extract `--lang en|es` (default: "en")
  - Handle path with leading `@` (strip it, following pi convention)

### Feature directory detection

- Given a source file path, find the `.features/{feature}/` directory:
  - If path is inside `.features/X/` → use X as feature name
  - If path is outside `.features/` → create a reviews dir next to the file
- Create `reviews/` subdirectory if it doesn't exist

### Review numbering

- Scan existing reviews in the directory
- Next review: `review-{N+1}` with zero-padded 3 digits

## Acceptance criteria

- [ ] `/review path/to/prd.md` generates a full review and opens the browser
- [ ] `/review path/to/prd.md --visual-only` skips audio generation
- [ ] `/review path/to/prd.md --lang es` generates Spanish podcast
- [ ] `/review-apply path/to/manifest.json` applies comments and updates source
- [ ] `/review-list` shows all reviews across features
- [ ] `/review-list auth` shows reviews for the auth feature only
- [ ] `review_document` tool is callable by the LLM
- [ ] `review_apply` tool is callable by the LLM
- [ ] Progress status updates appear in pi TUI during generation
- [ ] Browser opens automatically with the review URL
- [ ] Server cleans up on session shutdown
- [ ] Orphan servers are cleaned up on session start
- [ ] TTS failure falls back to visual-only gracefully
- [ ] Error messages are clear and actionable

## Files

- `~/.pi/agent/extensions/review-hub/index.ts`

## Verify

```bash
# Full end-to-end test:
# 1. /review .features/review-hub/prd.md --visual-only
# 2. Verify browser opens with visual presentation
# 3. Add comments in the browser
# 4. Click "Done Reviewing"
# 5. /review-apply .features/review-hub/reviews/review-001.manifest.json
# 6. Verify diff is shown and source is updated

# LLM tool test:
# Ask pi: "Review the PRD at .features/review-hub/prd.md"
# Verify it calls the review_document tool
```
