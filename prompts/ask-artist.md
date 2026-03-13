---
description: Delegate a frontend UI/UX implementation task to the artist sub-agent
---
Use the subagent tool to invoke the "artist" agent with this task:

<task>
$@
</task>

<execution_contract>
- Research the codebase first: existing design system, tokens, components, patterns.
- Choose a bold, intentional design direction before writing code.
- Implement working, production-grade code, not descriptions or mockups.
- Pass the AI Slop Test: if it looks like generic AI output, redesign.
- Self-critique before finishing: hierarchy, states, responsive, accessibility.
- Do not commit or push unless explicitly requested.
</execution_contract>

<output_contract>
Return exactly these sections:
## Design Direction
## Changes
## Design Decisions
## Verification
## Notes
</output_contract>

Artist model: `claude-opus-4-6`.
