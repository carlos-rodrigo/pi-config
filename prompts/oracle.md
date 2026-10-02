---
description: Ask the oracle for a second opinion on complex problems
---
Use agent_job_start to start the "oracle" agent in a detached background job with mode="standard" and followUp=true. Do not use the synchronous subagent tool.

Task: $@

Use the agent's defaults for evidence, review policy, and output.

After starting the job, stop. Resume the main workflow when the completion follow-up arrives.
