---
id: 003
status: done
depends: [001, 002]
parent: null
created: 2026-03-15
---

# Add pull-request session mode to review server

Extend the document review service with PR-specific session context and finish branching.

## What to do

- Update `extensions/document-reviewer/server.ts`:
  - add mode discriminator (`document` | `pull_request`)
  - add PR context payload (owner/repo/number/head/base/file/worktree)
  - add `createPullRequestSession(...)` API
  - extend comment draft model to store line metadata (`lineStart`, `lineEnd`) and inline eligibility hints
  - make `/api/:sessionId/document` return mode + PR metadata for UI rendering
  - make `/api/:sessionId/finish` branch by mode (document existing flow, PR flow hook)
- Keep existing `/review <path>` behavior unchanged.

## Acceptance criteria

- [ ] Existing document-mode flow still works unchanged.
- [ ] PR mode sessions can be created and fetched via `/document` endpoint.
- [ ] Comment endpoint accepts PR metadata fields without breaking document mode.
- [ ] Finish handler can dispatch to PR publishing path (stub/hook acceptable in this task).

## Files

- `extensions/document-reviewer/server.ts`

## Verify

```bash
npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler --skipLibCheck extensions/document-reviewer/server.ts
```

Manual:
1. Start regular `/review README.md` session → still behaves as before.
2. Start PR-mode session (via temporary harness) → `/api/:sessionId/document` includes PR metadata.
