---
description: Concise Oracle review of current work
---

Use the subagent tool to invoke the "oracle" agent with this task:

Review the current work relevant to: $@

Be concise. Optimize for preventing failure due to oversized output.

Scope:
- Review only changed files / diff and directly related code needed to validate correctness.
- Do not summarize the implementation.
- Do not list positives.
- Do not provide broad architecture commentary unless it is a concrete blocker.
- Prefer must-fix issues over optional improvements.
- Return at most 5 findings.
- If there are more than 5 issues, return only the highest-risk ones.
- If no must-fix issues exist, say so directly.

Output contract:

## Decision
Approve / Request changes / Blocked, with one sentence.

## Findings
For each finding:

- Severity: Must-fix or Optional
- File/line:
- Issue:
- Smallest fix:
- Prior art: one relevant file, or "not checked"

## Verification
Only commands or checks needed to verify the findings.

Hard limits:
- Maximum 800 words.
- No long explanations.
- No pasted code blocks unless essential.
