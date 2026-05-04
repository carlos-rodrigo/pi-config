---
description: Ask the oracle for a second opinion on complex problems
---
Use the agent_job_start tool to start the "oracle" agent in a detached tmux background job with this task:

$@

Set mode="standard" and followUp=true. Do not use the synchronous subagent tool for this prompt.

Before answering, the oracle must inspect the relevant local repo files and keep the feedback evidence-first, repo-specific, action-oriented, and concise by default.
Require the oracle to cite concrete file paths / line ranges when possible, separate confirmed issues from hypotheses, prefer the smallest repo-consistent recommendation, and lead with a short verdict.
If the question is about an interactive/TUI/editor flow, require explicit feedback on interaction model, focus transitions, selection visibility, perceived latency, and terminal key reliability/fallbacks.

Require this output contract:
1. Decision
2. Analysis
3. Top 3 Risks / Edge Cases
4. Recommended Changes (label each item Must-fix or Optional; include prior-art files; include file paths / line ranges when possible)
5. Verification Plan
6. Documentation Destination (architecture / operations / engineering standards / domain / none)

Use oracle for complex debugging, architecture decisions, logic verification, or high-risk review.

After starting the job, stop. The main workflow should continue when the background completion follow-up arrives.
