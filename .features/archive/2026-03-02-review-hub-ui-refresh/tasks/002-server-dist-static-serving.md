---
id: 002
status: done
depends: [001]
parent: null
created: 2026-02-27
---

# Update review server to safely serve built frontend dist

Modernize static serving in `lib/server.ts` so Review Hub can load Vite build artifacts (`index.html`, hashed JS/CSS/assets) without weakening path security.

## What to do

- Add dist-root resolver for frontend build output (`web-app/dist`).
- Serve static files under dist with safe path containment checks.
- Keep API routes unchanged (`/manifest.json`, `/comments`, `/complete`, `/audio`, `/visual`, `/visual-styles`).
- Add SPA fallback to `index.html` for non-API routes.
- Provide clear error/fallback behavior if dist is missing.

## Acceptance criteria

- [ ] Frontend assets load from local review server.
- [ ] Existing API routes still work as before.
- [ ] No path traversal exposure is introduced.
- [ ] Missing dist produces actionable message (or explicit fallback path).

## Files

- `extensions/review-hub/lib/server.ts`

## Verify

```bash
cd ~/.pi/agent/extensions/review-hub
npm run build:web
# then inside pi run:
# /review .features/review-hub-ui-refresh/prd.md
# Verify browser loads app and network serves local assets + API routes.
```
