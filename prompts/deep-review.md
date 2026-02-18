---
description: Scout the code, then have the oracle deeply review it
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "scout" agent to find all code relevant to: $@
2. Then, use the "oracle" agent to deeply analyze the code from the previous step, looking for bugs, edge cases, and improvements (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}.
