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
pi install ./extensions/bordered-editor
pi install ./extensions/auto-prompt
pi install ./extensions/file-opener
pi install ./extensions/web-tools
pi install ./extensions/workflow-modes
pi install ./extensions/worktree-manager
pi install ./extensions/feature-flow
pi install ./extensions/document-reviewer
pi install ./extensions/handoff
pi install ./extensions/agent-handoff
pi install ./extensions/lazygit
pi install ./extensions/git-blame
pi install ./extensions/subagent
```

## Extensions

| Extension | Description |
|-----------|-------------|
| [agent-handoff](agent-handoff/) | LLM-callable tool for autonomous session handoff |
| [auto-prompt](auto-prompt/) | Inline ghost text prompt suggestions (fish-style) |
| [bordered-editor](bordered-editor/) | Bordered input editor with model/context/git info |
| [document-reviewer](document-reviewer/) | Markdown review sessions with browser UI |
| [feature-flow](feature-flow/) | Feature orchestration with Git worktrees |
| [file-opener](file-opener/) | Syntax-highlighted file viewer with diff support |
| [git-blame](git-blame/) | Interactive git blame overlay |
| [handoff](handoff/) | `/handoff` command for context transfer to new sessions |
| [lazygit](lazygit/) | LazyGit launcher via tmux |
| [subagent](subagent/) | Delegate tasks to specialized sub-agents |
| [web-tools](web-tools/) | Web search (Exa/Tavily) and fetch tools |
| [workflow-modes](workflow-modes/) | Smart/deep/fast mode switching |
| [worktree-manager](worktree-manager/) | Git worktree management commands |

## Notes

- **auto-prompt** + **bordered-editor** work together via `pi.events` — auto-prompt generates suggestions, bordered-editor renders the ghost text.
- **feature-flow** and **worktree-manager** share the same worktree core but are independent extensions.
- **handoff** is the user command (`/handoff`), **agent-handoff** is the LLM-callable tool version.
