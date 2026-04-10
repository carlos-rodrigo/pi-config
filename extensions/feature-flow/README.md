# feature-flow

High-level feature orchestration with isolated Git worktrees.

## Install

```bash
pi install ./extensions/feature-flow
```

## What it adds

| Feature | Description |
|---------|-------------|
| `/feature <brief>` | Creates isolated feature workspace, opens a tmux split pane by default, and starts clarifying-questions-first kickoff prompt |
| `/feature <brief> --slug <name>` | Same as above but with explicit slug override |
| `/feature <brief> --window` | Same workflow, but launches in a new tmux window instead of a split pane |
| `/feature list` | Lists active `feat/*` worktrees |
| `/feature open <slug> [--window]` | Opens feature workspace in tmux (`pi -c`) as pane by default or window with `--window` |
| `/feature reopen <slug> [--window]` | Alias for `/feature open <slug> [--window]` |
| `/feature close <slug>` | Removes feature workspace (with dirty-check confirmation) |

## Workflow started by `/feature <brief>`

1. Generate a concise slug from the brief (or use `--slug`), then let you confirm/edit it in interactive mode
2. Create worktree `../<repo>-<slug>` on branch `feat/<slug>` (auto-adds numeric suffix if needed)
3. Open a tmux split pane by default (or a new window with `--window`) and run Pi with an auto-generated kickoff prompt
4. Kickoff prompt enforces a **lightweight-first workflow**:
   - briefly clarify/explore,
   - choose the lightest fitting path (direct implementation, investigate+plan, or full feature workflow),
   - create docs only when they materially help,
   - auto-open any PRD/design docs that are created for immediate review

There is **no mandatory PRD → design → tasks sequence** anymore. The extension now encourages useful documentation on demand instead of strict ceremony.

## Fallback behavior

If worktree creation fails, the extension automatically:
- creates `feat/<slug>` from `main` in the current repo,
- checks it out when the repo is clean,
- and continues the feature kickoff there.
