# Building Pi Extensions

> When to use: Creating or modifying pi extensions (tools, commands, UI integrations).

## Overview

Pi extensions live in `extensions/{name}/` with an `index.ts` entry point. They register tools, commands, and status providers through the `ctx` API. Extensions coordinate via cross-extension contracts (status lines, footer slots, editor integration).

## Patterns

### Extension registration

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function activate(pi: ExtensionAPI) {
  pi.registerTool({
    name: "my_tool",
    label: "My Tool",
    description: "Describe the tool contract",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "Done" }], details: {} };
    },
  });
  pi.registerCommand("my-command", { description: "Run my command", handler: async () => {} });
}
```

### Cross-extension status contracts

Extensions publish status via `ctx.ui.setStatus()`. The `bordered-editor` extension uses `pickPrimaryExtensionStatus()` to choose what to display in the footer — active overlays and workflow helpers should expose concise status strings.

### sendMessage with deliverAs/triggerTurn

Use `pi.sendUserMessage(text, { deliverAs: "followUp" })` to inject a user message and queue another turn. Use `pi.sendMessage()` for custom extension messages.

### Session lifecycle events

- `session_start` — startup, reload, new, resume, or fork; inspect `event.reason`
- `session_shutdown` — quit, reload, new, resume, or fork; close session-scoped resources here
- `resources_discover` — startup or reload resource contribution

Do not start long-lived processes, watchers, sockets, or timers in the extension factory. Rebuild state in `session_start` and clean it up idempotently in `session_shutdown`.

### Cross-platform external launcher

Keep platform-specific launcher attempts in a shared helper (e.g., `extensions/lib/open-external.ts`). Catch per-attempt execution failures and return a user-runnable fallback command for recovery. For SSH/headless environments, generate manual-open + SSH tunnel instructions in a pure helper so it's testable.

### Theme color tokens

Use pi's theme tokens rather than hardcoded colors. Be aware that not all themes define every token — test against at least the default and one dark theme.

## Constraints

- Extensions must not block the main thread — use async operations and honor tool `AbortSignal`s
- Throw from tool `execute()` to report failure; returning `isError: true` does not mark a tool result as failed
- Guard `ctx.ui.custom()` and terminal components with `ctx.mode === "tui"`; `ctx.hasUI` is also true in RPC mode
- Check `pi.exec()` result codes; nonzero exits are returned rather than thrown
- File paths from users need validation: prefer `fs.promises.lstat()` with explicit `ENOENT` handling and symlink rejection over `existsSync + statSync`
- Treat third-party SVG/HTML output as untrusted — sanitize before DOM insertion

## Gotchas

- `Ctrl+I` collides with `Tab` in terminals (same keycode) — avoid for shortcuts
- In tmux with `extended-keys-format csi-u`, prefer `Ctrl+Shift+<letter>` chords that the parser already handles
- Some `Ctrl+Alt+<letter>` chords are transport- or parser-sensitive in tmux
- When porting tools from other agents (Opencode, Claude Code), copy the public contract (parameter names, defaults, output format) first, then implement the minimal runtime
- Workflow modes (Design vs Implement) differ by model selection and prompt framing, not by blocking file writes — planning artifacts still need file-write tools
