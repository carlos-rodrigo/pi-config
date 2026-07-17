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
pi install ./extensions/agent-benchmark
pi install ./extensions/agent-memory
pi install ./extensions/auto-prompt
pi install ./extensions/bordered-editor
pi install ./extensions/code-intel
pi install ./extensions/branch-switcher
pi install ./extensions/checkpoint-rollback
pi install ./extensions/document-reviewer
pi install ./extensions/file-opener
pi install ./extensions/git-blame
pi install ./extensions/lazygit
pi install ./extensions/loop-monitor
pi install ./extensions/overseer
pi install ./extensions/prompt-queue
pi install ./extensions/review-mode
pi install ./extensions/semantic-search
pi install ./extensions/self-improvement-archive
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
| [agent-benchmark](agent-benchmark/) | Cheap local benchmark suite for evidence-based Pi config improvement |
| [agent-memory](agent-memory/) | Default-on local project/global memory with bounded recall, review controls, and verification feedback |
| [auto-prompt](auto-prompt/) | Inline ghost text prompt suggestions (fish-style) |
| [bordered-editor](bordered-editor/) | Bordered input editor with model/context/git info |
| [branch-switcher](branch-switcher/) | Interactive git branch switching with local + remote-only branch support |
| [checkpoint-rollback](checkpoint-rollback/) | Human-controlled git checkpoints with previewed rollback and explicit confirmation |
| [code-intel](code-intel/) | `code_find` orchestration plus symbol, dependency, git-history, and AST search tools |
| [document-reviewer](document-reviewer/) | Markdown review sessions with browser UI |
| [file-opener](file-opener/) | Syntax-highlighted file viewer with diff support |
| [git-blame](git-blame/) | Interactive git blame overlay |
| [lazygit](lazygit/) | LazyGit launcher via tmux |
| [loop-monitor](loop-monitor/) | Live current-project loop task dashboard with current-iteration log tail |
| [overseer](overseer/) | Warning-only event watchdog for repeated tool failures and risky large mutations |
| [prompt-queue](prompt-queue/) | Interactive queue palette for staging prompts, pasting them into the editor, or running them serially |
| [review-mode](review-mode/) | Overlay review workbench for local/staged/unstaged/outgoing diffs with colorized preview, hunk/file/all scopes, same-session questions, and saved review notes |
| [semantic-search](semantic-search/) | Local Ollama-backed hybrid code index, semantic search tool, and repo concept map |
| [self-improvement-archive](self-improvement-archive/) | Quiet local archive of run, verification, benchmark, warning, and proposal evidence |
| [session-query](session-query/) | Query previous Pi session files for context and decisions |
| [web-tools](web-tools/) | Web search (Exa/Tavily) and fetch tools |
| [workflow-modes](workflow-modes/) | Smart/deep2/deep3/fast mode switching |
| [verify](verify/) | Preflight `verification_plan`, back-pressure hook, and `scripts/verify.sh` scaffolding via `/setup-verify` |
| [worktree-manager](worktree-manager/) | Git worktree management commands |

## Notes

- **auto-prompt** + **bordered-editor** work together via `pi.events` — auto-prompt generates suggestions, bordered-editor renders the ghost text.
- **agent-jobs** requires Pi to be running inside tmux; it uses detached windows and persists results under `.pi/agent-jobs/`.
- Researcher, oracle, and deep-review prompt templates use **agent-jobs** for non-blocking background work.
- **worktree-manager** does not copy `.env*` files by default; use `copyEnv: true` or `/ws new <feature> --copy-env` only when the new worktree explicitly needs them.
- **web-tools** rejects private/local network targets, validates redirects, bounds response bodies, and honors tool cancellation.
