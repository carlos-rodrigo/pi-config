# handoff

Transfer context to a new focused session via `/handoff` command.

## Install

```bash
pi install ./extensions/handoff
```

## What it does

Instead of compacting (which is lossy), handoff extracts what matters for your next task and creates a new session with a generated prompt.

## Usage

```text
/handoff now implement this for teams as well
/handoff execute phase one of the plan
/handoff check other places that need this fix
```

## How it works

1. Gathers conversation history from the current session
2. Sends it to the current model with your goal to generate a focused context-transfer prompt
3. Opens an editor so you can review/edit the generated prompt
4. Creates a new session with the prompt ready to submit

## Related

See [agent-handoff](../agent-handoff/) for the LLM-callable tool version (used by autonomous skills like the loop).
