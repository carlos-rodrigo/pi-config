# Agent Documentation

> Single place for all agent-facing project knowledge.

## Structure

```
docs/
├── playbooks/     ← curated how-to guides (auto-maintained by agents)
├── features/      ← durable feature docs when they are worth writing
│   └── archive/   ← completed features
```

## Playbooks (`playbooks/`)

Curated guides for building specific types of things. Each playbook covers patterns, constraints, and gotchas for a topic. Agents auto-maintain these during the Finalize step of implementation.

**When to load:** During research phase, load only playbooks relevant to the current task. Don't read everything upfront.

## Features (`features/`)

Durable feature knowledge when it materially helps future work: strategy briefs and current system models. Persists after feature completes (moved to `archive/`).

Write feature docs when they:
- stabilize scope or requirements,
- preserve durable architecture context or link to an ADR,
- or prevent repeated rediscovery.

Do not create feature docs by default for every change.

**Tasks live separately** in `.features/{name}/tasks/` — operational, ephemeral, not documentation.

## Conventions

- Playbooks follow the template in each file (Overview → Patterns → Constraints → Gotchas)
- Self-improvement workflow: `docs/playbooks/self-improvement.md`
- Playbooks stay under 200 lines — split if growing beyond that
- Verification details belong in task feedback loops and task `## Result` sections, not separate report files
- Agents update relevant docs only when they discover durable, reusable knowledge during implementation
