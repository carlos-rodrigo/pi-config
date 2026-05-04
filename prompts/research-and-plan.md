---
description: Research the state of the art, then plan the implementation
---
Use background tmux agent jobs for this workflow. Do not use the synchronous subagent tool.

Step 1 now: use agent_job_start to start the "researcher" agent with mode="standard" and followUp=true for this task:

Produce a concise, evidence-first research brief for: $@. Require local repo evidence first when relevant, targeted tool calls only, at most 8 sources, no long code blocks, and a maximum of 900 words.

After starting the researcher job, stop.

When the researcher completion follow-up arrives, start a second background job with agent_job_start for the "oracle" agent, mode="standard", followUp=true. Pass the researcher output into the oracle task and ask it to synthesize the research into a concrete implementation recommendation for our codebase.
