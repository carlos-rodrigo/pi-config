# PRD: PR-Native Document Review Comments

## 1) Introduction / Overview

Today `document-reviewer` inserts `<!-- REVIEW: ... -->` annotations directly into local markdown files. 
The new feature should enable a PR-centric workflow:

1. User provides a GitHub PR URL.
2. Pi checks out the PR in a PR-scoped worktree that is deleted after review submission.
3. User reviews a markdown file in the existing reviewer UI.
4. On finish, comments are posted as GitHub PR review comments.

This keeps review feedback where developers already work: inside the PR conversation.

---

## 2) Goals

- Allow starting a review session from a GitHub PR URL.
- Restrict review scope to markdown files changed in the PR (v1 scope).
- Auto-submit comments to GitHub PR review on finish (no extra confirmation step).
- For selections that cannot be mapped to inline diff comments, post them in one aggregated fallback section in the PR review body.
- Create a PR-scoped worktree for review and delete it automatically after review submission.
- Limit v1 to base-repo PRs (no fork PRs).

---

## 3) User Stories

### US-001: Start review from PR URL

**Description:** As a reviewer, I want to pass a PR URL so I can start reviewing without manual checkout.

**BDD Spec:**
- Given: A valid GitHub PR URL and authenticated `gh`
- When: I run `/review-pr <url>`
- Then: Pi resolves PR metadata and prepares a local review workspace

**Acceptance Criteria:**
- [ ] Command and tool support PR URL input (e.g., `https://github.com/org/repo/pull/123`)
- [ ] Invalid URL returns actionable error message
- [ ] Missing/invalid GitHub auth returns actionable guidance (`gh auth login`)
- [ ] PR metadata (owner/repo/number/head SHA) is resolved before review starts

**Feedback Loop:**

Setup: ensure `gh` is installed and authenticated (`gh auth status`) and run Pi in repo.

Verification:
1. Run `/review-pr https://github.com/<owner>/<repo>/pull/<number>` → Expected: status message shows PR detected and review setup started.
2. Run `/review-pr not-a-url` → Expected: validation error with correct usage example.
3. Simulate auth failure (or use unauthenticated shell) and run command → Expected: explicit auth guidance.

Edge cases:
- PR URL with query string (`?diff=split`) → Expected: parser still extracts PR number.
- Non-GitHub URL → Expected: unsupported provider error.
- PR number not found (404) → Expected: clear not-found message.

Regression: existing `/review <path>` continues to work unchanged.

---

### US-002: Create PR worktree, review markdown changes, and clean up worktree

**Description:** As a reviewer, I want Pi to prepare a PR-scoped worktree for review and clean it up after submission so local workspace stays clean.

**BDD Spec:**
- Given: PR metadata is resolved
- When: I start `/review-pr`
- Then: Pi creates (or recovers) a PR-scoped worktree, opens the markdown review session, and deletes that worktree after review submission

**Acceptance Criteria:**
- [ ] Worktree path is deterministic per PR so orphaned/stale folders can be identified
- [ ] Command creates PR-scoped worktree when needed (or reuses only when recovering an interrupted prior run)
- [ ] Worktree is deleted automatically after review submission completes
- [ ] Changed files list is fetched from PR and filtered to markdown extensions only
- [ ] If no markdown file is changed, command exits with clear message
- [ ] If multiple markdown files exist and none is specified, user gets file selection guidance

**Feedback Loop:**

Setup: use a PR containing 2+ markdown files.

Verification:
1. Run `/review-pr <url>` first time → Expected: PR worktree created and markdown candidates discovered.
2. Complete review (`Ctrl+Shift+F`) → Expected: PR comments posted and worktree removed automatically.
3. Run `/review-pr <url> docs/spec.md` (or equivalent file arg) → Expected: targeted file opens directly in reviewer using a new clean worktree.

Edge cases:
- PR has zero markdown files → Expected: graceful message with no review session created.
- File argument not in PR changed files → Expected: validation error listing valid markdown files.
- Previous run crashed and left worktree behind → Expected: command recovers safely, then removes worktree after successful submission.

Regression: `/ws list` and existing worktree-manager behaviors remain intact.

---

### US-003: Post inline PR review comments on finish

**Description:** As a reviewer, I want my comments to be posted directly on PR diff lines when possible.

**BDD Spec:**
- Given: I added comments in reviewer UI
- When: I finish review (`Ctrl+Shift+F`)
- Then: Pi submits a GitHub PR review with inline comments for mappable selections

**Acceptance Criteria:**
- [ ] Finish action posts a GitHub PR review (event: `COMMENT`) automatically
- [ ] Inline comments use current PR `head.sha`
- [ ] Mapping uses PR diff context, not naive string-only offsets
- [ ] Success summary includes count of inline comments posted
- [ ] Browser/tab UX remains best-effort auto-close with fallback message

**Feedback Loop:**

Setup: PR with known markdown diff hunks and authenticated token with `pull_requests:write`.

Verification:
1. Open PR review session, add comment on changed markdown line, finish → Expected: new PR review appears with inline comment on target file/line.
2. Add 2+ comments across same file and finish → Expected: one review with multiple comments.
3. Observe Pi output after finish → Expected: summary includes posted count and PR reference.

Edge cases:
- Force-push PR between session start and finish → Expected: stale SHA detected/re-fetched; comments still posted or clear retry error.
- GitHub API returns 422 for one comment → Expected: process reports degraded result; does not silently succeed.
- Network timeout on submit → Expected: explicit failure status and guidance.

Regression: local annotation mode (`/review <path>`) still writes inline `<!-- REVIEW -->` comments as before.

---

### US-004: Fallback non-inline comments to general PR review comments

**Description:** As a reviewer, I want out-of-diff comments preserved as general PR review feedback instead of being dropped.

**BDD Spec:**
- Given: A selection cannot be mapped to an inline diff position
- When: Review is submitted
- Then: Comment is included in PR review body/general comments with file and context snippet

**Acceptance Criteria:**
- [ ] Unmappable comments are not lost
- [ ] Fallback comments are aggregated into a single "Fallback comments" review-body section, each entry containing file path + selected text snippet + reviewer note
- [ ] Final summary reports inline vs fallback counts
- [ ] Submission still succeeds when mix of inline and fallback comments exists

**Feedback Loop:**

Setup: PR where one selected line is outside changed hunks and one is inside.

Verification:
1. Add one mappable and one unmappable comment, finish review → Expected: inline appears on diff; unmappable appears in aggregated "Fallback comments" section in review body.
2. Add only unmappable comments, finish review → Expected: review still posted with aggregated fallback section.
3. Check Pi output summary → Expected: includes split counts (inline/fallback).

Edge cases:
- Very long selected text → Expected: snippet truncation remains readable and safe.
- Duplicate selections with different notes → Expected: both preserved distinctly.
- Emoji/special chars in comment text → Expected: encoded and posted correctly.

Regression: comment counts in reviewer sidebar remain accurate before submission.

---

### US-005: Tool support for agent-driven PR review flow

**Description:** As an agent user, I want a `review_pr` tool so Pi can drive this workflow from prompts, not only slash commands.

**BDD Spec:**
- Given: LLM calls `review_pr`
- When: URL and options are provided
- Then: tool performs the same command flow and returns structured output

**Acceptance Criteria:**
- [ ] `review_pr` tool is registered with URL + optional file path parameters
- [ ] Tool response includes session ID, review URL, and PR metadata
- [ ] Tool returns completion summary with inline/fallback counts
- [ ] Error responses are actionable and structured

**Feedback Loop:**

Setup: Pi tool-calling session with access to `review_pr`.

Verification:
1. Invoke `review_pr` with valid PR URL → Expected: tool returns session details and opens reviewer URL.
2. Complete review in browser → Expected: tool final result contains publish summary.
3. Invoke `review_pr` with invalid URL → Expected: tool throws structured validation error.

Edge cases:
- Tool called while another PR review is active → Expected: independent session handling.
- File path provided but not markdown → Expected: validation error.
- GitHub permission denied → Expected: permission-specific error guidance.

Regression: existing `review` tool remains available and unchanged.

---

## 4) Functional Requirements

- FR-1: System must parse GitHub PR URLs into owner/repo/PR number.
- FR-2: System must validate GitHub auth before starting PR review.
- FR-3: System must fetch PR metadata including `head.sha`.
- FR-4: System must create a deterministic PR-scoped worktree for each review session, and support safe recovery when a prior session left the same path behind.
- FR-5: System must fetch changed files and filter markdown-only scope (`.md`, `.markdown`, `.mdown`, `.mkd`, `.mdx`).
- FR-6: System must support optional target file selection when multiple markdown files exist.
- FR-7: System must launch existing review UI for chosen file without breaking current keyboard workflow.
- FR-8: On finish, system must submit a GitHub PR review automatically.
- FR-9: Inline comments must be attempted for selections that map to diff lines.
- FR-10: Unmappable comments must be preserved in one aggregated fallback section in the PR review body.
- FR-11: System must report submission outcome with inline/fallback/error counts.
- FR-12: System must expose equivalent behavior through a `review_pr` LLM tool.
- FR-13: System must reject fork PRs in v1 with a clear unsupported-scope message.
- FR-14: System must delete the PR review worktree automatically after review submission completes (including no-comment submissions), and attempt cleanup on recoverable failure paths.

---

## 5) Non-Goals (Out of Scope)

- Bitbucket/GitLab support in v1.
- Fork PR support in v1 (head repo different from base repo).
- Non-markdown file review in v1.
- Suggestion-block authoring UI (` ```suggestion `) in v1.
- Editing PR files from reviewer UI in v1.
- Auto-request-changes / approve review events in v1 (use comment event only).

---

## 6) Design Considerations

- Preserve current reviewer UX and keybindings.
- Keep finish flow simple: finish once, auto-post once, show deterministic outcome.
- Keep copy explicit about browser auto-close being best-effort.

---

## 7) Technical Considerations

- Reuse existing worktree infrastructure in `extensions/lib/worktree.ts` for deterministic workspace management.
- Enforce v1 base-repo scope by validating `head.repo.full_name === base.repo.full_name`; reject fork PRs with actionable guidance.
- Add GitHub integration via `gh api` (preferred for auth reuse) or direct REST calls with token fallback.
- Relevant API surfaces:
  - `GET /repos/{owner}/{repo}/pulls/{number}` (PR metadata, `head.sha`)
  - `GET /repos/{owner}/{repo}/pulls/{number}/files` (changed files)
  - `POST /repos/{owner}/{repo}/pulls/{number}/reviews` (submit grouped review comments)
- Diff mapping must account for GitHub constraints (`line`, `side`, optional `start_line/start_side` for ranges).
- Handle stale `head.sha` (force-push) by re-fetching metadata before publish attempt.
- Cleanup policy should remove PR review worktree immediately after submission, and include best-effort recovery cleanup for interrupted sessions.

---

## 8) Success Metrics

- 90%+ of review sessions for markdown PRs complete without manual checkout steps.
- 95%+ of submitted comments appear in PR review (inline or fallback, not dropped).
- Median time from command to review-ready URL < 15 seconds on a clean PR worktree setup.
- Zero regressions in existing local `/review` flow.

---

## 9) Open Questions

- If review submission fails due to hard errors (e.g., GitHub outage), should the worktree be kept for retry in that same session, or still deleted immediately after surfacing the failure?
