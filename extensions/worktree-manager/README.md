# worktree-manager

Manage feature workspaces with native Git worktrees.

## Install

```bash
pi install ./extensions/worktree-manager
```

## What it adds

| Feature | Description |
|---------|-------------|
| `/ws new <feature>` | Creates `feat/<slug>` from `main` in a sibling worktree (`../<repo>-<slug>`) and copies the local development environment |
| `/ws list` | Lists current worktrees with branch/path/dirty state |
| `/ws open <slug> [--window]` | Opens a tmux split pane by default (or a new window with `--window`) in an existing feature worktree and runs `pi -c` |
| `/ws remove <slug>` | Removes a feature worktree (asks confirmation if dirty) |
| `/ws prune` | Prunes stale worktree references |
| `worktree_manage` tool | LLM-callable worktree management API |

## Usage

```text
/ws new "add team oauth"
/ws new "isolated scratch work" --no-copy-local
/ws list
/ws open add-team-oauth
/ws remove add-team-oauth
/ws prune
```

## Defaults

- Branch prefix: `feat/`
- Base branch: `main`
- Worktree location: sibling directory `../<repo>-<slug>`
- Environment sources: the invoking worktree first for task/skill context, then the primary worktree for missing artifacts; the primary semantic index is preferred because new branches start from `main`, with the invoking index used only as fallback
- Local environment copy: enabled by default; use `--no-copy-local` or `copyLocal: false` to opt out
- Copied local artifacts: root hidden files/directories such as `.env*`, `.claude`, `.agents`, `.features`, editor/tool settings, and `.pi/semantic-search/{index.json,summaries.json}`
- Existing checked-out files are never overwritten; symlinks are preserved
- Exact copied paths are added to the repository-local `.git/info/exclude`, keeping new worktrees clean and preventing accidental staging (use `git add -f` to promote one intentionally)
- Large files use copy-on-write cloning when the filesystem supports it
- Excluded runtime state: `.git`, generic caches, Pi agent/loop job histories, rebuild logs/status, process files, and other `.pi` runtime state
- Copied semantic indexes relocate to the new worktree and validate content hashes before use
- Slugs are derived from concise keywords in the brief, capped (48 chars), and hashed only when truncation is needed
