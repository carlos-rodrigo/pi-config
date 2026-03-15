# Current Feature: PR Review Comments

Started: 2026-03-15
Feature: `.features/pr-review-comments`

## Progress

- [x] 001 - GitHub PR adapter + validation
- [x] 002 - PR worktree lifecycle
- [x] 003 - PR session mode in review server
- [ ] 004 - Review UI PR mode + line metadata capture
- [ ] 005 - Submit pipeline (mapping, fallback, retry, cleanup)
- [ ] 006 - Wire `/review-pr` command + `review_pr` tool + docs

## Guardrails

- v1 base-repo PRs only (`head.repo.full_name === base.repo.full_name`)
- Auto-submit on finish (`event: COMMENT`)
- One aggregated `### Fallback comments` section in review body
- Delete PR worktree after finish path (including no-comment and recoverable errors)

## Notes

- Inline comments are single-line RIGHT-side only in v1.
- Multi-line selections are fallback-only.
- If PR `head.sha` changes before finish, downgrade all drafts to fallback.
