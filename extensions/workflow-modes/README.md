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

## Modes

| Mode | Thinking | Use case |
|------|----------|----------|
| **smart** | high | Default — balanced quality and speed |
| **deep** | xhigh | Complex reasoning, architecture, debugging |
| **fast** | low | Quick tasks, simple edits |
