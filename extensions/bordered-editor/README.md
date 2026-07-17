# bordered-editor

Replaces Pi's default input editor with a bordered version that embeds status information directly into the box borders.

## Install

```bash
pi install ./extensions/bordered-editor
```

## Preview

```text
╭─ mode:smart ───────────────────── Claude 4 Opus · high ─╮
│   your prompt here                                       │
╰─ 42% of 200k · 1.3M burned · $1.14 ─ ~/project (main) ─╯
```

## What the composer shows

### Top border

- **Left — `mode:fast`:** the active workflow mode, bold and colored by reasoning effort: Fast/medium is blue, Smart/high is mauve, Deep³/xhigh is pink, and Max is gold. The composer border uses the same color. The label is omitted when no workflow mode is available.
- **Right — `Claude 4 Opus · high`:** the active model in muted text and the thinking level in bold using its matching reasoning color.

### Inside the box

- Your current prompt, with two spaces of horizontal padding.
- When the editor is empty, Auto Prompt can show a gray suggested prompt. Press **Right Arrow** to accept it. Any other input dismisses it; printable input then continues normally.
- Autocomplete results appear below the bordered box rather than inside it.

### Bottom border

- **`42% of 200k`:** how much of the model's context window the current conversation occupies.
- **`1.3M burned`:** cumulative tokens processed by assistant messages in the current session branch, including input, output, cache reads, and cache writes.
- **`$1.14`:** cumulative assistant cost for the current session branch.
- **Extension status:** when present, one active status follows the cost, for example `Improving prompt…`, `reviewing`, `queue: 2 queued`, or an Agent Memory status. Failures and active work take priority over ambient statuses.
- **Activity:** semantic-index rebuild progress and the number of running background agent jobs appear in the accent color before the path, for example `idx: embedding 60% · ~11s · 2 bg jobs`.
- **`~/project`:** the current working directory, shortened with `~` when it is under the home directory and rendered as muted metadata.
- **`(main)`:** the current branch in the accent color in a normal checkout. Linked worktrees instead show `[WT <worktree> · <branch>]`.

Labels may be truncated or omitted when the terminal is too narrow.

## How it works

- Extends `CustomEditor` from `@mariozechner/pi-coding-agent` and overrides `render()` to wrap the default editor output with rounded box-drawing characters (`╭`, `╮`, `│`, `╰`, `╯`).
- Calls `super.render(width - 2)` to reserve space for side borders, then post-processes each line.
- Reads live data from the extension context: `ctx.getContextUsage()`, `ctx.model`, `ctx.sessionManager.getBranch()` (for cost), and `footerData.getGitBranch()`.
- Replaces the default footer with an empty one since all footer info is embedded in the editor borders.
- Border and mode-label colors follow the current thinking level (same as Pi's default behavior). Terminals do not support real CSS-like glow or shadow effects, so bold labels and the matching colored border provide the emphasis without reducing legibility.
- Internal padding is set to `paddingX: 2` for extra breathing room.
