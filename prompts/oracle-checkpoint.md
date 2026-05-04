---
description: Run a researcher → oracle checkpoint for high-uncertainty decisions
---
Use background tmux agent jobs for this workflow. Do not use the synchronous subagent tool.

Step 1 now: use agent_job_start to start the "researcher" agent with mode="standard" and followUp=true for this task:

Gather a concise, evidence-first brief of options, constraints, and prior art for: $@. Use targeted tool calls only, at most 8 sources, no long code blocks, and a maximum of 900 words.

After starting the researcher job, stop.

When the researcher completion follow-up arrives, start a second background job with agent_job_start for the "oracle" agent, mode="standard", followUp=true. Pass the researcher output into the oracle task and ask it to choose/critique the best path.

In step 2, require the oracle to inspect any relevant local repo files before answering, keep the feedback evidence-first, repo-specific, and concise by default, and separate confirmed findings from hypotheses.
If the decision involves an interactive/TUI/editor flow, require explicit feedback on interaction model, focus transitions, selection visibility, perceived latency, and terminal key reliability/fallbacks.

In step 2, require this output contract:
1. Decision
2. Analysis
3. Top 3 Risks / Edge Cases
4. Recommended Changes (label each item Must-fix or Optional; include prior-art files; include file paths / line ranges when possible)
5. Verification Plan
6. Documentation Destination (architecture / operations / engineering standards / domain / none)
