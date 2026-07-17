# workflow-modes

Switch between four GPT-5.6 Sol modes (fast/smart/deep3/max) with commands or a keyboard shortcut.

## Install

```bash
pi install ./extensions/workflow-modes
```

## What it adds

| Feature | Description |
|---------|-------------|
| `/fast`, `/smart`, `/deep`, `/deep3`, `/max` | Switch to a specific mode/effort (`/deep` aliases to `/deep3`) |
| `/mode <name>` | Switch mode by name (accepts aliases, including `deep`, `deep3`, `maximum`, `rush`) |
| `/mode recommend` | Show an archive-derived mode recommendation without switching automatically |
| `Ctrl+Shift+M` | Cycle through modes: fast → smart → deep3 → max → fast |
| `--workflow-mode <name>` | Start Pi in a specific mode without colliding with Pi’s built-in `--mode` flag |

## Modes

| Mode | Preferred model | Thinking | Use case |
|------|-----------------|----------|----------|
| **fast** | `openai-codex/gpt-5.6-sol` | medium | Default — normal agentic coding with rapid feedback |
| **smart** | `openai-codex/gpt-5.6-sol` | high | Complex debugging, cross-module work, and meaningful trade-offs |
| **deep** / **deep3** | `openai-codex/gpt-5.6-sol` | xhigh | Challenging long-running work, deep review, and high-risk implementation |
| **max** | `openai-codex/gpt-5.6-sol` | max | Exceptional quality-first work requiring maximum exploration and verification |

Every mode uses GPT-5.6 Sol without model fallbacks; only reasoning effort changes. Mode status colors follow the same reasoning palette as the composer: medium blue, high mauve, xhigh pink, and max gold. GPT-5 modes prefer outcome-focused prompts: state the target, what good means, constraints, and how to verify. `/deep` is an alias for `/deep3`. Max remains the explicit maximum-effort mode.

Startup note: if you launch Pi with an explicit model/thinking selection (`--model`, `--models`, or `--thinking`), workflow-modes now preserves that choice unless you also pass `--workflow-mode`.
