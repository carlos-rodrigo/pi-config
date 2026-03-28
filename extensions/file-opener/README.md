# file-opener

Open files in a syntax-highlighted overlay modal or in nvim via tmux, with built-in diff support.

## Install

```bash
pi install ./extensions/file-opener
```

## What it adds

| Feature | Description |
|---------|-------------|
| `/open <file>` command | Opens file in an overlay modal with syntax highlighting |
| `/open <file> --diff` | Opens file and starts in diff mode |
| `open_file` tool | LLM-callable tool to view, diff, or edit files |

## Usage

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

## Diff mode

The viewer tracks the original content of each file when first opened in a session. If the file changes (e.g. after the LLM edits it), you can toggle diff view to see what changed — added lines in green, removed lines in red.

- Press `d` to toggle between normal view and diff view
- Use `/open file --diff` or `open_file` with mode `diff` to start in diff mode
- The `[DIFF]` indicator appears in the title bar when active

## Overlay controls

| Key | Action |
|-----|--------|
| `↑` / `↓` or `j` / `k` | Scroll line by line |
| `PgUp` / `PgDn` or `Ctrl+U` / `Ctrl+D` | Scroll page |
| `g` / `G` | Jump to top / bottom |
| `d` | Toggle diff mode (when changes exist) |
| `e` | Open in nvim (tmux split) |
| `q` / `Esc` | Close |

## Tool modes

| Mode | What happens |
|------|-------------|
| `view` | Shows file in overlay modal with syntax highlighting |
| `diff` | Shows file in overlay starting in diff mode |
| `edit` | Opens file in nvim in a tmux horizontal split |

## Requirements

- **tmux** is required for the "edit" mode. If not in tmux, falls back gracefully with an error message.
- **diff** npm package (used for computing line diffs).
