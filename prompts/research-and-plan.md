---
description: Research options, then recommend an implementation for this codebase
---
Use detached background agent jobs for this workflow. Do not use the synchronous subagent tool. Use each agent's defaults for evidence, budgets, and output.

Step 1: use agent_job_start to start the "researcher" agent with mode="standard" and followUp=true.

Task: Gather the options, constraints, and prior art needed to recommend an implementation for: $@

After starting the researcher job, stop.

When the researcher completion follow-up arrives, use agent_job_start to start the "oracle" agent with mode="standard" and followUp=true. Pass the researcher output and the original task into the oracle job. Ask for a concrete implementation recommendation for this codebase, including trade-offs and verification. This is advice only; do not implement changes.

After starting the oracle job, stop. Resume the main workflow when its completion follow-up arrives.
