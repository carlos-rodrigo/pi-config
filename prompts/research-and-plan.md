---
description: Research the state of the art, then plan the implementation
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "researcher" agent to investigate the state of the art, best approaches, and relevant library code for: $@
2. Then, use the "oracle" agent to synthesize the research into a concrete implementation recommendation for our codebase (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}.
