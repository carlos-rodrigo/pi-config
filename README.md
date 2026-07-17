# Pi Config

My personal [Pi](https://github.com/badlogic/pi-mono) extensions, skills, themes, agents, and prompts.

## Install

### Via pi (packaged extensions, skills, prompts, and themes)

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
pi install ./extensions/file-opener
pi install ./extensions/git-blame
pi install ./extensions/lazygit
pi install ./extensions/prompt-queue
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

This symlinks all extensions, themes, agents, prompts, and repo-managed skills into `~/.pi/agent/` and `~/.agents/skills/`. Use this path when you also want local agent definitions; Pi package install covers extensions, skills, prompts, and themes. Restart Pi and use `/reload` to pick up changes.

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
- **[file-opener](extensions/file-opener/)** — Syntax-highlighted file viewer, nvim opener, and diff viewer.
- **[git-blame](extensions/git-blame/)** — Interactive git blame overlay.
- **[lazygit](extensions/lazygit/)** — LazyGit launcher via tmux.
- **[prompt-queue](extensions/prompt-queue/)** — Interactive queue palette for staging prompts and running them serially.
- **[review-mode](extensions/review-mode/)** — Overlay review workbench for local/staged/unstaged/outgoing diffs.
- **[semantic-search](extensions/semantic-search/)** — Local Ollama-backed hybrid code index, semantic search, and repo concept map.
- **[session-query](extensions/session-query/)** — Query previous Pi session files for context and decisions.
- **[verify](extensions/verify/)** — Preflight `verification_plan`, back-pressure verification hook, and `/setup-verify` scaffolder.
- **[web-tools](extensions/web-tools/)** — Web search and fetch tools.
- **[workflow-modes](extensions/workflow-modes/)** — Fast/smart/deep3/max GPT-5.6 Sol effort switching.
- **[worktree-manager](extensions/worktree-manager/)** — Git worktree lifecycle manager.

### [Skills](skills/)

- **system-diagram** — Excalidraw-style HTML/SVG System Diagrams for code flows, component communication, domain concepts, and system mental models.

### [Agents](agents/)

Agent definitions used by the agent-jobs extension:

- **oracle** — Deep reasoning second opinion (gpt-5.6-sol, xhigh). For complex debugging, architecture decisions, and read-only code reviews that always run the Are You Proud validation.
- **researcher** — Concise research specialist (gpt-5.6-terra). Investigates technologies, reads docs/source, compares approaches, and returns evidence-first briefs with bounded tool/output budgets. Uses `websearch`/`webfetch` instead of shelling out.
- **librarian** — Remote GitHub code research specialist (gpt-5.6-terra). Uses only `bash` with the authenticated `gh` CLI for public/private GitHub source search and upstream library inspection. Read-only.

### Feature packets

See [docs/features/README.md](docs/features/README.md) for the durable feature packet shape. No feature orchestration extension is currently shipped from this repo; create/update feature packet files directly or through the planning skills/prompts.

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
Use the librarian agent to search GitHub for real examples of React useEffect cleanup patterns.

# Via prompt templates
/oracle Is there a better way to handle the state machine in src/parser.ts?
/research What's the current best approach for real-time sync in web apps? Compare options.
/research-and-plan Add end-to-end encryption to our messaging feature
/oracle-checkpoint Choose an approach for cache invalidation across worker + API boundaries
/deep-review Review the error handling in src/api/

# Sequential handoff
Use researcher to investigate state of art for auth tokens, then ask oracle to analyze how our current auth compares.
```
