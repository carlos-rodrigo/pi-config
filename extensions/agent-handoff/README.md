# agent-handoff

LLM-callable handoff tool — lets the agent programmatically transfer context to a new session.

## Install

```bash
pi install ./extensions/agent-handoff
```

## What it does

The `/handoff` command (from the [handoff](../handoff/) extension) is user-typed. This extension registers a `handoff` tool the LLM can call directly, enabling autonomous handoff from skills like the loop skill.

## How it works

1. Agent calls the `handoff` tool with a goal describing what the next session should do
2. Tool gathers conversation history, generates a focused prompt via LLM
3. Tool queues a follow-up command to create a new session
4. New session opens with the generated prompt in the editor, ready to submit

## Related

See [handoff](../handoff/) for the user-facing `/handoff` command.
