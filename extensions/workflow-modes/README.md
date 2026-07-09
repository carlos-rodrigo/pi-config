# workflow-modes

Switch between agent modes (smart/deep2/deep3/fast) with commands or keyboard shortcut.

## Install

```bash
pi install ./extensions/workflow-modes
```

## What it adds

| Feature | Description |
|---------|-------------|
| `/smart`, `/deep`, `/deep2`, `/deep3`, `/fast` | Switch to a specific mode/effort (`/deep` aliases to `/deep2`) |
| `/mode <name>` | Switch mode by name (accepts aliases, including `deep2`, `deep3`, `rush`) |
| `/mode recommend` | Show an archive-derived mode recommendation without switching automatically |
| `Ctrl+Shift+M` | Cycle through modes: smart → fast → deep2 → deep3 → smart |
| `--workflow-mode <name>` | Start Pi in a specific mode without colliding with Pi’s built-in `--mode` flag |

## Modes

| Mode | Preferred model | Thinking | Use case |
|------|-----------------|----------|----------|
| **smart** | `anthropic/claude-fable-5` | low | Default — small/narrow work, repo questions, cheap-to-verify edits |
| **deep** / **deep2** | `openai-codex/gpt-5.6-sol` | medium | Normal deep work: bug fixes, feature work, multi-file edits |
| **deep3** | `openai-codex/gpt-5.6-sol` | xhigh | Hard debugging, broad/high-risk work, maximum quality |
| **fast** | `openai-codex/gpt-5.5` | off | No-thinking GPT-5.5 for quick tasks and simple edits |

GPT-5 modes prefer outcome-focused prompts: state the target, what good means, constraints, and how to verify. `/deep` is the same as `/deep2`; deep modes prefer `gpt-5.6-sol` and fall back to `gpt-5.5`, `gpt-5.4`, and `gpt-5.3-codex` if needed. `/fast` is GPT-5.5 with thinking off for quick, cheap-to-verify work.

Startup note: if you launch Pi with an explicit model/thinking selection (`--model`, `--models`, or `--thinking`), workflow-modes now preserves that choice unless you also pass `--workflow-mode`.
