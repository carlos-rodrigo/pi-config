# ownership-loop

Always-live ownership behavior for retaining authorship while delegating execution.

Default mode is `passive`: the harness does not block work, but it keeps a change story in view, tracks edits/writes, and queues a re-own comparison after changed work.

## Commands

| Command | Description |
|---------|-------------|
| `/own-mode passive | strict | off` | Configure always-live ownership behavior |
| `/own <task>` | Ask for an approval-gated Initial Change Story before editing |
| `/own-approve` | Mark the current Initial Change Story approved; required before edits in strict mode |
| `/reown [scope]` | Compare the Initial Change Story to the actual git diff and verification evidence |
| `/own-remember [title]` | Draft a semantic-searchable ownership card under `docs/ownership/` |
| `/own-status` | Write current ownership-loop state to the editor |
| `/own-off` | Disable the ownership loop for the session |

## Modes

| Mode | Behavior |
|------|----------|
| `passive` | Default. Injects story-first guidance, tracks `edit`/`write`, and queues `/reown` after changed work. Does not block. |
| `strict` | Same as passive, but blocks `edit`/`write` until an Initial Change Story is approved with `/own-approve`. |
| `off` | Disables ownership guidance, tracking, and re-own follow-ups. |

## Flow

```text
Working Story → Patch → Proof → Re-own Story → Ownership Card
```

For explicit planning:

```text
/own <task> → approve story → /own-approve → implementation → automatic re-own
```

In passive mode you can skip `/own`; edited files still trigger a re-own follow-up. If no Initial Change Story exists, the re-own prompt asks the agent to reconstruct the intended story from the task and diff.

The re-own prompt asks for:

- change story: old flow → new flow
- business/workflow rule now true
- diff map
- intended vs actual comparison
- what is left
- verification evidence, including planned-but-not-run checks
- ownership path through the files/functions

`/own-remember` turns the re-own story into a durable `docs/ownership/*.md` card so semantic search can answer future “how does this work / why is it this way?” questions.

Auto Prompt also reads the ownership state and nudges toward `/reown` when code changed after an ownership story.
