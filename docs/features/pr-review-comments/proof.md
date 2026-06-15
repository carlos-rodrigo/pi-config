# PR-Native Document Review Comments — Proof

## Targeted checks

```bash
npm run test:document-reviewer
```

Expected: document reviewer unit/integration tests pass, including PR URL parsing, PR worktree behavior, PR diff mapping, PR review server mode, and browser review flow.

## Regression gate

```bash
bash scripts/verify.sh
```

Expected: full project verification exits 0 and stays silent on success.

## Manual checks

- Run `/review docs/features/README.md` and finish a local markdown review.
- For PR mode, use an authenticated `gh` session and a base-repo GitHub PR with changed markdown files; verify inline and fallback comments post to the PR review as expected.
