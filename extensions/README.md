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

Open files in a syntax-highlighted overlay modal or in nvim via tmux.

### What it adds

| Feature | Description |
|---------|-------------|
| `/open <file>` command | Opens file in an overlay modal with syntax highlighting |
| `open_file` tool | LLM-callable tool to view files in modal or edit in nvim |

### Usage

**As a command** — type in pi's editor:

```
/open src/app.tsx
```

**Ask the LLM:**

```
Open src/app.tsx so I can see it
Open src/app.tsx in nvim at line 42
```

### Overlay controls

| Key | Action |
|-----|--------|
| `↑` / `↓` or `j` / `k` | Scroll line by line |
| `PgUp` / `PgDn` or `Ctrl+U` / `Ctrl+D` | Scroll page |
| `g` / `G` | Jump to top / bottom |
| `e` | Open in nvim (tmux split) |
| `q` / `Esc` | Close |

### Tool modes

| Mode | What happens |
|------|-------------|
| `view` | Shows file in overlay modal with syntax highlighting |
| `edit` | Opens file in nvim in a tmux horizontal split |

### Requirements

- **tmux** is required for the "edit" mode. If not in tmux, falls back gracefully with an error message.
