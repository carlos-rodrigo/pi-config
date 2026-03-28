# bordered-editor

Replaces Pi's default input editor with a bordered version that embeds status information directly into the box borders.

## Install

```bash
pi install ./extensions/bordered-editor
```

## Preview

```
╭─ Claude 4 Opus · xhigh ──────────────────────────────────────╮
│   your prompt here                                             │
╰─ 42% of 200k · $1.14 ──────────────── ~/project (main) ─╯
```

## What it shows

| Position | Info | Styling |
|---|---|---|
| Top left | Model name · thinking level | Level in **green** |
| Bottom left | Context usage % of window · session cost | Muted |
| Bottom right | Working directory + git state | Branch in **violet** for main checkout, **WT ...** tag for linked worktrees |

## How it works

- Extends `CustomEditor` from `@mariozechner/pi-coding-agent` and overrides `render()` to wrap the default editor output with rounded box-drawing characters (`╭`, `╮`, `│`, `╰`, `╯`).
- Calls `super.render(width - 2)` to reserve space for side borders, then post-processes each line.
- Reads live data from the extension context: `ctx.getContextUsage()`, `ctx.model`, `ctx.sessionManager.getBranch()` (for cost), and `footerData.getGitBranch()`.
- Replaces the default footer with an empty one since all footer info is embedded in the editor borders.
- Border color follows the current thinking level (same as Pi's default behavior).
- Internal padding is set to `paddingX: 2` for extra breathing room.
