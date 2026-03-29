# Context Engineering — Design

## Architecture

### Knowledge layer: `docs/`

```
docs/
├── README.md              ← usage guide for agents
├── playbooks/             ← curated how-to guides (auto-maintained)
│   ├── pi-extension.md
│   ├── pi-extension-testing.md
│   └── document-reviewer.md
└── features/              ← feature specs + verification workflows
    ├── {feature}/
    │   ├── prd.md
    │   ├── design.md
    │   └── workflows/
    └── archive/
```

Replaces LEARNINGS.md. Agents auto-update playbooks during Finalize step.

### Task layer: `.features/`

```
.features/{feature}/tasks/
├── _active.md
└── NNN-task.md
```

Tasks are operational and ephemeral. Specs (PRD, design) live in `docs/features/`.

### Implement-task phases

1. **Research** — Sub-agent reads relevant `docs/playbooks/`, prior art in codebase
2. **Code** — Implementation with backpressure hooks
3. **Review** — Verify against acceptance criteria
4. **Finalize** — Auto-doc sub-agent updates `docs/` and `AGENTS.md`

### Backpressure hooks

- `scripts/verify.sh` — Runs lint/test/build. Silent on success, verbose on failure. Exit code is the signal.
- `scripts/run_silent.sh` — Wrapper that suppresses stdout on exit 0, shows full output on failure.

### Handoff context packets

Structured format replacing chat summaries:

```markdown
## Status: {what was just completed}
## Key Decisions: {choices made and why}
## Blockers: {what's stuck and why}
## Files Changed: {paths + what changed}
## Next Steps: {what to do next}
## Active Feature: {feature context}
```

### AGENTS.md budget

Global AGENTS.md target: under 120 lines. Achieved by:
- Removing compound policy (done in task 001)
- Moving documentation policy to `docs/README.md`
- Keeping only workflow skeleton + non-negotiables + references to skills

## Task dependency graph

```
001 ✅ ──→ 002 ──→ 003 ──→ 008 ──→ 009
              ├──→ 004       ↑
              └──→ 007 ──────┘
         005 ──→ 007
         006 ──→ 008
```

## Phases

1. **Foundation** (001, 002, 005, 006) — Structure, hooks, handoff
2. **Skills** (003, 004, 007) — Update planning skills, AGENTS.md, implement-task
3. **Integration** (008, 009) — Loop skill, project AGENTS.md
