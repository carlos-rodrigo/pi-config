---
description: Concise Oracle review of current work
---

Use the subagent tool to invoke the "oracle" agent with this task:

Review the current work relevant to: $@

Inspect the relevant local repo files before answering.
Look for bugs, edge cases, architecture issues, and improvements.
Keep the feedback evidence-first, repo-specific, action-oriented, and concise by default. Separate confirmed findings from hypotheses and prefer the smallest repo-consistent recommendation.
If the area includes an interactive/TUI/editor flow, explicitly review the interaction model, focus transitions, selection visibility, perceived latency, and terminal key reliability/fallbacks.

Scope:
- Review only changed files / diff and directly related code needed to validate correctness.
- Do not summarize the implementation.
- Do not list positives.
- Do not provide broad architecture commentary unless it is a concrete blocker.
- Prefer must-fix issues over optional improvements.
- Return at most 5 findings.
- If there are more than 5 issues, return only the highest-risk ones.
- If no must-fix issues exist, say so directly.

Require this output contract:
1. Decision
2. Analysis
3. Top 3 Risks / Edge Cases
4. Recommended Changes (label each item Must-fix or Optional; include prior-art files; include file paths / line ranges when possible)
5. Verification Plan
6. Documentation Destination (architecture / operations / engineering standards / domain / none)

Hard limits:
- Maximum 800 words.
- No long explanations.
- No pasted code blocks unless essential.
