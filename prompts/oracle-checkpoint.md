---
description: Run a researcher → oracle checkpoint for high-uncertainty decisions
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "researcher" agent to gather options, constraints, and prior art for: $@
2. Then, use the "oracle" agent to choose/critique the best path using {previous}

In step 2, require this output contract:
1. Decision
2. Analysis
3. Top 3 Risks / Edge Cases
4. Recommended Changes (with file paths / line ranges when possible)
5. Verification Plan
6. Documentation Destination (architecture / operations / engineering standards / domain)

Execute as a chain and pass step 1 output into step 2 via {previous}.
