# Agent Documentation

> Single place for all agent-facing project knowledge.

## Structure

```
docs/
├── playbooks/     ← curated how-to guides (auto-maintained by agents)
├── features/      ← feature specs (PRD, design) + verification workflows
│   └── archive/   ← completed features
```

## Playbooks (`playbooks/`)

Curated guides for building specific types of things. Each playbook covers patterns, constraints, and gotchas for a topic. Agents auto-maintain these during the Finalize step of implementation.

**When to load:** During research phase, load only playbooks relevant to the current task. Don't read everything upfront.

## Features (`features/`)

Durable feature knowledge: PRD, design docs, and verification workflows. Persists after feature completes (moved to `archive/`).

**Tasks live separately** in `.features/{name}/tasks/` — operational, ephemeral, not documentation.

## Conventions

- Playbooks follow the template in each file (Overview → Patterns → Constraints → Gotchas)
- Playbooks stay under 200 lines — split if growing beyond that
- Features include `workflows/` with descriptions of how to verify each workflow
- Agents update relevant playbooks when discovering new patterns during implementation
