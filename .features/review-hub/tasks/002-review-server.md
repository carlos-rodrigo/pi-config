---
id: 002
status: done
depends: [001]
created: 2026-02-27
---

# Review server (HTTP)

Implement the ephemeral local HTTP server that hosts the review web app and handles comment persistence.

## What to do

### Server implementation (`lib/server.ts`)

- Implement `ReviewServer` class using `node:http`:
  - `start(manifest, reviewDir)` — start server on available port, return URL with session token
  - `stop()` — close server gracefully
- **Port selection:** Scan ports 3847–3947 for an available one using `net.createServer().listen()` test
- **Session token:** Generate `crypto.randomUUID()` on start, required for all POST requests
- **Bind to `127.0.0.1` only** — no network exposure

### GET routes (static serving)

- `/` → serve `web/index.html`
- `/styles.css` → serve `web/styles.css`
- `/app.js` → serve `web/app.js`
- `/wavesurfer.js` → serve `web/vendor/wavesurfer.min.js` (will be added in task 010)
- `/manifest.json` → serve the review manifest
- `/audio` → serve audio file from review directory (if exists)
- `/source` → serve source markdown file
- Content-type headers set correctly for each file type

### POST routes (comment API)

- `POST /comments` — add or update a comment
  - Validate session token from `X-Session-Token` header
  - Parse JSON body
  - Add comment to manifest
  - Atomic save manifest to disk
  - Return updated comment with generated ID
- `POST /complete` — mark review as complete
  - Validate session token
  - Set `manifest.status = "reviewed"`, `manifest.completedAt = now`
  - Save manifest
  - Return success
- `DELETE /comments/:id` — remove a comment
  - Validate session token
  - Remove comment from manifest
  - Atomic save

### Lifecycle management

- Write PID + port to `~/.pi/review-hub/server.lock` on start
- Remove lock file on stop
- Implement `cleanupOrphanServers()`:
  - On startup, read lock file
  - If PID is dead → remove lock
  - If PID alive but from different process → warn

### Placeholder web files

- Create minimal `web/index.html` that shows "Review Hub — Loading..." (real UI in task 003)
- Create empty `web/styles.css` and `web/app.js`

## Acceptance criteria

- [ ] Server starts on an available port and serves the placeholder HTML
- [ ] `http://127.0.0.1:{port}?token={token}` loads in a browser
- [ ] GET routes serve correct content types
- [ ] POST `/comments` saves a comment to the manifest JSON on disk
- [ ] POST `/comments` rejects requests without valid session token (401)
- [ ] POST `/complete` updates manifest status
- [ ] DELETE `/comments/:id` removes a comment
- [ ] Manifest writes are atomic (temp + rename)
- [ ] Server binds to 127.0.0.1 only (not 0.0.0.0)
- [ ] Lock file created on start, removed on stop
- [ ] `cleanupOrphanServers()` handles dead PID case
- [ ] `server.stop()` cleanly shuts down the HTTP server

## Files

- `~/.pi/agent/extensions/review-hub/lib/server.ts`
- `~/.pi/agent/extensions/review-hub/web/index.html` (placeholder)
- `~/.pi/agent/extensions/review-hub/web/styles.css` (empty)
- `~/.pi/agent/extensions/review-hub/web/app.js` (empty)

## Verify

```bash
# Manual: start server, curl endpoints, check responses
# curl http://127.0.0.1:3847/ should return HTML
# curl -X POST http://127.0.0.1:3847/comments -H "X-Session-Token: bad" should return 401
```
