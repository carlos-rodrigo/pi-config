# workflow-modes

Switch between agent modes (smart/deep/fast) with commands or keyboard shortcut.

## Install

```bash
pi install ./extensions/workflow-modes
```

## What it adds

| Feature | Description |
|---------|-------------|
| `/smart`, `/deep`, `/fast` | Switch to a specific mode |
| `/mode <name>` | Switch mode by name (accepts aliases) |
| `Ctrl+Shift+M` | Cycle through modes: smart → deep → fast → smart |
| `--workflow-mode <name>` | Start Pi in a specific mode without colliding with Pi’s built-in `--mode` flag |

## Modes

| Mode | Thinking | Use case |
|------|----------|----------|
| **smart** | high | Default — balanced quality and speed |
| **deep** | xhigh | Complex reasoning, architecture, debugging |
| **fast** | low | Quick tasks, simple edits |

Deep mode prefers `openai-codex/gpt-5.5`, then falls back to `gpt-5.4` and `gpt-5.3-codex` if needed.

Startup note: if you launch Pi with an explicit model/thinking selection (`--model`, `--models`, or `--thinking`), workflow-modes now preserves that choice unless you also pass `--workflow-mode`.
