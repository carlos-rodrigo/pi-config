# auto-prompt

Inline ghost text prompt suggestions — like fish shell autosuggestion but for your next prompt.

## Install

```bash
pi install ./extensions/auto-prompt
```

> **Note:** Most useful together with [bordered-editor](../bordered-editor/) which handles the ghost text rendering.

## Preview

After the agent finishes responding, a gray suggestion appears inside the editor:

```
╭──────────────────────────── claude-opus-4-6 · xhigh ─────────╮
│   ▌Implement the error handling changes from the design       │
╰─ 42% of 200k · $1.14 ──────────────── ~/project (main) ────╯
     ↑                                 ↑
  cursor                        gray ghost text
```

## How it works

1. After `agent_end`, calls an LLM (default GPT-5.6 Terra, fallback GPT-5.4) with the last few messages
2. The LLM returns one short, result-first next-step prompt the user can send to move the work forward
   (it adds only evidence, output requirements, important constraints, and a completion bar that can change the result; AGENTS/system workflow rules remain implied)
3. The suggestion appears as gray ghost text in the editor (rendered by `bordered-editor`)
4. Uses the same API key already configured in pi — no extra setup

The suggestion and `/improve` contracts follow OpenAI's [GPT-5.6 prompting guidance](https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6): define the outcome, available evidence, important constraints, and completion bar while leaving the agent room to choose an efficient path. They also preserve request type and scope, avoid invented context, and ask for the smallest missing fact rather than guessing. `/improve` returns already-effective drafts unchanged.

### Devil's Advocate & E2E Verification

Suggestions follow a proportional "devil's advocate" approach to verification:

- **Outcome first**: State the desired user-visible or system-visible result without prescribing internal steps
- **E2E bias when it matters**: For behavior changes and important work, prefer real boundaries (curl, CLI, UI, persisted data) over only "run tests"
- **Fixtures from reality**: Use supplied or documented inputs instead of agent-generated test data when available
- **Critical boundaries only**: Include constraints that prevent real mistakes, not generic workflow boilerplate
- **Observable success**: Define what would prove the requested result without asking the user to restate baseline agent process
- **Feature-packet aware**: When a `docs/features/<slug>/` packet or `.features/<slug>/tasks/` brief is in the conversation, suggestions can point to the next strategy/design/task/result action for the file-based packet flow
- **Archive-aware**: When `self-improvement-archive` has compact evidence of recent verification gaps or overseer warnings, suggestions can bias toward verification-first next steps without adding another LLM call

This addresses the blind spot problem: when an agent writes code AND writes unit tests, both can share the same misconception.

### Unverified Implementation Detection

The extension detects when the agent just completed an implementation **without mentioning verification**. When this happens:

1. The suggestion is **forced to be a verification prompt** (not more implementation)
2. Suggests E2E verification that hits real boundaries
3. Reminds about the blind spot problem

Example: If the agent says "Done! I've created the webhook handler" without mentioning testing, the suggestion will be something like:

> Verify the webhook handler by curling it with a sample payload from the BitFreighter docs

## Interaction

| Input | What happens |
|-------|-------------|
| **→** (right arrow) | Accept: ghost text becomes real editor text, cursor at end |
| **Any character** | Dismiss ghost, character typed normally |
| **Backspace** | Dismiss ghost |
| **Escape** | Dismiss ghost |
| Type before suggestion arrives | LLM call is cancelled, no ghost shown |
| **Ctrl+Shift+I** | Improve current draft in place while preserving its request type, artifact, scope, explicit values, and facts |

## Commands

| Command | Description |
|---------|-------------|
| `/suggest` | Toggle auto-suggestions on/off |
| `/suggest now` | Manually trigger a suggestion |
| `/suggest model` | Show current suggestion model |
| `/suggest model <provider>/<id>` | Change model (e.g. `/suggest model openai-codex/gpt-5.6-terra`) |
| `/improve [text]` | Improve the current editor text (or explicit text argument) using the same prompt-quality principles |

## Configuration

- **Default model:** `openai-codex/gpt-5.6-terra` with low thinking
- **Fallback model:** `openai-codex/gpt-5.4` with low thinking (if primary unavailable or unsupported)
- State (enabled/disabled, model) persists across session restarts
- Agent mode context (smart/deep2/deep3/fast) is included in the suggestion prompt for relevance:
  - `fast`: GPT-5.5 with thinking off for tiny actions + cheap verification check
  - `smart`: narrow next action + focused check
  - `deep`/`deep2`: clear outcome + relevant constraints + observable success check
  - `deep3`: reproduce/diagnose first, patch only if localized, then focused + regression checks

## Architecture

Two-extension communication via `pi.events`:

- **auto-prompt** — suggestion engine (LLM calls, timing, cancellation)
- **bordered-editor** — ghost text rendering and input handling

Events: `auto-prompt:suggest`, `auto-prompt:clear`, `auto-prompt:accepted`, `auto-prompt:dismissed`
