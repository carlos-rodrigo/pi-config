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
| Bottom right | Working directory + git state | Branch in **violet** for main checkout, **WT ...** tag for linked worktrees |

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

---

## worktree-manager

Manage feature workspaces with native Git worktrees.

### What it adds

| Feature | Description |
|---------|-------------|
| `/ws new <feature>` | Creates `feat/<slug>` from `main` in a sibling worktree (`../<repo>-<slug>`) |
| `/ws list` | Lists current worktrees with branch/path/dirty state |
| `/ws open <slug> [--window]` | Opens a tmux split pane by default (or a new window with `--window`) in an existing feature worktree and runs `pi -c` |
| `/ws remove <slug>` | Removes a feature worktree (asks confirmation if dirty) |
| `/ws prune` | Prunes stale worktree references |
| `worktree_manage` tool | LLM-callable worktree management API |

### Usage

```text
/ws new "add team oauth"
/ws list
/ws open add-team-oauth
/ws remove add-team-oauth
/ws prune
```

### Defaults

- Branch prefix: `feat/`
- Base branch: `main`
- Worktree location: sibling directory `../<repo>-<slug>`
- Slugs are derived from concise keywords in the brief, capped (48 chars), and hashed only when truncation is needed

---

## feature-flow

High-level feature orchestration that uses the same worktree core as `worktree-manager`.

### What it adds

| Feature | Description |
|---------|-------------|
| `/feature <brief>` | Creates isolated feature workspace, opens a tmux split pane by default, and starts clarifying-questions-first kickoff prompt |
| `/feature <brief> --slug <name>` | Same as above but with explicit slug override |
| `/feature <brief> --window` | Same workflow, but launches in a new tmux window instead of a split pane |
| `/feature list` | Lists active `feat/*` worktrees |
| `/feature open <slug> [--window]` | Opens feature workspace in tmux (`pi -c`) as pane by default or window with `--window` |
| `/feature reopen <slug> [--window]` | Alias for `/feature open <slug> [--window]` |
| `/feature close <slug>` | Removes feature workspace (with dirty-check confirmation) |

### Workflow started by `/feature <brief>`

1. Generate a concise slug from the brief (or use `--slug`), then let you confirm/edit it in interactive mode
2. Create worktree `../<repo>-<slug>` on branch `feat/<slug>` (auto-adds numeric suffix if needed)
3. Open a tmux split pane by default (or a new window with `--window`) and run Pi with an auto-generated kickoff prompt
4. Kickoff prompt enforces: clarifying questions → PRD approval → design approval → tasks, and auto-opens generated PRD/design files for immediate review

### Fallback behavior

If worktree creation fails, the extension automatically:
- creates `feat/<slug>` from `main` in the current repo,
- checks it out when the repo is clean,
- and continues the feature kickoff there.
