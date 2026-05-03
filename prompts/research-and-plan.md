---
description: Research the state of the art, then plan the implementation
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "researcher" agent to produce a concise, evidence-first research brief for: $@. Require local repo evidence first when relevant, targeted tool calls only, at most 8 sources, no long code blocks, and a maximum of 900 words.
2. Then, use the "oracle" agent to synthesize the research into a concrete implementation recommendation for our codebase (use {previous} placeholder).

Execute this as a chain, passing output between steps via {previous}.
