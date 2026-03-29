# Dumb Zone Detector

Monitors context window usage and forces a session handoff before the agent enters the "dumb zone" — where reasoning quality degrades due to context length.

## How it works

| Context % | Zone | Footer label | Action |
|-----------|------|--------------|--------|
| 0–30% | Smart | `smart` (green) | None |
| 30–45% | Caution | `caution` (orange) | User can `/handoff` manually |
| 45%+ | Dumb | `dumb` (red) | Auto-triggers handoff |

The bordered editor appends the single active zone label to the raw usage readout, e.g. `31% of 272k . $3.36 - smart`.

When the agent crosses 45%, a follow-up message is injected that forces the agent to:
1. Summarize progress, decisions, and remaining work
2. Call the `handoff` tool to transfer to a fresh session
3. Stop working in the current (degraded) session

## Dependencies

Requires the `handoff` extension (provides both the `/handoff` command and the `handoff` tool).

## Installation

Copy to `~/.pi/agent/extensions/dumb-zone/` or `.pi/extensions/dumb-zone/`.

## Based on

- [Skill Issue: Harness Engineering for Coding Agents](https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents)
- [Chroma Context Rot Research](https://research.trychroma.com/context-rot)
