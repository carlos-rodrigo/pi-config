# worktree-manager

Manage feature workspaces with native Git worktrees.

## Install

```bash
pi install ./extensions/worktree-manager
```

## What it adds

| Feature | Description |
|---------|-------------|
| `/ws new <feature>` | Creates `feat/<slug>` from `main` in a sibling worktree (`../<repo>-<slug>`) |
| `/ws list` | Lists current worktrees with branch/path/dirty state |
| `/ws open <slug> [--window]` | Opens a tmux split pane by default (or a new window with `--window`) in an existing feature worktree and runs `pi -c` |
| `/ws remove <slug>` | Removes a feature worktree (asks confirmation if dirty) |
| `/ws prune` | Prunes stale worktree references |
| `worktree_manage` tool | LLM-callable worktree management API |

## Usage

```text
/ws new "add team oauth"
/ws list
/ws open add-team-oauth
/ws remove add-team-oauth
/ws prune
```

## Defaults

- Branch prefix: `feat/`
- Base branch: `main`
- Worktree location: sibling directory `../<repo>-<slug>`
- Slugs are derived from concise keywords in the brief, capped (48 chars), and hashed only when truncation is needed
