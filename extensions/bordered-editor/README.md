# bordered-editor

Replaces Pi's default input editor with a bordered version that keeps operational and project context in the box borders. Model, effort, and routing state are deliberately left to the response timeline.

## Install

```bash
pi install ./extensions/bordered-editor
```

## Preview

```text
╭──────────────────────────────────────────────────────────╮
│   your prompt here                                       │
╰─ 42% of 200k · 1.3M burned · $1.14 ─ ~/project (main) ─╯
```

## What the composer shows

### Top border

The top border is intentionally neutral and unlabeled. The response timeline owns model, effort, and routing state because those values describe a response, not a draft prompt.

### Inside the box

- Your current prompt, with two spaces of horizontal padding.
- When the editor is empty, Auto Prompt can show a gray suggested prompt. Press **Right Arrow** to accept it. Any other input dismisses it; printable input then continues normally.
- Autocomplete results appear below the bordered box rather than inside it.

### Bottom border

- **`42% of 200k`:** how much of the model's context window the current conversation occupies.
- **`1.3M burned`:** cumulative tokens processed by assistant messages in the current session branch, including input, output, cache reads, and cache writes.
- **`$1.14`:** cumulative assistant cost for the current session branch.
- **Extension status:** when present, one active status follows the cost, for example `Improving prompt…`, `reviewing`, `queue: 2 queued`, classifier progress, or an Agent Memory status. Failures and active work take priority. Ambient routing metadata is excluded because it appears in the response timeline.
- **Activity:** semantic-index rebuild progress and the number of running background agent jobs appear in the accent color before the path, for example `idx: embedding 60% · ~11s · 2 bg jobs`.
- **`~/project`:** the current working directory, shortened with `~` when it is under the home directory and rendered as muted metadata.
- **`(main)`:** the current branch in the accent color in a normal checkout. Linked worktrees instead show `[WT <worktree> · <branch>]`.

Labels may be truncated or omitted when the terminal is too narrow.

## How it works

- Extends `CustomEditor` from `@earendil-works/pi-coding-agent` and overrides `render()` to wrap the default editor output with rounded box-drawing characters (`╭`, `╮`, `│`, `╰`, `╯`).
- Calls `super.render(width - 2)` to reserve space for side borders, then post-processes each line.
- Reads live data from the extension context: `ctx.getContextUsage()`, `ctx.sessionManager.getBranch()` (for cost), and `footerData.getGitBranch()`.
- Replaces the default footer with an empty one since all footer info is embedded in the editor borders.
- Uses Pi's neutral border theme token so the composer does not imply a routing mode.
- Internal padding is set to `paddingX: 2` for extra breathing room.
