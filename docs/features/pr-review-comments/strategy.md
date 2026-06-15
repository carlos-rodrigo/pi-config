# PR-Native Document Review Comments — Strategy

## Problem

Local markdown review comments are useful, but PR feedback belongs in the GitHub pull request when the review target is a PR. Reviewers need a flow that opens changed markdown files from a PR and publishes comments back to the PR without leaving stale local annotations behind.

## Goals

- Support `/review-pr <github-pr-url> [changed-markdown-path]` for GitHub PR markdown review.
- Restrict v1 to base-repo GitHub PRs and changed markdown files.
- Create a deterministic PR-scoped worktree and clean it up after review completion.
- Submit one GitHub PR review containing inline comments when mappable and fallback body comments when not.
- Preserve the existing local `/review <path>` markdown annotation mode.

## Non-goals

- Fork PR support.
- Reviewing non-markdown files.
- Persistent database storage for review sessions.

## Success criteria

- Invalid PR URLs, missing `gh`, auth failures, fork PRs, and repo mismatches return actionable errors.
- Multiple changed markdown files produce clear selection guidance.
- Finish in PR mode submits comments to GitHub and reports inline/fallback counts.
- Worktrees are removed after successful or no-comment completion.
- Local document review behavior remains unchanged.
