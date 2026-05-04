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
pi install ./extensions/auto-prompt
pi install ./extensions/bordered-editor
pi install ./extensions/code-intel
pi install ./extensions/branch-switcher
pi install ./extensions/document-reviewer
pi install ./extensions/dumb-zone
pi install ./extensions/feature-flow
pi install ./extensions/file-opener
pi install ./extensions/git-blame
pi install ./extensions/handoff
pi install ./extensions/lazygit
pi install ./extensions/review-mode
pi install ./extensions/semantic-search
pi install ./extensions/session-query
pi install ./extensions/subagent
pi install ./extensions/verify
pi install ./extensions/web-tools
pi install ./extensions/workflow-modes
pi install ./extensions/worktree-manager
```

## Extensions

| Extension | Description |
|-----------|-------------|
| [auto-prompt](auto-prompt/) | Inline ghost text prompt suggestions (fish-style) |
| [bordered-editor](bordered-editor/) | Bordered input editor with model/context/git info |
| [branch-switcher](branch-switcher/) | Interactive git branch switching with local + remote-only branch support |
| [code-intel](code-intel/) | `code_find` orchestration plus symbol, dependency, git-history, and AST search tools |
| [document-reviewer](document-reviewer/) | Markdown review sessions with browser UI |
| [dumb-zone](dumb-zone/) | Context-window monitor with auto-handoff before degradation |
| [feature-flow](feature-flow/) | Lightweight-first feature orchestration with Git worktrees and docs on demand |
| [file-opener](file-opener/) | Syntax-highlighted file viewer with diff support |
| [git-blame](git-blame/) | Interactive git blame overlay |
| [handoff](handoff/) | `/handoff` command + LLM-callable `handoff` tool for session transfer |
| [lazygit](lazygit/) | LazyGit launcher via tmux |
| [review-mode](review-mode/) | Overlay review workbench for local/staged/unstaged/outgoing diffs with colorized preview, hunk/file/all scopes, same-session questions, and saved review notes |
| [semantic-search](semantic-search/) | Local Ollama-backed hybrid code index, semantic search tool, and repo concept map |
| [session-query](session-query/) | Query previous Pi session files from fresh handoff sessions |
| [subagent](subagent/) | Delegate tasks to specialized sub-agents |
| [web-tools](web-tools/) | Web search (Exa/Tavily) and fetch tools |
| [workflow-modes](workflow-modes/) | Smart/deep/fast mode switching |
| [verify](verify/) | Back-pressure hook — verifies touched project roots and scaffolds `scripts/verify.sh` via `/setup-verify` |
| [worktree-manager](worktree-manager/) | Git worktree management commands |

## Notes

- **auto-prompt** + **bordered-editor** work together via `pi.events` — auto-prompt generates suggestions, bordered-editor renders the ghost text.
- **feature-flow** and **worktree-manager** share the same worktree core but are independent extensions.
- **handoff** provides both the user `/handoff` command and the LLM-callable `handoff` tool.
