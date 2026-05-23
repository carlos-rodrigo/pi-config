# Pi Config

My personal [Pi](https://github.com/badlogic/pi-mono) extensions, themes, agents, and prompts.

## Install

### Via pi (all extensions in this package)

```bash
pi install git:github.com/carlos-rodrigo/pi-config
```

### Via pi (one extension from a local clone)

Pi supports installing a local extension directory or single file directly. Clone the repo once, then install only the extension you want:

```bash
git clone https://github.com/carlos-rodrigo/pi-config.git
cd pi-config

pi install ./extensions/agent-jobs
pi install ./extensions/auto-prompt
pi install ./extensions/bordered-editor
pi install ./extensions/branch-switcher
pi install ./extensions/code-intel
pi install ./extensions/document-reviewer
pi install ./extensions/feature-flow
pi install ./extensions/file-opener
pi install ./extensions/git-blame
pi install ./extensions/lazygit
pi install ./extensions/ownership-loop
pi install ./extensions/review-mode
pi install ./extensions/semantic-search
pi install ./extensions/session-query
pi install ./extensions/verify
pi install ./extensions/web-tools
pi install ./extensions/workflow-modes
pi install ./extensions/worktree-manager
```

Notes:
- Use the extension directory path; each extension exposes an `index.ts` entrypoint.
- Some extensions are best used together, for example Auto Prompt (`auto-prompt`) + `bordered-editor`.
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

- **[agent-jobs](extensions/agent-jobs/)** — Run researcher/oracle jobs in detached tmux windows and resume via follow-up messages.
- **[auto-prompt](extensions/auto-prompt/)** — Inline ghost-text prompt suggestions.
- **[bordered-editor](extensions/bordered-editor/)** — Bordered composer with model, context, cost, and git status.
- **[branch-switcher](extensions/branch-switcher/)** — Interactive `/branch` command for local and remote branches.
- **[code-intel](extensions/code-intel/)** — `code_find` orchestration plus symbol, dependency, git-history, and AST search tools.
- **[document-reviewer](extensions/document-reviewer/)** — Browser-based document and PR review with inline comments.
- **[feature-flow](extensions/feature-flow/)** — Lightweight feature orchestration with Git worktrees.
- **[file-opener](extensions/file-opener/)** — Syntax-highlighted file viewer, nvim opener, and diff viewer.
- **[git-blame](extensions/git-blame/)** — Interactive git blame overlay.
- **[lazygit](extensions/lazygit/)** — LazyGit launcher via tmux.
- **[ownership-loop](extensions/ownership-loop/)** — Always-live story-driven ownership, `/own`, `/reown`, and ownership cards.
- **[review-mode](extensions/review-mode/)** — Overlay review workbench for local/staged/unstaged/outgoing diffs.
- **[semantic-search](extensions/semantic-search/)** — Local Ollama-backed hybrid code index, semantic search, and repo concept map.
- **[session-query](extensions/session-query/)** — Query previous Pi session files for context and decisions.
- **[verify](extensions/verify/)** — Preflight `verification_plan`, back-pressure verification hook, and `/setup-verify` scaffolder.
- **[web-tools](extensions/web-tools/)** — Web search and fetch tools.
- **[workflow-modes](extensions/workflow-modes/)** — Smart/deep1/deep2/deep3/fast mode switching.
- **[worktree-manager](extensions/worktree-manager/)** — Git worktree lifecycle manager.

### [Agents](agents/)

Agent definitions used by the agent-jobs extension:

- **oracle** — Deep reasoning second opinion (gpt-5.5). For complex debugging, architecture decisions, and thorough code analysis. Read-only.
- **researcher** — Concise research specialist (gpt-5.5). Investigates technologies, reads docs/source, compares approaches, and returns evidence-first briefs with bounded tool/output budgets. Uses `websearch`/`webfetch` instead of shelling out.

### Ownership loop

- `/own-mode passive | strict | off` — Configure always-live ownership behavior (default: passive).
- `/own <task>` — Create an approval-gated Initial Change Story before implementation.
- `/own-approve` — Mark the story approved; required before edits in strict mode.
- `/reown [scope]` — Compare the Initial Change Story to the actual diff and verification evidence, then recommend whether to save an ownership card.
- Reply `save it`, `skip`, or `revise title: <title>` after re-own to handle the pending `docs/ownership/` memory card conversationally.
- `/own-remember [title]` — Manual escape hatch to draft a `docs/ownership/` memory card for semantic search.
- `/own-status` — Show current ownership-loop state.
- `/own-off` — Disable the loop for the session.

### [Prompts](prompts/)

Workflow prompt templates:

- `/oracle <question>` / `/ask-oracle <question>` — Start a background oracle second-opinion job
- `/research <topic>` — Start a background researcher job
- `/deep-review <area>` — Start a background oracle review with git diff context
- `/research-and-plan <feature>` — Background researcher → oracle implementation recommendation
- `/oracle-checkpoint <decision>` — Background researcher → oracle checkpoint for high-uncertainty decisions

### [Themes](themes/)

- **catppuccin-macchiato** — [Catppuccin Macchiato](https://github.com/catppuccin/catppuccin) color palette.

## Usage Examples

```
# Direct — the main agent starts background agent jobs
Use the oracle to review the auth logic in src/auth/. I want to make sure there are no edge cases.
Use the researcher agent to investigate how Next.js App Router handles parallel routes.

# Ownership loop
/own-mode passive
/own Change workflow modes so all deep levels are visible and keyboard-switchable
/reown workflow modes
save it

# Via prompt templates
/oracle Is there a better way to handle the state machine in src/parser.ts?
/research What's the current best approach for real-time sync in web apps? Compare options.
/research-and-plan Add end-to-end encryption to our messaging feature
/oracle-checkpoint Choose an approach for cache invalidation across worker + API boundaries
/deep-review Review the error handling in src/api/

# Sequential handoff
Use researcher to investigate state of art for auth tokens, then ask oracle to analyze how our current auth compares.
```
