# lazygit

Open LazyGit as an interactive modal overlay inside Pi. A hidden Herdr tab provides the terminal process while the Pi component renders its screen and forwards keyboard input.

## Install

```bash
pi install ./extensions/lazygit
```

## What it adds

| Feature | Description |
|---------|-------------|
| `/lazygit [path]` | Opens the modal for the current repository or requested path |
| `lazygit` tool | LLM-callable modal launcher |

## Usage

```text
/lazygit
/lazygit src/
```

Use LazyGit normally. Quit with `q`; `Ctrl+Q` force-closes the modal and its hidden Herdr tab.

The old `--split` command flag and tool parameter are accepted for compatibility but ignored. LazyGit now always opens in the modal.

## Requirements

- **Herdr** — Pi must run in a Herdr workspace
- **Pi TUI mode** — modal components are unavailable in print, JSON, and RPC modes
- **LazyGit** — install with `brew install lazygit`
