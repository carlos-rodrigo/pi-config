# Dumb Zone Detector

Monitors context window usage and triggers Pi compaction before the agent enters the "dumb zone" — where reasoning quality degrades due to context length.

## How it works

**Large context models (Opus 4.6, Sonnet 4.6):**
| Context % | Zone | Footer label | Action |
|-----------|------|--------------|--------|
| 0–20% | Smart | `smart` (green) | None |
| 20%+ | Dumb | `dumb` (red) | Auto-triggers compaction |

**Opus 4.5:**
| Context % | Zone | Footer label | Action |
|-----------|------|--------------|--------|
| 0–40% | Smart | `smart` (green) | None |
| 40%+ | Dumb | `dumb` (red) | Auto-triggers compaction |

**All other models:**
| Context % | Zone | Footer label | Action |
|-----------|------|--------------|--------|
| 0–100% | Smart | `smart` (green) | None |
| >100% | Dumb | `dumb` (red) | Disabled |

The bordered editor appends the single active zone label to the raw usage readout, e.g. `31% of 272k . $3.36 - smart`.

When the agent crosses the threshold, the extension calls `ctx.compact()` with instructions to preserve the active goal, constraints, decisions, files changed, verification state, blockers, and next action.

## Installation

Copy to `~/.pi/agent/extensions/dumb-zone/` or `.pi/extensions/dumb-zone/`.

## Based on

- [Skill Issue: Harness Engineering for Coding Agents](https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents)
- [Chroma Context Rot Research](https://research.trychroma.com/context-rot)
