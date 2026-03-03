---
id: 012
status: open
depends: [007, 009, 010, 011]
parent: null
created: 2026-02-27
---

# Security hardening + migration/regression test gate

Add final hardening and test coverage for the rebuild’s risk areas before implementation loop completion.

## What to do

- Add/extend tests for:
  - manifest v1->v2 normalization and unknown version rejection
  - anchor degradation behavior and export markers
  - `/finish` idempotency and exportHash verification
  - `/clipboard/copy` fallback behavior
  - `/visual-model` route behavior
- Add token hygiene hardening in frontend bootstrap:
  - remove `?token=` from URL after token capture
- Add stricter response headers where appropriate (e.g., referrer policy).

## Acceptance criteria

- [ ] New tests cover migration, anchoring, export, finish, and security paths
- [ ] Existing tests remain green
- [ ] URL token is removed from browser history after bootstrap
- [ ] Sensitive mutation endpoints remain token-gated
- [ ] No regressions in localhost-only + lockfile behavior

## Files

- `extensions/review-hub/test/*.test.ts`
- `extensions/review-hub/lib/server.ts`
- `extensions/review-hub/web-app/src/hooks/use-session-token.ts` (or equivalent bootstrap hook)
- `extensions/review-hub/web-app/src/*` (headers/token cleanup integration)

## Verify

```bash
cd extensions/review-hub
npm test
npm run typecheck:web
npm run build:web
```
