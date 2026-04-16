---
description: Have the oracle deeply review code in a given area
---
Use the subagent tool to invoke the "oracle" agent with this task:

Deeply analyze all code relevant to: $@

Look for bugs, edge cases, architecture issues, and improvements.

Require this output contract:
1. Decision
2. Analysis
3. Top 3 Risks / Edge Cases
4. Recommended Changes (label each item Must-fix or Optional; include prior-art files; include file paths / line ranges when possible)
5. Verification Plan
6. Documentation Destination (architecture / operations / engineering standards / domain)
