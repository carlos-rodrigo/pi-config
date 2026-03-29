# Project AGENTS.md

Personal pi extensions and themes — bordered editor, file opener, catppuccin theme.

## Commands

```bash
npm test              # run all tests
npm run test:direct   # run unit tests only (no document-reviewer integration)
npm run test:<name>   # run a single extension's tests (e.g. test:dumb-zone)
```

## Extensions

| Extension | Purpose |
|-----------|---------|
| `bordered-editor` | Rounded-border composer with mode, model, context, cost, git info |
| `dumb-zone` | Context-window monitor — shows active zone label, auto-handoff at 45% |
| `handoff` | `/handoff` command + LLM-callable `handoff` tool for session transfer |
| `workflow-modes` | Smart/Deep/Fast agent modes with model switching |
| `auto-prompt` | Ghost-text suggestions after each turn |
| `document-reviewer` | Browser-based document and PR review with inline comments |
| `web-tools` | Web search and fetch tools |
| `lazygit` | LazyGit integration via tmux |
| `verify` | Back-pressure hook — runs `scripts/verify.sh` on agent_end |

## Verification

`scripts/verify.sh` runs tests. Silent on success (exit 0), verbose on failure.
The `verify` extension auto-runs this on `agent_end` — if tests fail, errors are
injected as a follow-up message so the agent must fix them before finishing.

```bash
bash scripts/verify.sh        # manual run
```

Use `scripts/run_silent.sh` for context-efficient command execution:
```bash
source scripts/run_silent.sh
run_silent "description" command arg1 arg2
```
