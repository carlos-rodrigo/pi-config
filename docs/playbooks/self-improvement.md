# Self-Improvement Loop

> When to use: improving this Pi config based on observed failures, verification results, or benchmark evidence.

## Overview

This project uses a **human-gated improvement loop** inspired by self-improving coding-agent research:

```text
use Pi normally
  → archive compact run/verification/warning evidence
  → run cheap local benchmarks when desired
  → draft one evidence-based improvement proposal
  → user approves implementation
  → tests/verify/benchmarks compare the result
```

The loop is quiet by default. It does not secretly edit code, switch models, or launch background agents.

For finish-phase promotion rules, use the companion playbook: [`compound-engineering.md`](compound-engineering.md).

## What runs automatically

While Pi is active:

- `self-improvement-archive` records compact local evidence to `.pi/self-improvement/archive.jsonl`, including capped/redacted replay-lite run steps for `/improve-archive last`.
- `verify` emits structured verification outcomes when its existing `agent_end` verification hook runs.
- `overseer` watches for repeated tool failures or risky large mutations and shows rate-limited warnings.
- `auto-prompt` may include a tiny archive summary in its suggestion prompt.

These hooks are in-process. They run only during an active Pi session.

## What requires explicit user action

These never happen unless invoked:

- Benchmarks: `/bench run`, `/bench run <tier>`, or `agent_benchmark`.
- Improvement proposal: `/propose-improvement`, `/improve-archive proposal`, or `archive_analysis` with `action: proposal`.
- Background agents/loops: `agent_job_start`, `/research-bg`, `/ask-oracle-bg`, `/loop-bg`, etc.
- Mode switching: `/mode fast|smart|deep3|max`; `/mode recommend` only explains a recommendation.

## Commands

```bash
# Inspect evidence
/improve-archive status
/improve-archive last 10     # includes replay-lite steps for newer run records
/improve-archive failures
/improve-archive trends

# Draft a human-gated proposal
/propose-improvement
/improve-archive proposal

# Run/compare cheap local benchmarks
/bench list
/bench run
/bench run smoke
/bench compare

# Ask for mode guidance without switching
/mode recommend

# Check warning-only overseer state
/overseer-status
```

## Tools

- `archive_analysis` — reads archive evidence and can draft a proposal.
- `agent_benchmark` — lists/runs/compares cheap local benchmarks.

## Expected workflow

1. Use Pi normally for several tasks.
2. If something feels slow/flaky/noisy, run:

   ```bash
   /improve-archive failures
   /bench run
   /bench compare
   ```

3. Draft a proposal:

   ```bash
   /propose-improvement
   ```

4. Review the proposal. It should include:
   - evidence,
   - proposed change,
   - a coarse `low|medium|high` scorecard for evidence strength, reproducibility, expected metric, effort, risk, rollback clarity, test coverage, and confidence,
   - Compound engineering answers: lowest useful leverage rung, evidence, verification, retirement signal, and safety check,
   - expected metric,
   - likely files,
   - verification,
   - rollback,
   - safety notes.
5. If you approve, ask Pi to implement that one proposal as a normal task.
6. Run targeted tests and `bash scripts/verify.sh`.
7. Run `/bench run` again and compare.
8. Optional Compound step: if the approved work reveals a repeated lesson, apply [`compound-engineering.md`](compound-engineering.md); otherwise do nothing.

## Compound step

Use compound engineering only when evidence shows a repeated lesson worth preserving. Prefer the lowest useful artifact: task handoff, playbook note, regression check, benchmark seed, warning, extension/tool, then skill guidance.

Do not compound one-off friction, stale local state, or obvious task-specific details. The step must not mutate AGENTS, skills, prompts, models, or extensions automatically; proposals remain human-gated until explicitly approved.

## Data locations

```text
.pi/self-improvement/archive.jsonl                     # compact evidence records, including capped/redacted replay-lite run steps
.pi/self-improvement/benchmarks/*.json                 # local benchmark results
.pi/self-improvement/benchmark-regressions/*.json      # optional past-failure seed metadata
```

`.pi/` is ignored by git.

## Safety constraints

- No automatic code edits.
- No automatic self-modification.
- No hidden benchmark or agent execution.
- No full prompt/session transcript capture by default.
- Proposals are advisory until the user explicitly approves implementation.
- Proposal scorecards are deterministic coarse labels, not model judgments; low evidence/confidence should push the user toward measurement first.
- Overseer is warning-only in the current implementation.

## Gotchas

- New extensions require `/reload` or a new Pi session before they are available.
- Archive evidence starts empty; run a few real tasks and benchmark runs before trusting trends.
- Benchmarks are cheap local config checks, not SWE-Bench-style agent evaluations.
- Benchmark tiers are `smoke`, `harness`, `scenario`, and `regression`; regression seeds represent past failures as metadata and do not launch hidden agents.
- If semantic index status is stale, that is unrelated to this loop unless the proposal touches semantic-search behavior.
