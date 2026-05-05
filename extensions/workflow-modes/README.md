# workflow-modes

Switch between agent modes (smart/deep/deep3/fast) with commands or keyboard shortcut.

## Install

```bash
pi install ./extensions/workflow-modes
```

## What it adds

| Feature | Description |
|---------|-------------|
| `/smart`, `/deep`, `/deep2`, `/deep3`, `/fast` | Switch to a specific mode/effort |
| `/mode <name>` | Switch mode by name (accepts aliases, including `deep3`) |
| `Ctrl+Shift+M` | Cycle through modes: smart → deep → fast → smart |
| `--workflow-mode <name>` | Start Pi in a specific mode without colliding with Pi’s built-in `--mode` flag |

## Modes

| Mode | Preferred model | Thinking | Use case |
|------|-----------------|----------|----------|
| **smart** | `openai-codex/gpt-5.5` | low | Default — small/narrow work, repo questions, cheap-to-verify edits |
| **deep** / **deep2** | `openai-codex/gpt-5.5` | medium | Normal deep work: bug fixes, feature work, multi-file edits |
| **deep3** | `openai-codex/gpt-5.5` | xhigh | Hard debugging, broad/high-risk work, maximum quality |
| **fast** | `anthropic/claude-sonnet-4-6` | off | Quick tasks, simple edits |

Deep modes prefer `openai-codex/gpt-5.5`. `/deep` falls back to `gpt-5.4` with high thinking and `gpt-5.3-codex` with xhigh thinking if needed.

Startup note: if you launch Pi with an explicit model/thinking selection (`--model`, `--models`, or `--thinking`), workflow-modes now preserves that choice unless you also pass `--workflow-mode`.
