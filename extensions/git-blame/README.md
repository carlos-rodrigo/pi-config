# git-blame

Interactive git blame viewer in a syntax-highlighted overlay modal.

## Install

```bash
pi install ./extensions/git-blame
```

## What it adds

| Feature | Description |
|---------|-------------|
| `git_blame` tool | LLM-callable tool to show git blame for a file |

## Usage

**Ask the LLM:**

```text
Show me the git blame for src/app.tsx
Who last modified this file?
```

## Overlay controls

| Key | Action |
|-----|--------|
| `↑` / `↓` or `j` / `k` | Scroll line by line |
| `PgUp` / `PgDn` or `Ctrl+U` / `Ctrl+D` | Scroll page |
| `g` / `G` | Jump to top / bottom |
| `q` / `Esc` | Close |
