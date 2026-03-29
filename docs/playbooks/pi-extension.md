# Building Pi Extensions

> When to use: Creating or modifying pi extensions (tools, commands, UI integrations).

## Overview

Pi extensions live in `extensions/{name}/` with an `index.ts` entry point. They register tools, commands, and status providers through the `ctx` API. Extensions coordinate via cross-extension contracts (status lines, footer slots, editor integration).

## Patterns

### Extension registration

```typescript
import { ExtensionContext } from "@anthropic/pi-sdk";

export function activate(ctx: ExtensionContext) {
  ctx.registerTool("my-tool", { /* schema */ }, handler);
  ctx.registerCommand("my-command", handler);
}
```

### Cross-extension status contracts

Extensions publish status via `ctx.setStatus()`. The `bordered-editor` extension uses `pickPrimaryExtensionStatus()` to choose what to display in the footer — it prefers `dumb-zone` status (zone label + cost).

### sendMessage with deliverAs/triggerTurn

Use `ctx.sendMessage(text, { deliverAs: "user", triggerTurn: true })` to inject a message as if the user typed it and trigger an agent response. This is the pattern for tools that need to chain agent actions.

### Session lifecycle events

- `session_start` — fresh session, no prior state
- `session_switch` — user switched to a different session
- `reload` — extension reloaded (hot reload during development)

Handle each appropriately — don't assume fresh state on `reload`.

### Cross-platform external launcher

Keep platform-specific launcher attempts in a shared helper (e.g., `extensions/lib/open-external.ts`). Catch per-attempt execution failures and return a user-runnable fallback command for recovery. For SSH/headless environments, generate manual-open + SSH tunnel instructions in a pure helper so it's testable.

### Theme color tokens

Use pi's theme tokens rather than hardcoded colors. Be aware that not all themes define every token — test against at least the default and one dark theme.

## Constraints

- Extensions must not block the main thread — use async operations
- File paths from users need validation: prefer `fs.promises.lstat()` with explicit `ENOENT` handling and symlink rejection over `existsSync + statSync`
- Treat third-party SVG/HTML output as untrusted — sanitize before DOM insertion

## Gotchas

- `Ctrl+I` collides with `Tab` in terminals (same keycode) — avoid for shortcuts
- In tmux with `extended-keys-format csi-u`, prefer `Ctrl+Shift+<letter>` chords that the parser already handles
- Some `Ctrl+Alt+<letter>` chords are transport- or parser-sensitive in tmux
- When porting tools from other agents (Opencode, Claude Code), copy the public contract (parameter names, defaults, output format) first, then implement the minimal runtime
- Workflow modes (Design vs Implement) differ by model selection and prompt framing, not by blocking file writes — planning artifacts still need file-write tools
