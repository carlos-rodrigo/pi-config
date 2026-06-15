# PR-Native Document Review Comments — Decisions

- Support GitHub base-repo PRs first; fork PRs remain out of scope for v1.
- Submit comments as one GitHub PR review using `event: COMMENT`.
- Keep unmappable selections as fallback review-body comments instead of dropping them.
- Use deterministic PR-scoped worktrees and clean them up after review completion.
