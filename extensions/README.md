# Extensions

Each extension lives in its own folder and can be installed independently.

## Install all

```bash
pi install git:github.com/carlos-rodrigo/pi-config
```

Or run the install script for symlink-based local development:

```bash
./install.sh
```

## Install individually

```bash
pi install ./extensions/agent-jobs
pi install ./extensions/auto-prompt
pi install ./extensions/bordered-editor
pi install ./extensions/code-intel
pi install ./extensions/branch-switcher
pi install ./extensions/document-reviewer
pi install ./extensions/feature-flow
pi install ./extensions/file-opener
pi install ./extensions/git-blame
pi install ./extensions/lazygit
pi install ./extensions/ownership-loop
pi install ./extensions/prompt-queue
pi install ./extensions/review-mode
pi install ./extensions/semantic-search
pi install ./extensions/session-query
pi install ./extensions/verify
pi install ./extensions/web-tools
pi install ./extensions/workflow-modes
pi install ./extensions/worktree-manager
```

## Extensions

| Extension | Description |
|-----------|-------------|
| [agent-jobs](agent-jobs/) | Non-blocking tmux-backed researcher/oracle jobs with persisted logs/results |
| [auto-prompt](auto-prompt/) | Inline ghost text prompt suggestions (fish-style) |
| [bordered-editor](bordered-editor/) | Bordered input editor with model/context/git info |
| [branch-switcher](branch-switcher/) | Interactive git branch switching with local + remote-only branch support |
| [code-intel](code-intel/) | `code_find` orchestration plus symbol, dependency, git-history, and AST search tools |
| [document-reviewer](document-reviewer/) | Markdown review sessions with browser UI |
| [feature-flow](feature-flow/) | Lightweight-first feature orchestration with Git worktrees and docs on demand |
| [file-opener](file-opener/) | Syntax-highlighted file viewer with diff support |
| [git-blame](git-blame/) | Interactive git blame overlay |
| [lazygit](lazygit/) | LazyGit launcher via tmux |
| [ownership-loop](ownership-loop/) | Always-live story-driven ownership, `/own`, `/reown`, and ownership cards |
| [prompt-queue](prompt-queue/) | Interactive queue palette for staging prompts, pasting them into the editor, or running them serially |
| [review-mode](review-mode/) | Overlay review workbench for local/staged/unstaged/outgoing diffs with colorized preview, hunk/file/all scopes, same-session questions, and saved review notes |
| [semantic-search](semantic-search/) | Local Ollama-backed hybrid code index, semantic search tool, and repo concept map |
| [session-query](session-query/) | Query previous Pi session files for context and decisions |
| [web-tools](web-tools/) | Web search (Exa/Tavily) and fetch tools |
| [workflow-modes](workflow-modes/) | Smart/deep1/deep2/deep3/fast mode switching |
| [verify](verify/) | Preflight `verification_plan`, back-pressure hook, and `scripts/verify.sh` scaffolding via `/setup-verify` |
| [worktree-manager](worktree-manager/) | Git worktree management commands |

## Notes

- **ownership-loop** defaults to passive always-live mode: lightweight story guidance and silent edit/write tracking instead of automatic follow-ups or composer/status-bar text.
- **ownership-loop** + **auto-prompt** work together via session entries — auto-prompt treats `/reown` as optional and points to `/reown --remember` only when searchable memory is explicitly useful.
- **auto-prompt** + **bordered-editor** work together via `pi.events` — auto-prompt generates suggestions, bordered-editor renders the ghost text.
- **feature-flow** and **worktree-manager** share the same worktree core but are independent extensions.
- **agent-jobs** requires Pi to be running inside tmux; it uses detached windows and persists results under `.pi/agent-jobs/`.
- Researcher, oracle, and deep-review prompt templates use **agent-jobs** for non-blocking background work.
