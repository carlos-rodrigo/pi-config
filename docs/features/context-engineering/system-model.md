# Context Engineering — System Model

## Current architecture

### Knowledge layer: `docs/`

```text
docs/
├── README.md              # usage guide for agents
├── playbooks/             # curated how-to guides loaded on demand
└── features/              # durable feature packets when useful
    ├── README.md          # packet shape and ownership rule
    ├── <slug>/
    │   ├── feature.json
    │   ├── strategy.md
    │   ├── system-model.md
    │   └── diagrams/      # optional system diagrams
    └── archive/
```

### Task layer: ignored `.features/`

```text
.features/<feature>/tasks/
├── _active.md
└── NNN-task.md
```

Tasks are operational and ephemeral. Durable strategy and current architecture live in `docs/features/`; verification results stay in task-local `## Result` sections under ignored `.features/`.

### Feedback layer

- `scripts/verify.sh` — project regression gate. Silent on success, verbose on failure.
- `scripts/run_silent.sh` — helper for context-efficient command output.
- `verification_plan` — pre-edit verification contract for behavior-changing work.
- `agent-jobs` researcher/oracle — optional context firewall and second-opinion review.

## Intended agent flow

1. Read the nearest `AGENTS.md`.
2. Load only relevant playbooks or feature packet files.
3. Define or reuse a verification contract before behavior-changing edits.
4. Work in a small slice.
5. Run focused checks, then `bash scripts/verify.sh` for the final gate.
6. Update durable docs only when new reusable knowledge was discovered.

## Design constraints

- Keep always-loaded docs short.
- Prefer repo-local source of truth over chat memory.
- Use deterministic checks before LLM review.
- Do not create feature packets for trivial changes.
