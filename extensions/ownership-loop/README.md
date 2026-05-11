# ownership-loop

Always-live ownership behavior for retaining authorship while delegating execution.

Default mode is `passive`: the harness does not block work. It keeps lightweight ownership guidance available and tracks `edit`/`write` silently instead of injecting a follow-up or composer/status-bar text.

## Commands

| Command | Description |
|---------|-------------|
| `/own-mode passive \| strict \| off` | Configure always-live ownership behavior |
| `/own <task>` | Ask for an approval-gated Initial Change Story before editing |
| `/own-approve` | Mark the current Initial Change Story approved; required before edits in strict mode |
| `/reown [scope]` or `/re-own [scope]` | Explain/compare the completed change against the Initial Change Story and actual diff |
| `/reown --remember [scope] [title: <title>]` | Re-own the change and write/update a searchable `docs/ownership/*.md` card in the same turn |
| `/own-remember [title]` | Draft a semantic-searchable ownership-card prompt under `docs/ownership/` |
| `/own-status` | Write current ownership-loop state to the editor |
| `/own-off` | Disable the ownership loop for the session |

## Modes

| Mode | Behavior |
|------|----------|
| `passive` | Default. Injects lightweight ownership guidance and tracks `edit`/`write` silently. Does not block, auto-follow-up, or write composer/status-bar text. |
| `strict` | Same as passive, but blocks `edit`/`write` until an Initial Change Story is approved with `/own-approve`. |
| `off` | Disables ownership guidance and tracking. |

## Flow

```text
ask → patch → proof → optional /reown → optional /reown --remember → future recall
```

For explicit planning:

```text
/own <task> → approve story → /own-approve → implementation → optional /reown
```

In passive mode you can skip `/own`; edited files are tracked for an explicit `/reown`. If no Initial Change Story exists, `/reown` asks the agent to reconstruct the intended story from the task and diff.

The `/reown` prompt asks for:

- change story: old flow → new flow
- business/workflow rule now true
- diff map
- intended vs actual comparison
- what is left
- verification evidence, including planned-but-not-run checks
- ownership path through the files/functions

`/reown --remember` adds one action: after the re-own analysis, write/update the ownership card directly. It does not ask for `save it` / `skip`.

For future recall questions, ownership guidance tells the agent to search `docs/ownership/` first, then inspect code if needed.

Auto Prompt reads ownership state but treats re-own as optional: it may surface `/reown` or `/reown --remember` only when that matches the user's next intent.
