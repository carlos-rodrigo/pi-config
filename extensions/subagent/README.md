# subagent

Delegate tasks to specialized agents with isolated context windows.

## Install

```bash
pi install ./extensions/subagent
```

## What it adds

| Feature | Description |
|---------|-------------|
| `subagent` tool | LLM-callable tool to spawn sub-agents for focused tasks |

## How it works

Spawns a separate `pi` process for each subagent invocation, giving it an isolated context window. Supports three execution modes:

| Mode | Description |
|------|-------------|
| **single** | Run one agent with one task |
| **parallel** | Run multiple agent+task pairs concurrently |
| **chain** | Run agents sequentially, passing output via `{previous}` placeholder |

## Agent discovery

Agents are discovered from:
- `~/.pi/agent/agents/` (user scope)
- `.pi/agents/` (project scope)

Each agent is a markdown file with optional frontmatter for configuration.
