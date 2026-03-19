# Extensions

## Install individually with `pi install`

From a local clone of this repo, you can install only the extension you want:

```bash
pi install ./extensions/bordered-editor.ts
pi install ./extensions/auto-prompt.ts
pi install ./extensions/file-opener.ts
pi install ./extensions/web-tools.ts
pi install ./extensions/workflow-modes.ts
pi install ./extensions/worktree-manager.ts
pi install ./extensions/feature-flow.ts
pi install ./extensions/document-reviewer.ts
pi install ./extensions/handoff.ts
pi install ./extensions/agent-handoff.ts
pi install ./extensions/subagent/index.ts
```

Notes:
- `subagent` uses `./extensions/subagent/index.ts` as its extension entrypoint.
- `document-reviewer.ts`, `feature-flow.ts`, and `worktree-manager.ts` import helper files next to them; install the entrypoint file exactly as shown.
- Auto Prompt (`auto-prompt.ts`) is most useful together with `bordered-editor`.

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

## web-tools

Web search and web fetch tools for agent use, modeled after Opencode-style `websearch` and `webfetch` behavior.

### What it adds

| Tool | Description |
|------|-------------|
| `websearch` | Searches the web using **Exa** by default, with optional **Tavily** support |
| `webfetch` | Fetches a URL and returns content as `text`, `markdown`, or raw `html` |

### Usage

**Ask the agent:**

```text
Search the web for the latest Pi package docs
Fetch https://example.com/docs as markdown
Search for Next.js caching docs, only from nextjs.org
```

### websearch

Parameters:
- `query` — search query string
- `provider` — `exa` or `tavily` (defaults to `exa`, matching Opencode)
- `allowed_domains` — optional allowlist
- `blocked_domains` — optional blocklist
- `limit` — optional result count cap

Environment variables:
- `EXA_API_KEY` for `provider=exa`
- `TAVILY_API_KEY` for `provider=tavily`

### webfetch

Parameters:
- `url` — fully formed `http`/`https` URL (`http` auto-upgrades to `https`)
- `format` — `text`, `markdown`, or `html`
- `maxChars` — optional output size cap

Behavior:
- Read-only
- Short in-memory cache window
- HTML pages are converted to markdown/text when requested

### Notes

- `websearch` mirrors Opencode's provider choice: **Exa** by default, **Tavily** optionally.
- `webfetch` follows the Opencode bridge contract of explicit output formats: `text | markdown | html`.

---

## document-reviewer

Provides a `/review` command for markdown review sessions backed by a localhost service and browser UI.

### What it adds

| Feature | Description |
|---------|-------------|
| `/review <path>` command | Validates a markdown path, creates a local review session, and opens the review URL |
| Local review service (`127.0.0.1`) | Session/document APIs bound to loopback only |
| Ephemeral session token guard | Frontend API calls require `x-review-session-token`; missing/invalid tokens are rejected |
| Keyboard-first visualizer UI | Vim-style navigation with visual selection for focused markdown review |
| Background review wait | `/review` returns immediately so you can keep using the agent while the browser session is open |
| Cross-platform launcher | Opens target URL via `open` (macOS), `xdg-open` (Linux), or `start` (Windows) with manual fallback instructions |

### Usage

```text
/review .features/document-reviewer-extension/prd.md
/review "docs/Design Notes.md"
/review help
```

### After finishing review

1. Press `Ctrl+Shift+F` in the browser to finalize and write annotations.
2. The tab will attempt to close automatically; if your browser blocks it, close it manually.
3. Return to Pi and prompt: `Apply comments in <file>`.

### Keybindings inside reviewer UI

| Key | Action |
|-----|--------|
| `j` / `k` | Move cursor up/down in normal mode (auto-scrolls as needed) |
| `v` | Toggle visual mode (selection mode) |
| `h` / `j` / `k` / `l` | Move text cursor in visual mode |
| `Shift+h/j/k/l` | Extend selection in visual mode |
| `c` | Comment on current selection |
| `Ctrl+d` / `Ctrl+u` | Page down/up |
| `Esc` | Exit visual mode / close popup |
| `Ctrl+Shift+F` | Finish review |

### Validation behavior

- Missing path shows usage help.
- Non-existent path returns actionable file-not-found guidance.
- Directories are rejected (must be a file).
- Symlinks are rejected for workspace safety.
- Non-markdown files are rejected (`.md`, `.markdown`, `.mdown`, `.mkd`, `.mdx`).

### Limitations

- Review service is local to the machine running Pi (`127.0.0.1` only).
- One browser tab maps to one review session.
- Markdown is read-only in reviewer mode (review, not editing workflow).

### Troubleshooting

- **Browser did not open automatically**
  - The session still runs locally; copy the URL from the review status message and open it manually.
  - In SSH/headless environments, use the suggested `ssh -L` tunnel command from the fallback output.
- **401 from review APIs**
  - Reload the `/review` URL to refresh bootstrap token for that session.

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

---

## Auto Prompt

Inline ghost text prompt suggestions — like fish shell autosuggestion but for your next prompt.

### Preview

After the agent finishes responding, a gray suggestion appears inside the editor:

```
╭──────────────────────────── claude-opus-4-6 · xhigh ─────────╮
│   ▌Implement the error handling changes from the design       │
╰─ 42% of 200k · $1.14 ──────────────── ~/project (main) ────╯
     ↑                                 ↑
  cursor                        gray ghost text
```

### How it works

1. After `agent_end`, calls an LLM (Sonnet 4.6, fallback Haiku 4.5) with the last few messages
2. The LLM returns one short suggested next-step prompt the user can send to move the work forward
3. The suggestion appears as gray ghost text in the editor (rendered by `bordered-editor`)
4. Uses the same API key already configured in pi — no extra setup

### Interaction

| Input | What happens |
|-------|-------------|
| **→** (right arrow) | Accept: ghost text becomes real editor text, cursor at end |
| **Any character** | Dismiss ghost, character typed normally |
| **Backspace** | Dismiss ghost |
| **Escape** | Dismiss ghost |
| Type before suggestion arrives | LLM call is cancelled, no ghost shown |

### Commands

| Command | Description |
|---------|-------------|
| `/suggest` | Toggle auto-suggestions on/off |
| `/suggest now` | Manually trigger a suggestion |
| `/suggest model` | Show current suggestion model |
| `/suggest model <provider>/<id>` | Change model (e.g. `/suggest model anthropic/claude-haiku-4-5`) |

### Configuration

- **Default model:** `anthropic/claude-sonnet-4-6`
- **Fallback model:** `anthropic/claude-haiku-4-5` (if primary unavailable)
- State (enabled/disabled, model) persists across session restarts
- Agent mode context (smart/deep/fast) is included in the suggestion prompt for relevance

### Architecture

Two-extension communication via `pi.events`:

- **auto-prompt.ts** — suggestion engine (LLM calls, timing, cancellation)
- **bordered-editor.ts** — ghost text rendering and input handling

Events: `auto-prompt:suggest`, `auto-prompt:clear`, `auto-prompt:accepted`, `auto-prompt:dismissed`
