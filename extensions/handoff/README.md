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

When the tool is used, Pi automatically creates the new session after the current turn finishes.

### Session query helper

Handoff prompts include parent-session references. Use the `session_query` tool to inspect a previous session without reloading its whole transcript into context:

```
session_query({
  sessionPath: "/full/path/to/session.jsonl",
  question: "Which files changed and why?"
})
```

## How it works

1. Gathers conversation history from the current session
2. Sends it to the current model with your goal to generate a focused context-transfer prompt
3. Wraps the prompt with parent-session references so the next session can use `session_query` when needed
4. For `/handoff`: creates a new session via Pi's supported command flow, then leaves the prompt in the editor
5. For the `handoff` tool: auto-switches to a fresh session after the current turn ends, then leaves the prompt in the editor
6. Press Enter to submit the generated prompt in the new session
