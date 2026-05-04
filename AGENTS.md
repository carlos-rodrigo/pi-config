# Project AGENTS.md

Personal Pi configuration: extensions, themes, agents, prompts, and harness tooling.

## Commands

```bash
npm test                # all tests
npm run test:direct     # unit tests only, skips document-reviewer integration
npm run test:<name>     # one extension/agent test, e.g. test:dumb-zone
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
- Agent-facing docs live under `docs/`; tasks live under `.features/{feature}/tasks/` only when needed.

## Search Ladder

- When unsure which search mode fits, start with `code_find`.
- Exact identifiers, error strings, filenames, or narrow literals: use `grep` / `find` first.
- Known or guessed function/class/type/tool/command names: use `symbol_search`.
- Code shape/API usage patterns: use `ast_search` when ast-grep is installed.
- Import impact or shared-module risk: use `dependency_map` before editing.
- History/intent questions: use `git_pickaxe` or `git_blame`.
- Unknown behavior/feature/concept location: use `semantic_search`; use `repo_map` for unfamiliar areas.
- Treat all search results as candidates: always `read` the returned path and line range before editing.
- If semantic results look stale, use `index_status`; rebuild with `/index rebuild` or call `semantic_search` with `refresh: true`.

## Verification

`scripts/verify.sh` is the repo quality gate. It should be silent on success and verbose on failure.

The `verify` extension auto-runs this script on `agent_end` for touched project roots that contain `scripts/verify.sh`, then injects failures as follow-up messages.
