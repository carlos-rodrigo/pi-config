# lazygit

Open LazyGit in a tmux popup, split, or window directly from Pi.

## Install

```bash
pi install ./extensions/lazygit
```

## What it adds

| Feature | Description |
|---------|-------------|
| `/lazygit [path] [--split mode]` | Opens LazyGit in tmux |
| `lazygit` tool | LLM-callable LazyGit launcher |

## Usage

```text
/lazygit
/lazygit src/
/lazygit --split horizontal
/lazygit src/ --split window
```

## Split modes

| Mode | Description |
|------|-------------|
| `popup` | Tmux popup overlay (default) |
| `horizontal` | Horizontal tmux split |
| `vertical` | Vertical tmux split |
| `window` | New tmux window |

## Requirements

- **tmux** — must be running inside a tmux session
- **lazygit** — must be installed
