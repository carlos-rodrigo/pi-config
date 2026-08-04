# workflow-modes

Switch between four GPT-5.6 workflow modes (fast/smart/deep/max) with commands or a keyboard shortcut.

## Install

```bash
pi install ./extensions/workflow-modes
```

## What it adds

| Feature | Description |
|---------|-------------|
| `/fast`, `/smart`, `/deep`, `/max` | Switch to a specific mode/effort |
| `/mode <name>` | Switch mode by name (accepts aliases, including `maximum` and `rush`) |
| `/mode recommend` | Show an archive-derived mode recommendation without switching automatically |
| `Ctrl+Shift+M` | Cycle through modes: fast → smart → deep → max → fast |
| `--workflow-mode <name>` | Start Pi in a specific mode without colliding with Pi’s built-in `--mode` flag |

## Modes

| Mode | Preferred model | Thinking | Use case |
|------|-----------------|----------|----------|
| **fast** | `openai-codex/gpt-5.6-luna` | medium | Default — normal agentic coding with rapid feedback |
| **smart** | `openai-codex/gpt-5.6-sol` | medium | Complex debugging, cross-module work, and meaningful trade-offs |
| **deep** | `openai-codex/gpt-5.6-sol` | xhigh | Challenging long-running work, deep review, and high-risk implementation |
| **max** | `openai-codex/gpt-5.6-sol` | max | Exceptional quality-first work requiring maximum exploration and verification |

Fast uses GPT-5.6 Luna; Smart, Deep, and Max use GPT-5.6 Sol. Modes do not fall back when their configured model is unavailable. Mode status colors follow the same reasoning palette as the composer: Fast and Smart medium are blue, Deep xhigh is pink, and Max is gold. GPT-5 modes prefer outcome-focused prompts: state the target, what good means, constraints, and how to verify. Max remains the explicit maximum-effort mode.

Startup note: if you launch Pi with an explicit model/thinking selection (`--model`, `--models`, or `--thinking`), workflow-modes now preserves that choice unless you also pass `--workflow-mode`.
