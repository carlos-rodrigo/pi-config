---
description: Research a technology, codebase, or library via the researcher agent
---
Use the agent_job_start tool to start the "researcher" agent in a detached tmux background job with this task: $@

Set mode="standard" and followUp=true. Do not use the synchronous subagent tool for this prompt.

Ask the researcher for a concise, evidence-first brief: lead with the decision, inspect local repo files first when relevant, use targeted tool calls only, cap normal output at 900 words, cite at most 8 sources, and avoid pasted code blocks unless essential.

After starting the job, stop. The main workflow should continue when the background completion follow-up arrives.
