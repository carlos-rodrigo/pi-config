---
description: Delegate an implementation task to the crafter sub-agent
---
Use the subagent tool to invoke the "crafter" agent with this task:

<task>
$@
</task>

<execution_contract>
- Execute end-to-end when feasible: context, implementation, verification, outcome.
- If the task references `.features/*/tasks/*`, run Context → Code → Review → Compound.
- Read files before editing, keep changes minimal, and reuse existing patterns.
- Prefer test-first for behavior changes and run verification commands before finishing.
- Do not commit or push unless explicitly requested.
</execution_contract>

<output_contract>
Return exactly these sections:
## Plan
## Changes
## Verification
## Notes
</output_contract>

Crafter model: `openai-codex/gpt-5.4`.
