# PR-Native Document Review Comments — System Model

## Flow

1. User runs `/review-pr <url> [path]`.
2. `extensions/document-reviewer/review-flow.ts` parses arguments, validates PR metadata, selects a markdown file, and creates a PR review session.
3. `github-pr.ts` wraps GitHub CLI/API interactions: auth checks, PR metadata, changed files, repo identity validation, and review submission.
4. `pr-worktree.ts` creates or recovers a deterministic PR-scoped worktree for the PR head SHA.
5. `server.ts` hosts a `pull_request` review session and stores draft comments in memory.
6. `review-page.ts` sends line-aware draft payloads and uses PR-specific finish copy.
7. On finish, `server.ts` refreshes PR metadata/files, maps inline comments via `pr-diff-map.ts`, submits one GitHub review, and removes the worktree best-effort.

## Boundaries

- Local review mode still writes `<!-- REVIEW: ... -->` annotations into the file.
- PR review mode never writes annotations into the worktree file; it publishes through GitHub.
- PR session state is process-memory only.
- Browser launch behavior remains shared through `extensions/lib/open-external.ts`.

## Main implementation anchors

- `extensions/document-reviewer/index.ts` — local `/review` command and tool.
- `extensions/document-reviewer/review-flow.ts` — PR review command flow.
- `extensions/document-reviewer/github-pr.ts` — GitHub PR adapter and validation.
- `extensions/document-reviewer/pr-worktree.ts` — PR-scoped worktree lifecycle.
- `extensions/document-reviewer/pr-diff-map.ts` — RIGHT-side diff line mapping.
- `extensions/document-reviewer/server.ts` — local/PR session modes and finish handling.
- `extensions/document-reviewer/review-page.ts` — browser UI behavior.

## Failure handling

- Unsupported/malformed PR input returns usage guidance.
- GitHub CLI and auth errors include `gh auth login` guidance.
- Fork PRs are rejected in v1.
- Unmappable or multi-line selections become fallback review-body comments.
- Worktree cleanup is best-effort and reports actionable cleanup guidance on conflicts.
