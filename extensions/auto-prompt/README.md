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

1. After `agent_end`, calls an LLM (default GPT-5.1 Codex Mini, fallback GPT-5.3 Codex Spark) with the last few messages
2. The LLM returns one short suggested next-step prompt the user can send to move the work forward
   (it treats AGENTS/system workflow rules as baseline context, so suggestions focus on concrete next-step deltas instead of repeating generic process reminders)
3. The suggestion appears as gray ghost text in the editor (rendered by `bordered-editor`)
4. Uses the same API key already configured in pi — no extra setup

### Devil's Advocate & E2E Verification

Suggestions follow a "devil's advocate" approach to verification:

- **E2E bias**: Prefer verification that hits real boundaries (curl the endpoint, run CLI with real input) over just "run tests"
- **Fixtures from reality**: Suggest using real inputs from docs/API samples, not agent-generated test data
- **Challenge the implementation**: Verification should prove the code works to someone who didn't write it

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
| **Ctrl+Shift+I** | Improve current draft prompt in-place (directive + specific + feedback-loopable rewrite) |

## Commands

| Command | Description |
|---------|-------------|
| `/suggest` | Toggle auto-suggestions on/off |
| `/suggest now` | Manually trigger a suggestion |
| `/suggest model` | Show current suggestion model |
| `/suggest model <provider>/<id>` | Change model (e.g. `/suggest model openai-codex/gpt-5.1-codex-mini`) |
| `/improve [text]` | Improve the current editor text (or explicit text argument) using the same prompt-quality principles |

## Configuration

- **Default model:** `openai-codex/gpt-5.1-codex-mini`
- **Fallback model:** `openai-codex/gpt-5.3-codex-spark` (if primary unavailable)
- State (enabled/disabled, model) persists across session restarts
- Agent mode context (smart/deep/fast) is included in the suggestion prompt for relevance

## Architecture

Two-extension communication via `pi.events`:

- **auto-prompt** — suggestion engine (LLM calls, timing, cancellation)
- **bordered-editor** — ghost text rendering and input handling

Events: `auto-prompt:suggest`, `auto-prompt:clear`, `auto-prompt:accepted`, `auto-prompt:dismissed`
