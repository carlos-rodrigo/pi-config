---
description: Research a technology, codebase, or library via the researcher agent
---
Use agent_job_start to start the "researcher" agent in a detached background job with mode="standard" and followUp=true. Do not use the synchronous subagent tool.

Task: $@

Use the agent's defaults for evidence, tool budgets, and output.

After starting the job, stop. Resume the main workflow when the completion follow-up arrives.
