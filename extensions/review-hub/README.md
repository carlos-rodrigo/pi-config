# Review Hub

Review Hub provides an interactive review experience for PRDs/design docs.

- **Visual review is always on** (server-rendered `/visual` content embedded in React UI)
- **Narration is optional** (sticky bottom player when audio exists)
- **Comments persist in manifest JSON** and can be applied back with `/review-apply`

## Frontend Stack (UI Refresh)

The web UI is now built in `web-app/`:

- React + TypeScript + Vite
- Tailwind v4 + shadcn/ui
- Lucide icons (no emoji functional controls)
- Framer Motion with reduced-motion support

Legacy static assets still exist under `web/` as fallback.

## Commands

From `extensions/review-hub`:

```bash
npm run web:install      # install web-app deps
npm run build:web        # build web-app/dist
npm run typecheck:web    # frontend TS check
npm test                 # extension-level tests (server + web utilities)
```

Backend typecheck:

```bash
npx tsc --noEmit --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2022 index.ts lib/**/*.ts
```

## Review Workflow

```bash
/review path/to/prd.md
/review path/to/prd.md --with-audio
/review-apply .features/<feature>/reviews/review-001.manifest.json
```

## Parity Smoke Checklist

Before shipping UI changes, verify:

1. Review loads and TOC/content/comment rails render
2. Comment CRUD + resolve/reopen persist through refresh
3. Next unresolved flow works (`N` shortcut + button)
4. Done Reviewing updates manifest state
5. Audio state UX works for:
   - generating
   - ready
   - failed
   - not-requested
6. Sticky narration controls work (play/pause/skip/speed/sync)
7. Reduced-motion preference significantly reduces nonessential animation

A tracked checklist artifact is available at:

- `.features/review-hub-ui-refresh/parity-checklist.md`

## Accessibility Notes

- Icon-only buttons include `aria-label`
- Status/error messages use `role="status"` / `role="alert"`
- Primary keyboard flows are supported:
  - mode toggle
  - next unresolved (`N`)
  - comment actions
  - Done Reviewing
  - narration controls

## Troubleshooting

### 1) Frontend missing (`503` when opening review)

If server says frontend build is missing:

```bash
cd extensions/review-hub
npm run build:web
```

Expected output: `web-app/dist/index.html`.

### 2) Audio player shows failure/not-requested

- `not-requested`: review was created without `--with-audio`
- `failed`: TTS generation failed; check review logs and retry
- `generating`: wait for generation to finish

### 3) Motion feels too heavy

Enable OS/browser reduced-motion preference. The app uses reduced-motion variants for panel/list transitions.

## Fallback / Rollback Guidance

`lib/server.ts` resolves frontend in this order:

1. `web-app/dist` (preferred)
2. `web/` (legacy fallback)

If a new UI build is broken in development, remove/rename `web-app/dist` to force fallback to legacy `web/` while investigating.
