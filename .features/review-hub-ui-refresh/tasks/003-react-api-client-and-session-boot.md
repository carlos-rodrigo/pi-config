---
id: 003
status: open
depends: [001]
parent: null
created: 2026-02-27
---

# Implement typed React API client and session token boot flow

Build the frontend API layer that reads the token from URL, fetches manifest, and performs authenticated comment mutations.

## What to do

- Create typed client/hooks for:
  - `GET /manifest.json`
  - `POST /comments`
  - `DELETE /comments/:id`
  - `POST /complete`
- Reuse manifest/comment TypeScript contracts from backend.
- Implement startup token parsing and missing-token error state.
- Centralize fetch retry/error handling.

## Acceptance criteria

- [ ] App initializes with URL token and loads manifest.
- [ ] Comment create/update/delete works through typed client.
- [ ] Complete review action works through typed client.
- [ ] Missing/invalid token presents clear UX state.

## Files

- `extensions/review-hub/web-app/src/lib/api/*`
- `extensions/review-hub/web-app/src/hooks/*`
- `extensions/review-hub/web-app/src/App.tsx` (boot integration)

## Verify

```bash
cd ~/.pi/agent/extensions/review-hub
npm run build:web
# run /review on a test doc
# In browser: add, edit, delete comment and click Done Reviewing
# Confirm requests succeed with X-Session-Token.
```
