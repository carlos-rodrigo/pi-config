# Pi Config

My personal [Pi](https://github.com/badlogic/pi-mono) extensions, themes, agents, and prompts.

## Install

### Via pi (extensions only)

```bash
pi install git:github.com/carlos-rodrigo/pi-config
```

### Via install.sh (everything)

```bash
git clone https://github.com/carlos-rodrigo/pi-config.git
cd pi-config
./install.sh
```

This symlinks all extensions, themes, agents, and prompts into `~/.pi/agent/`. Restart Pi and use `/reload` to pick up changes.

To update, just `git pull` — symlinks pick up changes automatically.

## Contents

### [Extensions](extensions/)

- **[bordered-editor](extensions/README.md#bordered-editor)** — Custom input box with rounded borders and embedded status info (model, context usage, cost, git branch).
- **[file-opener](extensions/README.md#file-opener)** — Open files in a syntax-highlighted overlay modal or in nvim via tmux, with built-in diff support. Adds `/open` command and `open_file` tool.
- **[subagent](extensions/subagent/)** — Delegate tasks to specialized sub-agents with isolated context windows. Supports single, parallel, and chain modes.

### [Agents](agents/)

Sub-agent definitions used by the subagent extension:

- **oracle** — Deep reasoning second opinion (gpt-5.3-codex). For complex debugging, architecture decisions, and thorough code analysis. Read-only.
- **librarian** — Code research across GitHub (Sonnet). Searches repos, reads library source code, traces implementations. Uses `gh` CLI.
- **researcher** — Internet research (Sonnet). Investigates technologies, compares approaches, checks state of the art. Uses `curl`/`gh`.
- **scout** — Fast codebase recon (Haiku). Quick investigation that returns compressed context for handoff to other agents.

### [Prompts](prompts/)

Workflow prompt templates:

- `/ask-oracle <question>` — Ask the oracle for a second opinion
- `/ask-librarian <question>` — Research codebases and library source code
- `/research <topic>` — Investigate a technology or approach
- `/deep-review <area>` — Scout the code, then have the oracle review it
- `/research-and-plan <feature>` — Research state of the art → find library examples → get implementation recommendation

### [Themes](themes/)

- **catppuccin-macchiato** — [Catppuccin Macchiato](https://github.com/catppuccin/catppuccin) color palette.

## Usage Examples

```
# Direct — the main agent decides when to use sub-agents
Use the oracle to review the auth logic in src/auth/. I want to make sure there are no edge cases.

# Via prompt templates
/ask-oracle Is there a better way to handle the state machine in src/parser.ts?
/ask-librarian How does Next.js App Router handle parallel routes? Show me the source code.
/research What's the current best approach for real-time sync in web apps? Compare options.
/research-and-plan Add end-to-end encryption to our messaging feature

# Parallel — multiple agents at once
Run the librarian and researcher in parallel: librarian investigates how Stripe handles webhooks, researcher finds best practices for webhook reliability.

# Chain — sequential handoff
Use a chain: first have the researcher investigate state of art for auth tokens, then have the oracle analyze how our current auth compares.
```
