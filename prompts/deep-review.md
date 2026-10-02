---
description: Review current changes with the Oracle's five-topic quality validation
---
Use agent_job_start to start the "oracle" agent in a detached background job with mode="review" and followUp=true. Do not use the synchronous subagent tool.

Task: Review the current work relevant to: $@

Read the launcher-generated review-context.md first. Use the agent's review defaults, including the five focused child reviews and the Are You Proud output contract.

Scope and output overrides:
- Review only changed files / diff and directly related code needed to validate correctness.
- Do not summarize the implementation or list generic positives; retain the verdict and quality checks required by the review contract.
- Include broader architecture findings only when they are concrete blockers.
- Return at most 5 findings, highest-risk first. If no must-fix issues exist, say so directly.
- Maximum 800 words. No pasted code blocks unless essential.

After starting the job, stop. Resume the main workflow when the completion follow-up arrives.
