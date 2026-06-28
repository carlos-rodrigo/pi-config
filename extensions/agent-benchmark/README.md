# agent-benchmark

Cheap local benchmark runner for Pi config self-improvement.

## Commands

```bash
/bench list
/bench run
/bench run extension-inventory verify-smoke
/bench compare
```

Results are written to:

```text
.pi/self-improvement/benchmarks/*.json
```

## Tool

- `agent_benchmark` — list, run, or compare local benchmark results.

## Scope

This first slice is intentionally local and cheap. It does not launch hidden background agents. Agent-backed benchmark runs should be added later behind an explicit user command/flag.
