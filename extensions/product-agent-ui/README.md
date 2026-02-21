# product-agent-ui

Terminal-first Product workflow shell for Pi.

It guides work through:

`Plan → Design → Tasks → Implement → Review`

It is file-backed (`.features/{feature}`) and policy-driven (`.pi/product-agent-policy.json` with strict defaults fallback).

## Install

### Option A — from this repo (recommended)

```bash
cd /Users/carlosrodrigo/Developer/pi-config
./install.sh
```

Then run `/reload` in Pi.

### Option B — manual symlink

```bash
mkdir -p ~/.pi/agent/extensions
ln -s /Users/carlosrodrigo/Developer/pi-config/extensions/product-agent-ui ~/.pi/agent/extensions/product-agent-ui
```

Then run `/reload`.

## Commands

| Command | Purpose |
|---|---|
| `/product [feature]` | Open Product Agent shell for a feature |
| `/product-run [feature]` | Start/continue run loop from Implement stage |
| `/product-review [feature]` | Open shell directly in Review stage |

## Shortcuts

- Global: `Ctrl+Alt+W` → open Product Agent UI
- Stage navigation: `←/→` or `h/l`

Stage-specific:

- **Plan / Design / Tasks**
  - `c` compose/refine artifact
  - `a` approve
  - `r` reject
  - `o/d/e` open/diff/edit artifact
- **Tasks**
  - `v` toggle list/board
  - `↑/↓` or `j/k` move task selection
  - `o/d/e` open/diff/edit selected task
  - `O/D/E` open/diff/edit stage artifact
- **Implement**
  - `c` continue run loop
  - `p` pause
  - `r` request changes
- **Review**
  - `↑/↓` or `j/k` move file selection
  - `o/d/e` open/diff/edit selected changed file

## Policy config

Path: `.pi/product-agent-policy.json`

If file is missing/invalid, extension falls back to strict built-in defaults and shows a warning.

### Schema

```json
{
  "version": 1,
  "mode": "strict",
  "gates": {
    "planApprovalRequired": true,
    "designApprovalRequired": true,
    "tasksApprovalRequired": true,
    "reviewRequired": true
  },
  "execution": {
    "autoRunLoop": true,
    "stopOnFailedChecks": true,
    "stopOnUncertainty": true,
    "maxConsecutiveTasks": 3
  }
}
```

`maxConsecutiveTasks` is optional and must be an integer `>= 1` when present.

## Required feature files

For feature `product-agent-ui`, expected structure:

```text
.features/product-agent-ui/
  prd.md
  design.md
  tasks/
    _active.md
    001-*.md
    ...
```

## Notes

- Review file actions reuse the existing `/open` extension flow.
- If Pi is currently streaming, open/diff/edit actions are queued as follow-up dispatch.
- nvim edit requires tmux (same behavior as `file-opener`).

## QA / limitations

See:

- `extensions/product-agent-ui/QA.md`
