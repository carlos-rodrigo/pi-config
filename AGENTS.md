# Project AGENTS.md

Personal pi extensions and themes — bordered editor, file opener, catppuccin theme.

## Commands

```bash
npm test              # run all tests
npm run test:direct   # run unit tests only (no document-reviewer integration)
npm run test:<name>   # run a single extension's tests (e.g. test:dumb-zone)
bash scripts/verify.sh  # back-pressure verification (silent success, verbose failure)
```

## Documentation

Agent-facing knowledge lives in `docs/`:

```
docs/
├── playbooks/     ← curated how-to guides (auto-maintained)
├── features/      ← durable feature docs when they are worth writing
│   └── archive/   ← completed features
```

Tasks are separate in `.features/{feature}/tasks/` (ephemeral, operational).

Documentation is demand-driven, not mandatory:
- write docs when they clarify scope, preserve a durable decision, capture reusable verification, or prevent repeated rediscovery
- skip docs that only restate the code, the diff, or temporary execution notes
- use `docs/playbooks/` for reusable procedures/gotchas
- use `docs/features/{feature}/` for concise briefs, designs, or verification workflows only when they materially help future work

Load relevant playbooks during research — don't read everything upfront.

## Extensions

| Extension | Purpose |
|-----------|---------|
| `bordered-editor` | Rounded-border composer with mode, model, context, cost, git info |
| `dumb-zone` | Context-window monitor — shows active zone label, auto-handoff at 45% |
| `handoff` | `/handoff` command + LLM tool — produces structured context packets |
| `workflow-modes` | Smart/Deep/Fast agent modes with model switching |
| `auto-prompt` | Ghost-text suggestions after each turn |
| `document-reviewer` | Browser-based document and PR review with inline comments |
| `web-tools` | Web search and fetch tools |
| `lazygit` | LazyGit integration via tmux |
| `verify` | Back-pressure hook — verifies touched project roots and includes `/setup-verify` scaffolding |

## Verification

`scripts/verify.sh` is the project-level verification entrypoint. Silent on success (exit 0), verbose on failure.
The `verify` extension auto-runs it on `agent_end` for touched project roots that contain `scripts/verify.sh`.
If verification fails, errors are injected as a follow-up message so the agent must fix them before finishing.
Use `/setup-verify` to scaffold `scripts/verify.sh` and trigger the agent to customize it for the current repo.

Use `scripts/run_silent.sh` for context-efficient command execution:
```bash
source scripts/run_silent.sh
run_silent "description" command arg1 arg2
```
