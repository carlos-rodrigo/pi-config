---
description: Research the state of the art, then plan the implementation
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "researcher" agent to investigate the state of the art and best approaches for: $@
2. Then, use the "librarian" agent to find relevant library code and examples based on the research (use {previous} placeholder)
3. Finally, use the "oracle" agent to synthesize the research and library findings into a concrete implementation recommendation for our codebase (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}.
