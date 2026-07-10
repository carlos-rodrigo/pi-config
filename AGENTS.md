# Project AGENTS.md

Personal Pi configuration: extensions, themes, agents, prompts, and harness tooling.

## Commands

```bash
npm test                # all tests
npm run test:direct     # unit tests only, skips document-reviewer integration
npm run test:<name>     # one extension/agent test, e.g. test:prompt-queue
bash scripts/verify.sh  # project verification entrypoint
```

Use `scripts/run_silent.sh` for context-efficient verification:

```bash
source scripts/run_silent.sh
run_silent "description" command arg1 arg2
```

## Local Guidance

- Extension inventory lives in `extensions/README.md`.
- For non-trivial extension work, load `docs/playbooks/pi-extension.md` first.
- Keep extension changes small and mirror nearby extension/test patterns.
- Lead task prompts and briefs with the desired result. Add only context, output requirements, critical boundaries, and success checks that materially help.
- Agent-facing docs live under `docs/`; tasks live under `.features/{feature}/tasks/` only when needed.

## Verification

`scripts/verify.sh` is the repo quality gate. It should be silent on success and verbose on failure.

The `verify` extension auto-runs this script on `agent_end` for touched project roots that contain `scripts/verify.sh`, then injects failures as follow-up messages.
