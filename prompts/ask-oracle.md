---
description: Ask the oracle for a second opinion on complex problems
---
Use the subagent tool to invoke the "oracle" agent with this task:

$@

Before answering, inspect the relevant local repo files and keep the feedback evidence-first, repo-specific, action-oriented, and concise by default.
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
