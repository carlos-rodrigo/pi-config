# handoff

Transfer context to a new focused session — via `/handoff` command or the LLM-callable `handoff` tool.

## Install

```bash
pi install ./extensions/handoff
```

## What it does

Instead of compacting (which is lossy), handoff extracts what matters for your next task and creates a new session with a generated prompt.

## Usage

### User command

```text
/handoff now implement this for teams as well
/handoff execute phase one of the plan
/handoff check other places that need this fix
```

### Agent tool

The agent can call the `handoff` tool directly for autonomous session transfer (e.g., from the loop skill):

```
handoff({ goal: "Continue implementing phase 2 of the auth refactor" })
```

## How it works

1. Gathers conversation history from the current session
2. Sends it to the current model with your goal to generate a focused context-transfer prompt
3. For the command: opens an editor so you can review/edit the generated prompt
4. Creates a new session with the prompt ready to submit
