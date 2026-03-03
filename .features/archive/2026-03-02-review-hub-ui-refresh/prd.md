# PRD: Review Hub UI Refresh (shadcn + Motion + Icon System)

## 1) Introduction / Overview

Review Hub already works functionally, but the current web UI feels visually flat and interaction-heavy areas (reading + commenting + audio) are not optimized for confidence and flow.

This feature introduces a **full web UI migration to React + Vite + Tailwind + shadcn/ui**, with:

- a research-backed **3-column review layout** (TOC + content + comments),
- a sticky bottom **narration player**,
- **Lucide icons** replacing emoji,
- **Framer Motion** transitions,
- stronger readability and accessibility defaults.

The goal is to make review sessions feel premium, predictable, and faster to navigate without changing core review behavior (manifest/comments/apply pipeline).

---

## 2) Goals

- Migrate Review Hub web UI to React + Vite + Tailwind + shadcn/ui.
- Implement desktop-first 3-column IA for long-form review.
- Replace emoji-based affordances with a consistent Lucide icon system.
- Add purposeful motion (Framer Motion) with reduced-motion compliance.
- Keep existing review data contract and server behavior compatible.
- Improve perceived quality and navigation efficiency for document review.

---

## 3) User Stories

### US-001: React + Vite + Tailwind + shadcn foundation

**Description:** As a maintainer, I want a modern frontend foundation so we can use shadcn/ui components consistently and scale UI quality.

**BDD Spec:**
- Given: Review Hub currently serves a vanilla web app
- When: the frontend foundation is migrated
- Then: the server can serve a built React app with shadcn styling and no runtime CDN dependency

**Acceptance Criteria:**

- [ ] Add React + Vite frontend structure under `web-app/` (or equivalent agreed path)
- [ ] Add Tailwind v4 configuration and shadcn initialization (`components.json`)
- [ ] Add initial shadcn primitives used by review shell (button, tooltip, badge, separator, scroll-area, sheet/dialog as needed)
- [ ] Build output is static assets (`dist`) suitable for local Node server serving
- [ ] No runtime dependency on remote CSS/JS CDNs for core UI
- [ ] TypeScript build/typecheck for extension and frontend succeeds

**Feedback Loop:**

Setup:
1. `cd ~/.pi/agent/extensions/review-hub`
2. Install dependencies (`npm install` in extension and frontend workspace if split)

Verification:
1. Run frontend build command (e.g. `npm run build:web`) → Expected: `dist` generated with hashed assets
2. Run extension typecheck command (`npx tsc --noEmit --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2022 index.ts lib/**/*.ts`) → Expected: no TS errors
3. Start a review (`/review <doc>`) → Expected: new React UI loads in browser

Edge cases:
- Delete `dist` and run review without rebuilding → expected clear error or auto-build path documented
- Invalid/missing frontend env config → expected deterministic fallback (no crash loop)

Regression:
- Generate a visual-only review and a with-audio review; both open and load successfully

---

### US-002: Server delivery for built UI assets

**Description:** As a user, I want the Review Hub server to reliably serve the new built frontend and static assets.

**BDD Spec:**
- Given: built frontend assets exist
- When: Review Hub starts a review session
- Then: all app routes and assets are served locally with correct MIME types and session behavior

**Acceptance Criteria:**

- [ ] `lib/server.ts` serves built frontend entry (`index.html`) and hashed asset files
- [ ] Existing API routes (`/manifest.json`, `/comments`, `/complete`, `/audio`, `/visual*` if still needed) remain functional
- [ ] Proper MIME handling for JS/CSS/fonts/images
- [ ] Unknown frontend routes fallback to SPA entry (if routing is used)
- [ ] Security constraints remain (localhost binding, token checks, path allowlist)

**Feedback Loop:**

Setup:
1. Build frontend assets
2. Run `/review <doc>`

Verification:
1. Open devtools network tab → Expected: JS/CSS/font assets served from local review server URL
2. Add/edit/delete comment → Expected: POST/DELETE endpoints succeed with token auth
3. Refresh page → Expected: app boots and rehydrates from manifest/comments correctly

Edge cases:
- Missing `dist` directory → expected actionable error message
- Bad route path request → expected 404 or SPA fallback as designed, no sensitive file exposure

Regression:
- Run `/review-list` and `/review-apply` flow after UI migration; no server route regressions

---

### US-003: 3-column review IA + Read/Review mode

**Description:** As a reviewer, I want a clear reading architecture so I can scan the document and add feedback without losing context.

**BDD Spec:**
- Given: a review is opened
- When: I navigate sections and comments
- Then: TOC, content, and comments stay synchronized in a clear desktop layout

**Acceptance Criteria:**

- [ ] Desktop layout: left TOC, center content, right comments rail
- [ ] Read mode and Review mode toggle is implemented
- [ ] TOC shows section progress and unresolved counts
- [ ] Active section state updates on scroll/navigation
- [ ] Tablet/mobile collapse behavior is defined and implemented (drawer/sheet patterns)

**Feedback Loop:**

Setup:
1. Open review with a document containing 10+ sections and multiple comments

Verification:
1. Scroll content in Review mode → Expected: active TOC item updates
2. Toggle to Read mode → Expected: chrome collapses, content width/focus increases
3. Click TOC section → Expected: smooth jump to section and corresponding contextual highlight

Edge cases:
- Very short doc (1-2 sections) → layout should not look broken/empty-heavy
- Very long doc (40+ sections) → TOC remains usable and scrollable

Regression:
- Existing section comment creation/editing still works in new layout

---

### US-004: Icon system migration (no emojis)

**Description:** As a user, I want consistent iconography so the UI looks professional and accessible across platforms.

**BDD Spec:**
- Given: prior UI used emojis in controls/status
- When: icon migration is complete
- Then: all interaction-critical symbols use Lucide icons with labels/tooltips where needed

**Acceptance Criteria:**

- [ ] Replace emoji-based controls/status in app shell, comment types, player controls, and banners
- [ ] Use Lucide icon set with consistent size/stroke rules
- [ ] Icon-only buttons have `aria-label`
- [ ] Decorative icons use `aria-hidden=true`
- [ ] No emoji remain in the web UI for functional controls

**Feedback Loop:**

Setup:
1. Open migrated review UI

Verification:
1. Inspect key controls (comment add, resolve, play/pause, next unresolved, filters) → Expected: Lucide icons rendered
2. Run accessibility inspector on icon-only buttons → Expected: valid accessible names
3. Search UI source for emoji glyph ranges (manual/automated grep) → Expected: none in functional components

Edge cases:
- Missing icon import → build should fail clearly
- High DPI / zoomed UI (125–200%) → icons remain crisp/aligned

Regression:
- All button actions still trigger expected behavior post-icon swap

---

### US-005: Comment rail UX + section-aware navigation

**Description:** As a reviewer, I want section-aware comment navigation so I can process unresolved feedback efficiently.

**BDD Spec:**
- Given: multiple comments across sections
- When: I navigate comments
- Then: I can jump through unresolved items and keep section context

**Acceptance Criteria:**

- [ ] Comment rail supports filtering (type/status/priority where applicable)
- [ ] Add “next unresolved” navigation control
- [ ] Comment click navigates/highlights anchored section
- [ ] Section header affordance for quick comment creation remains
- [ ] Comment statuses visually differentiate open vs resolved

**Feedback Loop:**

Setup:
1. Seed a review with mixed comment types and statuses

Verification:
1. Click “next unresolved” repeatedly → Expected: cycles unresolved comments in order
2. Click comment card → Expected: content scrolls to anchor and highlights target section
3. Change filter selections → Expected: rail updates correctly without full page reload

Edge cases:
- No comments → empty state is clear with primary CTA
- All comments resolved → next-unresolved control shows terminal “all caught up” behavior

Regression:
- Comment CRUD persists to manifest as before

---

### US-006: Sticky bottom narration player

**Description:** As a reviewer, I want a persistent but unobtrusive audio player so narration supports reading instead of dominating the page.

**BDD Spec:**
- Given: review has audio
- When: I scroll or switch sections
- Then: player remains accessible at bottom and sync behavior remains controllable

**Acceptance Criteria:**

- [ ] Player is sticky at bottom on desktop, non-obstructive
- [ ] Uses icon controls (play/pause/seek/speed/sync)
- [ ] Current section/time metadata shown in compact format
- [ ] Sync visual-to-audio toggle remains available and persisted for session
- [ ] Clear audio state messaging: generating / ready / failed / not requested

**Feedback Loop:**

Setup:
1. Open one review with audio and one without

Verification:
1. Audio review: play and scroll content → Expected: player stays fixed, time updates, sync works
2. Toggle sync off → Expected: audio no longer drives section autoscroll
3. Visual-only review → Expected: no broken player controls, proper state banner shown

Edge cases:
- Audio load failure mid-session → expected graceful error state, no app crash
- Very short audio (<15s) → controls and timestamps still render correctly

Regression:
- Timestamp-based comment creation from audio remains possible if enabled by design

---

### US-007: Motion system (Framer Motion) with reduced motion

**Description:** As a user, I want smooth transitions that help orientation without distraction.

**BDD Spec:**
- Given: I interact with navigation, panel changes, and comments
- When: transitions occur
- Then: motion feels intentional and can be reduced per OS preference

**Acceptance Criteria:**

- [ ] Define motion primitives/tokens (durations/easings/springs)
- [ ] Animate key transitions: mode toggle, panel entry, section focus, comment status changes
- [ ] Respect `prefers-reduced-motion` with reduced/disabled nonessential animation
- [ ] Avoid heavy/parallax gimmicks that hurt readability
- [ ] No layout jank during long-doc scrolling

**Feedback Loop:**

Setup:
1. Open app in normal mode and with OS/browser reduced motion enabled

Verification:
1. Trigger UI transitions (mode switch, comment add, filter changes) → Expected: smooth transitions under 350ms typical
2. Enable reduced motion → Expected: simplified/fewer animations; interactions remain clear
3. Profile performance while scrolling long doc → Expected: no severe frame drops attributable to motion layer

Edge cases:
- Rapid toggle spam between modes → UI state remains consistent
- Low-power device / throttled CPU → app still usable and responsive

Regression:
- No animation should block core actions (commenting, completion, playback)

---

### US-008: Accessibility and keyboard-first review flow

**Description:** As a keyboard and assistive-tech user, I want complete review functionality without mouse dependence.

**BDD Spec:**
- Given: I navigate with keyboard/screen reader
- When: I perform review tasks
- Then: all major actions are reachable and announced correctly

**Acceptance Criteria:**

- [ ] Landmark structure and semantic headings are valid
- [ ] Focus management implemented for dialogs/sheets/forms
- [ ] Keyboard shortcuts for key flows documented (e.g., next unresolved)
- [ ] Icon-only controls include accessible names
- [ ] Contrast and focus indicators meet WCAG AA baseline

**Feedback Loop:**

Setup:
1. Open review UI and enable browser accessibility tools

Verification:
1. Tab through interactive controls → Expected: visible, logical focus order
2. Open/close dialogs/sheets via keyboard → Expected: focus trap + restore works
3. Run automated a11y check (e.g., axe in browser extension/manual pass) → Expected: no critical violations

Edge cases:
- Long comment textareas with keyboard submit/cancel
- Screen zoom 200% and high contrast mode

Regression:
- Existing Done Reviewing flow remains keyboard operable

---

### US-009: Migration parity + rollout safety

**Description:** As a maintainer, I want migration guardrails so the new UI can be validated and shipped safely.

**BDD Spec:**
- Given: UI stack changes significantly
- When: migration is completed
- Then: critical old behavior remains intact and fallback strategy is clear

**Acceptance Criteria:**

- [ ] Define and execute parity checklist (review load, comment CRUD, complete review, audio states)
- [ ] Update README with new frontend stack/build/run instructions
- [ ] Include troubleshooting section for missing frontend build assets
- [ ] Document rollback/fallback strategy for UI layer
- [ ] Smoke test instructions are reproducible in terminal

**Feedback Loop:**

Setup:
1. Fresh install dependencies
2. Build frontend
3. Run representative reviews (visual-only + with-audio)

Verification:
1. Complete parity checklist end-to-end → Expected: all pass
2. Follow README setup from scratch on clean environment → Expected: works without hidden steps
3. Simulate missing dist assets → Expected: actionable error guidance

Edge cases:
- Review generated while frontend is stale (old build)
- Restart extension/session during active review

Regression:
- `/review`, `/review-list`, `/review-apply` still operational after migration

---

## 4) Functional Requirements

- FR-1: The web UI must be migrated to React + Vite + Tailwind + shadcn/ui.
- FR-2: Review server must serve built frontend assets and preserve secure API behavior.
- FR-3: UI must implement desktop-first 3-column layout with responsive collapse behavior.
- FR-4: UI must support explicit Read mode and Review mode.
- FR-5: UI must use Lucide icons for interaction/status controls; emojis are disallowed for functional UI.
- FR-6: UI must provide sticky bottom narration player for audio-enabled reviews.
- FR-7: UI must preserve audio state communication (generating, ready, failed, not requested).
- FR-8: UI must keep section-aware comment anchoring and navigation.
- FR-9: UI must include unresolved-comment navigation workflow.
- FR-10: Motion must be implemented with Framer Motion and respect reduced-motion preferences.
- FR-11: Accessibility requirements (focus, semantics, contrast, ARIA labeling) must meet WCAG AA baseline.
- FR-12: Existing review manifest and comment API contracts must remain backward compatible.
- FR-13: Documentation must be updated for new stack, build, and troubleshooting flow.

---

## 5) Non-Goals (Out of Scope)

- Rewriting review generation backend (script generation, TTS provider logic) beyond UI integration needs.
- Changing core manifest schema semantics (except additive UI metadata already present).
- Introducing multi-user real-time collaboration.
- Mobile-first redesign beyond responsive fallback behavior.
- Replacing local server architecture with cloud hosting.
- Adding new review artifact types unrelated to PRD/design review UI migration.

---

## 6) Design Considerations

- Use shadcn “new-york” style baseline and adapt with Review Hub visual identity.
- Prioritize readability in content column (long-form optimized typography and spacing).
- Keep comment rail high-density but scannable (status chips, compact metadata).
- Remove visual noise; motion should orient, not distract.
- Iconography must be consistent in size/stroke and paired with labels for key actions.

---

## 7) Technical Considerations

- Build pipeline addition is required (`vite build`) and must integrate with extension packaging/serving.
- Decide frontend folder strategy (`web-app/` source + `web-dist/` output, or equivalent).
- Server route handling should avoid path traversal and serve only build artifacts + known APIs.
- Prefer local font assets or deterministic fallback strategy for offline resilience.
- Keep bundle size reasonable; avoid unnecessary heavy dependencies.

---

## 8) Success Metrics

- ≥90% of review sessions complete without UI confusion/escalation (qualitative team feedback).
- Reduced “where do I comment / where am I” complaints in review sessions.
- Median time to navigate to next unresolved comment decreases vs current UI baseline.
- No regression in review completion rate after migration.
- Accessibility checks show no critical violations in primary review flows.

---

## 9) Open Questions

- Should we keep React runtime standard or optimize with Preact compatibility later?
- Do we include virtualization for comment rail in v1 migration or defer until needed?
- Should “resolved” comments be collapsed by default or remain expanded with grouping?
- Do we preserve existing `/visual` HTML endpoint as fallback during migration window?
