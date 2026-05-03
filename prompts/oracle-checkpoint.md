---
description: Run a researcher → oracle checkpoint for high-uncertainty decisions
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "researcher" agent to gather a concise, evidence-first brief of options, constraints, and prior art for: $@. Require targeted tool calls only, at most 8 sources, no long code blocks, and a maximum of 900 words.
2. Then, use the "oracle" agent to choose/critique the best path using {previous}

In step 2, require the oracle to inspect any relevant local repo files before answering, keep the feedback evidence-first, repo-specific, and concise by default, and separate confirmed findings from hypotheses.
If the decision involves an interactive/TUI/editor flow, require explicit feedback on interaction model, focus transitions, selection visibility, perceived latency, and terminal key reliability/fallbacks.

In step 2, require this output contract:
1. Decision
2. Analysis
3. Top 3 Risks / Edge Cases
4. Recommended Changes (label each item Must-fix or Optional; include prior-art files; include file paths / line ranges when possible)
5. Verification Plan
6. Documentation Destination (architecture / operations / engineering standards / domain / none)

Execute as a chain and pass step 1 output into step 2 via {previous}.
