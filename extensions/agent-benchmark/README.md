# agent-benchmark

Cheap local benchmark runner for Pi config self-improvement.

## Commands

```bash
/bench list
/bench run
/bench run smoke
/bench run harness scenario
/bench run extension-inventory verify-smoke
/bench compare
```

`/bench list` groups benchmarks by tier:

- `smoke` — cheapest readiness checks.
- `harness` — local checks for Pi config/harness surfaces.
- `scenario` — deterministic workflow-shaped checks.
- `regression` — file-defined past-failure seeds.

Results are written to:

```text
.pi/self-improvement/benchmarks/*.json
```

Each result records the selected tiers and each case's tier.

## Regression seeds

Regression seeds are optional JSON files in:

```text
.pi/self-improvement/benchmark-regressions/*.json
```

Example:

```json
{
  "schemaVersion": 1,
  "id": "stale-active-board",
  "description": "A prior loop missed a stale _active.md board.",
  "source": "loop artifact or task result reference",
  "expected": "Represent the past failure as benchmark metadata without launching an agent."
}
```

A regression seed benchmark validates and reports the seed metadata only. It does not replay nested Pi sessions or launch hidden agents.

## Tool

- `agent_benchmark` — list, run, or compare local benchmark results. Pass tier names or benchmark ids in `ids` for `action: "run"`.

## Scope

This slice is intentionally local and cheap. It does not launch hidden background agents. Agent-backed benchmark runs should be added later behind an explicit user command/flag.
