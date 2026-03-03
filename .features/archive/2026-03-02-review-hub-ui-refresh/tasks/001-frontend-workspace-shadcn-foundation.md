---
id: 001
status: done
depends: []
parent: null
created: 2026-02-27
---

# Create React + Vite + Tailwind + shadcn frontend workspace

Set up the new frontend foundation under `extensions/review-hub/web-app/` with build output suitable for local server hosting.

## What to do

- Create `web-app/` with React + TypeScript + Vite.
- Add Tailwind v4 and initialize shadcn (`components.json`, base styles, utility config).
- Add initial shadcn primitives needed for app shell (Button, Badge, Tooltip, Separator, ScrollArea, Sheet/Dialog).
- Add frontend build scripts in extension `package.json`.
- Ensure build output directory is deterministic and documented (`web-app/dist`).

## Acceptance criteria

- [ ] `web-app/` exists with React/Vite app entry and TypeScript config.
- [ ] Tailwind + shadcn compile correctly in dev/build.
- [ ] Frontend build generates `web-app/dist` assets.
- [ ] No runtime CDN dependency is required for core UI rendering.
- [ ] `npx tsc --noEmit --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2022 index.ts lib/**/*.ts` still passes.

## Files

- `extensions/review-hub/package.json`
- `extensions/review-hub/web-app/**`

## Verify

```bash
cd ~/.pi/agent/extensions/review-hub
npm install
npm run build:web
test -f web-app/dist/index.html && echo "dist ready"
```
