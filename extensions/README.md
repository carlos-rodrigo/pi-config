# Extensions

## bordered-editor

Replaces Pi's default input editor with a bordered version that embeds status information directly into the box borders.

### Preview

```
╭─ Claude 4 Opus · xhigh ──────────────────────────────────────╮
│   your prompt here                                             │
╰─ 42% of 200k · $1.14 ──────────────── ~/project (main) ─╯
```

### What it shows

| Position | Info | Styling |
|---|---|---|
| Top left | Model name · thinking level | Level in **green** |
| Bottom left | Context usage % of window · session cost | Muted |
| Bottom right | Working directory (git branch) | Branch in **violet** |

### How it works

- Extends `CustomEditor` from `@mariozechner/pi-coding-agent` and overrides `render()` to wrap the default editor output with rounded box-drawing characters (`╭`, `╮`, `│`, `╰`, `╯`).
- Calls `super.render(width - 2)` to reserve space for side borders, then post-processes each line.
- Reads live data from the extension context: `ctx.getContextUsage()`, `ctx.model`, `ctx.sessionManager.getBranch()` (for cost), and `footerData.getGitBranch()`.
- Replaces the default footer with an empty one since all footer info is embedded in the editor borders.
- Border color follows the current thinking level (same as Pi's default behavior).
- Internal padding is set to `paddingX: 2` for extra breathing room.

---

## file-opener

Open files in a syntax-highlighted overlay modal or in nvim via tmux, with built-in diff support.

### What it adds

| Feature | Description |
|---------|-------------|
| `/open <file>` command | Opens file in an overlay modal with syntax highlighting |
| `/open <file> --diff` | Opens file and starts in diff mode |
| `open_file` tool | LLM-callable tool to view, diff, or edit files |

### Usage

**As a command** — type in pi's editor:

```
/open src/app.tsx
/open src/app.tsx --diff
```

**Ask the LLM:**

```
Open src/app.tsx so I can see it
Show me the diff for src/app.tsx
Open src/app.tsx in nvim at line 42
```

### Diff mode

The viewer tracks the original content of each file when first opened in a session. If the file changes (e.g. after the LLM edits it), you can toggle diff view to see what changed — added lines in green, removed lines in red.

- Press `d` to toggle between normal view and diff view
- Use `/open file --diff` or `open_file` with mode `diff` to start in diff mode
- The `[DIFF]` indicator appears in the title bar when active

### Overlay controls

| Key | Action |
|-----|--------|
| `↑` / `↓` or `j` / `k` | Scroll line by line |
| `PgUp` / `PgDn` or `Ctrl+U` / `Ctrl+D` | Scroll page |
| `g` / `G` | Jump to top / bottom |
| `d` | Toggle diff mode (when changes exist) |
| `e` | Open in nvim (tmux split) |
| `q` / `Esc` | Close |

### Tool modes

| Mode | What happens |
|------|-------------|
| `view` | Shows file in overlay modal with syntax highlighting |
| `diff` | Shows file in overlay starting in diff mode |
| `edit` | Opens file in nvim in a tmux horizontal split |

### Requirements

- **tmux** is required for the "edit" mode. If not in tmux, falls back gracefully with an error message.
- **diff** npm package (used for computing line diffs).
