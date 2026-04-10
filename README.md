# Pi Config

My personal [Pi](https://github.com/badlogic/pi-mono) extensions, themes, agents, and prompts.

## Install

### Via pi (all extensions in this package)

```bash
pi install git:github.com/carlos-rodrigo/pi-config
```

### Via pi (one extension from a local clone)

Pi supports installing a single local extension file directly. Clone the repo once, then install only the extension you want:

```bash
git clone https://github.com/carlos-rodrigo/pi-config.git
cd pi-config

pi install ./extensions/bordered-editor.ts
pi install ./extensions/auto-prompt.ts
pi install ./extensions/file-opener.ts
pi install ./extensions/web-tools.ts
pi install ./extensions/workflow-modes.ts
pi install ./extensions/worktree-manager.ts
pi install ./extensions/feature-flow.ts
pi install ./extensions/document-reviewer.ts
pi install ./extensions/handoff.ts
pi install ./extensions/subagent/index.ts
```

Notes:
- Use the exact file path for the extension entrypoint.
- Some extensions are best used together, for example Auto Prompt (`auto-prompt.ts`) + `bordered-editor.ts`.
- Pi can install a single local file, but it does **not** currently install one subpath from a git package in a single `pi install` command. For remote one-by-one installs, each extension would need to be published as its own package.

### Via install.sh (everything)

```bash
git clone https://github.com/carlos-rodrigo/pi-config.git
cd pi-config
./install.sh
```

This symlinks all extensions, themes, agents, and prompts into `~/.pi/agent/`. Restart Pi and use `/reload` to pick up changes.

It also migrates any legacy `~/.pi/agent/skills/` entries into `~/.agents/skills/` and removes the legacy directory to avoid duplicate-skill collisions.

To update, just `git pull` — symlinks pick up changes automatically.

## Contents

### [Extensions](extensions/)

- **[bordered-editor](extensions/README.md#bordered-editor)** — Custom input box with rounded borders and embedded status info (model, context usage, cost, git branch).
- **[file-opener](extensions/README.md#file-opener)** — Open files in a syntax-highlighted overlay modal or in nvim via tmux, with built-in diff support. Adds `/open` command and `open_file` tool.
- **[web-tools](extensions/README.md#web-tools)** — Web search and page fetch tools for agents. Adds `websearch` and `webfetch` tools with Opencode-style provider choices.
- **[worktree-manager](extensions/README.md#worktree-manager)** — Git worktree lifecycle manager with `/ws` commands and `worktree_manage` tool.
- **[feature-flow](extensions/README.md#feature-flow)** — Opinionated `/feature` workflow orchestrator: create isolated branch/worktree, launch a tmux Pi pane by default (or window with `--window`), and start a lightweight-first feature workflow with docs on demand.
- **[subagent](extensions/subagent/)** — Delegate tasks to specialized sub-agents with isolated context windows. Supports single, parallel, and chain modes.

### [Agents](agents/)

Sub-agent definitions used by the subagent extension:

- **oracle** — Deep reasoning second opinion (gpt-5.4). For complex debugging, architecture decisions, and thorough code analysis. Read-only.
- **researcher** — Research specialist (Sonnet). Investigates technologies, reads library source code, compares approaches, checks state of the art. Uses `curl`/`gh`.

### [Prompts](prompts/)

Workflow prompt templates:

- `/ask-oracle <question>` — Ask the oracle for a second opinion (decision/risk/verification contract)
- `/research <topic>` — Research a technology, codebase, or library
- `/deep-review <area>` — Have the oracle deeply review code with structured output
- `/research-and-plan <feature>` — Research state of the art → get implementation recommendation
- `/oracle-checkpoint <decision>` — Run researcher → oracle chain for high-uncertainty decisions

### [Themes](themes/)

- **catppuccin-macchiato** — [Catppuccin Macchiato](https://github.com/catppuccin/catppuccin) color palette.

## Usage Examples

```
# Direct — the main agent decides when to use sub-agents
Use the oracle to review the auth logic in src/auth/. I want to make sure there are no edge cases.
Use the researcher agent to investigate how Next.js App Router handles parallel routes.

# Via prompt templates
/ask-oracle Is there a better way to handle the state machine in src/parser.ts?
/research What's the current best approach for real-time sync in web apps? Compare options.
/research-and-plan Add end-to-end encryption to our messaging feature
/oracle-checkpoint Choose an approach for cache invalidation across worker + API boundaries
/deep-review Review the error handling in src/api/

# Chain — sequential handoff
Use a chain: first have researcher investigate state of art for auth tokens, then have the oracle analyze how our current auth compares.
```
