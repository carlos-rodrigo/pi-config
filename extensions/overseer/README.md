# overseer

Warning-only event watchdog inspired by the SICA overseer pattern.

## What it does

While Pi is active, it watches for:

- repeated identical tool errors
- very large `write` or `edit` mutations that may deserve a focused edit instead

Warnings are rate-limited per session and emitted through Pi notifications plus the self-improvement archive event bus. This first slice never blocks tools, cancels agents, or modifies prompts.

## Command

```bash
/overseer-status
```

Shows how many warnings were emitted in the current session.
