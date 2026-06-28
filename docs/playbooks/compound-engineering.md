# Compound Engineering

> When to use: during a task's finish phase, after a repeated learning, failure, or shortcut might be worth turning into reusable leverage.

## Overview

Compound engineering means converting proven, repeated lessons into small assets that make future agent work safer or faster. In this repo it is a **finish-phase discipline**, not an autonomous self-editing system.

Good compounding is conservative:

- Evidence first: use task results, verification failures, archive trends, benchmark results, or repeated manual friction.
- Human-gated: proposals remain advisory until the user approves implementation.
- Smallest leverage: prefer the least durable artifact that prevents rediscovery.
- Reversible: every durable change should have clear rollback or expiry criteria.

## Patterns

### Leverage ladder

Choose the lowest rung that solves the next similar problem.

1. **Do nothing** — the lesson was one-off, obvious, or not worth maintaining.
2. **Task note** — add context to the next task brief when only the immediate follow-up needs it.
3. **Doc/playbook** — preserve reusable guidance that future agents should load on demand.
4. **Test fixture or regression check** — catch a failure that can recur in code or docs.
5. **Benchmark seed/tier** — measure a repeatable quality or performance concern cheaply.
6. **Hook or warning** — surface recurring risk without blocking normal work.
7. **Extension/tool** — automate a repeated workflow with a clear user command or tool boundary.
8. **Skill or agent guidance** — teach a reusable operating pattern that applies across tasks.

Do not skip to hooks, extensions, or skills unless lower rungs have failed or would force repeated manual work.

### Promotion rules

Promote a lesson only when most of these are true:

- It appeared in at least two tasks, benchmark runs, archive trends, or review findings.
- The future trigger is recognizable before or during similar work.
- The asset will reduce user burden, repeated agent reasoning, or prevent a known class of mistakes.
- The maintenance cost is lower than rediscovering the lesson.
- The change has a focused verification path and a rollback path.
- It preserves safety constraints: no hidden agents, no automatic model switching, no secret capture, and no automatic self-modification.

For a single high-impact safety issue, promotion can happen after one incident if the user approves and the rollback is clear.

### Examples in this Pi config

- **Doc/playbook:** `docs/playbooks/self-improvement.md` keeps the human-gated self-improvement workflow discoverable without adding runtime behavior.
- **Test/regression:** structured verification outcome tests protect the archive format from accidental drift.
- **Benchmark seed:** `agent_benchmark` can compare cheap local config behavior before and after a proposed improvement.
- **Hook/warning:** `overseer` warns about repeated tool failures but remains non-blocking and rate-limited.
- **Extension/tool:** `/propose-improvement` drafts an evidence-based proposal; it does not implement it.
- **Skill/guidance:** `implement-task` requires task-contract audits so repeated misses become visible before completion.

### Finish-phase checklist

Ask these questions before finalizing a task:

1. Did this task reveal a repeated lesson or only local friction?
2. What is the lowest useful rung on the leverage ladder?
3. What evidence proves this is worth maintaining?
4. How will a future agent know when to load or use it?
5. What check proves the asset works?
6. What condition should retire it?
7. Does it preserve human-gated safety and avoid automatic self-editing?

## Constraints

### When not to compound

Prefer no durable change when:

- The issue was a one-off environment glitch, typo, or stale local state.
- The lesson is already obvious in the task result or nearby code.
- A doc addition would duplicate operational task details.
- Automation would require product, architecture, API, schema, auth, persistence, rollout, or privacy decisions the user has not made.
- The proposed asset would run hidden work, mutate prompts/config automatically, or change behavior without explicit user action.
- The maintenance owner is unclear.

### Expiry and rollback

Every promoted asset should have at least one retirement signal:

- A benchmark seed stops catching useful regressions.
- A warning fires too often without action or never fires over several relevant tasks.
- A playbook section becomes duplicated by stronger project guidance.
- A hook or extension creates more friction than it removes.
- A skill or prompt rule becomes too broad to apply safely.

Rollback should be boring: remove the doc section, delete the seed, disable the warning, revert the hook, or restore the previous command behavior.

## Gotchas

- This is not a new autonomous system: no hidden agents, no automatic prompt/config/model changes, and no self-editing without explicit approval.
- Weak checklist answers mean “record the task result and stop,” not “write a playbook anyway.”
- Compound engineering should reduce future work, not create a documentation or tooling tax.
