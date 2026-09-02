# Implementation Lifecycle

Always-on delivery control for direct Pi implementation requests:

`interactive authority → complete Git snapshot → isolated no-shell writer → frozen scripts/verify.sh → read-only independent review → at most two repairs → human integration`

## Behavior

- Only an idle, direct interactive TUI request can authorize implementation.
- The primary agent is read-only. Mutation and unknown-effect tool calls are blocked and abort the batch without creating authority.
- The controller captures staged, unstaged, untracked, deleted, renamed, mode, and symlink state through a private Git index, then creates a detached candidate worktree without copying `.env` files or project-local Pi resources. Repositories with configured Git content filters require the request to include the exact phrase `human-reviewed snapshot exception`; without it, the run stops as `DECISION REQUIRED`, and with it, the human's explicit exception authorizes the snapshot path.
- Writer and repair children run with path-confined `read`, `ls`, `edit`, and `write`; no shell or PowerShell. Delete and rename requests stop for a human decision in version one.
- Verification requires the base revision's regular `scripts/verify.sh`. The frozen gate must pass once on the baseline before a writer starts. Existing tests and verification/package/CI configuration are protected by mode/blob identity. Candidate verification runs in a standalone exact-tree snapshot with an isolated credential-free home and rejects nonignored side effects.
- A fresh reviewer has path-confined read/list plus one bounded report tool. Mechanical pass and independent Proud must bind to the same candidate.
- Repairs are pre-counted and limited to two. Missing verification, policy mutation, timeout, malformed review, repeated failure, protected paths, and stale base/candidate proof stop safely.
- Terminal outcomes are `MERGE READY`, `DECISION REQUIRED`, or `FAILED SAFELY`. The extension never advances a branch/ref, merges, pushes, deploys, or modifies the primary worktree. Git creates an unreachable synthetic commit object only as the detached worktree anchor; it is not an integration commit.

Immutable per-run records live under the repository's Git common directory at `pi-delivery/runs/`; an active nonce/PID/process-start lease fences concurrent controllers. Candidate worktrees use controller-owned temporary directories. Use the exact `git diff <base-tree> <candidate-tree>` command printed at completion before integrating manually.

## Trust boundary

Version one is for trusted local repositories. Child roles have path guards and credential-scrubbed environments, but they still run as the host user and model inference uses the configured provider. OS/container isolation and network denial are required before unattended execution of untrusted repositories.

## Verification

```bash
npm run test:implementation-lifecycle
npm run test:typecheck
```
