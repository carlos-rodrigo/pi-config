# workflow-modes

Legacy fixed presets (fast/smart/deep/max), available through commands or a keyboard shortcut.

When [workflow-router](../workflow-router/) is installed, it owns startup and defaults to Astra medium with Luna-low task classification. Selecting a preset locks routing; `/route auto` resumes it. The behavior below describes standalone installation unless noted.

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
| **fast** | `openai-codex/gpt-5.6-luna` | medium | Standalone default — small tasks with rapid feedback |
| **smart** | `openai-codex/gpt-5.6-sol` | medium | Complex debugging, cross-module work, and meaningful trade-offs |
| **deep** | `openai-codex/gpt-6-astra` | xhigh | Challenging long-running work, deep review, and high-risk implementation |
| **max** | `openai-codex/gpt-6-astra` | max | Exceptional quality-first work requiring maximum exploration and verification |

Fast uses GPT-5.6 Luna, Smart uses GPT-5.6 Sol, and Deep/Max use GPT-6 Astra. Astra is reserved for the higher-effort modes because OpenAI reports materially stronger coding and agentic-work results than Sol, including Terminal-Bench 4.0 (57.9% vs 37.3%), internal database migrations (63.9% vs 42.7%), and OSWorld 2.0 completion in about 47% less time. Its API token pricing is higher ($10/$50 per million input/output tokens vs Sol's $4/$20), but OpenAI reports lower estimated cost per task from reduced output-token use. Modes do not fall back when their configured model is unavailable. Mode status colors follow the same reasoning palette as the composer: Fast and Smart medium are blue, Deep xhigh is pink, and Max is gold. Workflow modes prefer outcome-focused prompts: state the target, what good means, constraints, and how to verify. Max remains the explicit maximum-effort mode.

Startup note: if you launch Pi with an explicit model/thinking selection (`--model`, `--models`, or `--thinking`), workflow-modes now preserves that choice unless you also pass `--workflow-mode`.
