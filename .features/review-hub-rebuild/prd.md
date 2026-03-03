# PRD: Review Hub Rebuild (Charm Edition)

## 1) Introduction / Overview

Rebuild Review Hub from zero as a clean React application optimized for reading and reviewing PRDs/design docs, with optional audio support and a fast handoff back to pi.

The current web experience is visually and functionally unreliable. This rebuild prioritizes:

- Excellent readability for long technical documents
- Fast inline review via text-selection comments
- Practical review completion flow: **export feedback → copy → close tab → auto-paste in pi**
- Token-efficient feedback output for agent workflows

This PRD intentionally allows contract changes and migration work.

### Fixed product decisions (from user)

- Compatibility: **breaking changes allowed (with migration)**
- Scope: include **audio playback + audio generation status/actions**
- UI stack: **custom UI**, not tied to a fixed design system
- No built-in audit panel
- Text selection comments:
  - single continuous selection only
  - selection auto-opens comment composer
  - exported feedback always includes selected quote
  - on anchor drift, fallback to section-level with warning
- Completion handoff:
  - copy + close review tab + auto-paste into currently focused pi input
  - if automation fails: warning + copied payload remains available for manual paste
- Export format: **compact Markdown only**
- Default export scope: **open comments only**

---

## 2) Goals

- G1. Deliver a stable, readable, attractive doc-review UI for desktop workflows.
- G2. Enable fast, precise feedback anchored to selected text.
- G3. Support listen-while-review with section sync and clear audio status.
- G4. Minimize handoff friction from review UI back to pi chat.
- G5. Reduce token overhead by exporting compact, structured markdown.

---

## 3) User Stories

### US-001: Clean reader shell with Read/Review modes

**Description:** As a reviewer, I want a clean shell with clear Read and Review modes so I can focus on reading or feedback without clutter.

**BDD Spec:**
- Given a review is opened
- When the app loads
- Then I see a stable shell with top controls and responsive layout
- And switching between Read and Review changes rails/tools visibility

**Acceptance Criteria:**
- [ ] App renders a 3-column review layout on desktop (TOC / content / comments)
- [ ] Read mode hides review-only rails/actions and maximizes reading width
- [ ] Review mode shows TOC + comment tools
- [ ] Mobile/tablet use drawers/sheets for rails
- [ ] No console errors during mode switching
- [ ] `npm run typecheck:web` passes

**Feedback Loop:**
Setup: `cd extensions/review-hub && npm run dev:web`

Verification:
1. Open app URL from `/review` → shell loads with top controls and content area.
2. Toggle Read/Review repeatedly → layout updates without broken spacing or overlap.
3. Resize to tablet/mobile width → rails become drawers/sheets.
4. Run `npm run typecheck:web` → no type errors.

Edge cases:
- Extremely long source path in header truncates safely.
- Empty comments list does not collapse right panel.
- 100+ sections in TOC remains scrollable.

Regression: `cd extensions/review-hub && npm test`

---

### US-002: Deterministic markdown rendering with section map

**Description:** As a reviewer, I want PRDs/design docs rendered consistently with section IDs so navigation, comments, and audio sync are reliable.

**BDD Spec:**
- Given a markdown source and parsed section metadata
- When visual content is rendered
- Then each section has stable identity and readable typography

**Acceptance Criteria:**
- [ ] Headings/lists/code/tables/quotes render correctly
- [ ] Each reviewable section has stable `sectionId`
- [ ] TOC click scrolls to section
- [ ] Active section tracking updates during scroll
- [ ] Render works on large docs without freezing UI
- [ ] `npm run typecheck:web` passes

**Feedback Loop:**
Setup: run review on a real PRD with 20+ sections

Verification:
1. Scroll document from top to bottom → active section indicator updates.
2. Click 5 random TOC entries → jumps to correct section each time.
3. Confirm code/table/blockquote styles remain readable.
4. Run `npm run typecheck:web`.

Edge cases:
- Duplicate headings still map to unique section IDs.
- Very long tables allow horizontal scrolling.
- Large code blocks don’t break container width.

Regression: `cd extensions/review-hub && npm test`

---

### US-003: Add comment from selected text (single selection)

**Description:** As a reviewer, I want selecting text to immediately open comment composer so I can leave precise feedback quickly.

**BDD Spec:**
- Given I select a text range in content
- When selection ends
- Then comment composer opens prefilled with section and quote anchor

**Acceptance Criteria:**
- [ ] Single continuous text selection triggers composer auto-open
- [ ] Composer pre-fills `sectionId` and captured quote
- [ ] Selection highlight remains visible while composing
- [ ] Empty/invalid selection does not create anchor
- [ ] Only one range per comment (no multi-select)
- [ ] `npm run typecheck:web` passes

**Feedback Loop:**
Setup: open any PRD in Review mode

Verification:
1. Highlight one sentence → composer opens automatically.
2. Submit comment → comment stores selected quote.
3. Click saved comment → corresponding text highlight is shown.
4. Run `npm run typecheck:web`.

Edge cases:
- Selection crossing section boundary snaps to originating section with warning.
- Selecting only whitespace does nothing.
- Selecting inside code block still creates quote anchor.

Regression: `cd extensions/review-hub && npm test`

---

### US-004: Comment thread management for review flow

**Description:** As a reviewer, I want to manage comment threads (create/edit/delete/resolve) so I can iterate feedback before exporting.

**BDD Spec:**
- Given comments exist
- When I filter, edit, resolve, or delete
- Then state persists and unresolved workflow remains accurate

**Acceptance Criteria:**
- [ ] CRUD operations for comments work
- [ ] Comments support status: `open | resolved`
- [ ] Filters by type and unresolved count work
- [ ] Next-unresolved navigation works via button + shortcut
- [ ] Clicking comment jumps to section/quote location
- [ ] `npm run typecheck:web` passes

**Feedback Loop:**
Setup: create at least 5 comments of mixed types

Verification:
1. Resolve two comments → unresolved count decreases correctly.
2. Use next-unresolved shortcut repeatedly → cycles open comments predictably.
3. Edit one comment quote text + body → persists after refresh.
4. Delete one comment → removed from list and manifest.

Edge cases:
- Legacy comment without anchor still navigates by section.
- Filtering on empty set shows clear empty state.
- Resolve/reopen idempotent with rapid clicking.

Regression: `cd extensions/review-hub && npm test`

---

### US-005: Audio playback and section sync

**Description:** As a reviewer, I want audio playback with optional section sync so I can review by listening and reading together.

**BDD Spec:**
- Given audio is available
- When playback runs
- Then current section can sync in UI and be toggled on/off

**Acceptance Criteria:**
- [ ] Sticky audio bar with play/pause/seek/speed
- [ ] Current time and total duration are visible
- [ ] Sync toggle controls scroll/active-section behavior
- [ ] Section labels update as playback progresses
- [ ] Works with no-audio state gracefully
- [ ] `npm run typecheck:web` passes

**Feedback Loop:**
Setup: run review with generated audio

Verification:
1. Play/pause/seek/speed all respond correctly.
2. With sync ON, section focus follows playback.
3. With sync OFF, playback continues without forced scrolling.
4. Refresh page → audio UI still loads correctly.

Edge cases:
- Missing section timestamps shows fallback label.
- Audio load failure shows actionable message.
- Spacebar shortcut does not trigger while typing in textarea.

Regression: `cd extensions/review-hub && npm test`

---

### US-006: Audio generation status/actions in UI

**Description:** As a reviewer, I want clear generation states and actions so I know if narration is ready, failed, or needs retry.

**BDD Spec:**
- Given a review has audio lifecycle states
- When I open the app
- Then status is explicit and available actions match state

**Acceptance Criteria:**
- [ ] UI supports `not-requested`, `generating`, `ready`, `failed`
- [ ] Status messaging is concise and actionable
- [ ] Retry/regenerate action exposed for failed/not-requested cases
- [ ] Generating state disables invalid playback actions
- [ ] State changes update without full app breakage
- [ ] `npm run typecheck:web` passes

**Feedback Loop:**
Setup: run fixtures for each audio state

Verification:
1. Open not-requested review → clear CTA to generate audio.
2. Open generating review → progress/status displayed.
3. Open failed review → retry action + reason shown.
4. Open ready review → player active.

Edge cases:
- Retry fails twice: keep user in recoverable state with manual fallback.
- Missing failure reason still displays generic message.
- Partial metadata does not crash status card.

Regression: `cd extensions/review-hub && npm test`

---

### US-007: Compact markdown feedback export (open comments only)

**Description:** As an agent operator, I want compact markdown export of unresolved feedback so pi can consume it with minimal token cost.

**BDD Spec:**
- Given a set of comments with mixed statuses
- When I export feedback
- Then only open comments are included in compact markdown format with quote anchors

**Acceptance Criteria:**
- [ ] Export includes only `open` comments by default
- [ ] Each item includes section reference + quoted selected text + concise instruction
- [ ] Output avoids verbose prose and duplication
- [ ] Output is deterministic/stable ordering
- [ ] Export preview is available before completion action
- [ ] `npm run typecheck:web` passes

**Feedback Loop:**
Setup: create 6 comments, resolve 2

Verification:
1. Trigger export preview → exactly 4 open comments appear.
2. Confirm each exported item contains quote snippet.
3. Export twice without changes → identical output.
4. Resolve one comment and export again → item removed.

Edge cases:
- Comment with missing anchor falls back to section-level with warning badge.
- Very long quote is trimmed to configured max length.
- Unicode/emoji in quote is preserved safely.

Regression: `cd extensions/review-hub && npm test`

---

### US-008: Finish flow (copy → close tab → auto-paste in pi)

**Description:** As a reviewer, I want one completion action that copies feedback, closes the review UI, and pastes into pi automatically.

**BDD Spec:**
- Given export payload is ready
- When I click Finish Review
- Then payload is copied, review window closes, and pi receives pasted feedback

**Acceptance Criteria:**
- [ ] Single finish action executes copy + close + auto-paste attempt
- [ ] If auto-paste fails, warning is shown and copied payload remains available
- [ ] UI confirms success/failure clearly
- [ ] No data loss if close fails
- [ ] Safe timeout/retry behavior for automation hooks
- [ ] `npm run typecheck:web` passes

**Feedback Loop:**
Setup: run review from pi session and keep pi input focused

Verification:
1. Click Finish Review with open comments → pi input receives pasted payload.
2. Simulate blocked automation permission → warning appears; manual paste works from clipboard.
3. Verify tab/window closes only after copy succeeds.
4. Confirm payload integrity by comparing pasted text with preview.

Edge cases:
- Empty open-comments set prompts explicit confirmation before closing.
- Clipboard API unavailable fallback works via backend helper.
- Duplicate finish clicks are debounced (single execution).

Regression: `cd extensions/review-hub && npm test`

---

### US-009: Data model/API v2 + migration path

**Description:** As a maintainer, I want a clean v2 data model for text anchors and completion handoff so the rebuild is maintainable.

**BDD Spec:**
- Given old or new review manifests
- When loaded by server/app
- Then data is normalized to v2 with migration/fallback behavior

**Acceptance Criteria:**
- [ ] Define v2 comment anchor schema (quote + context + section fallback)
- [ ] Add migration/normalization from legacy manifests
- [ ] Server endpoints reflect new finish/export flow
- [ ] Backward-compatibility behavior is explicit (where retained)
- [ ] Versioning recorded in manifest metadata
- [ ] `npm run typecheck:web` and backend tests pass

**Feedback Loop:**
Setup: prepare one legacy manifest and one v2 manifest fixture

Verification:
1. Load legacy manifest → app works, anchors degrade gracefully.
2. Load v2 manifest → full anchor/highlight behaviors work.
3. Export/finish works for both fixtures.
4. Run full tests.

Edge cases:
- Corrupt anchor block handled with non-fatal warning.
- Unknown schema version rejected with actionable error.
- Migration does not mutate original source unexpectedly.

Regression: `cd extensions/review-hub && npm test`

---

## 4) Functional Requirements

- FR-1: System must render PRD/design markdown with stable section mapping.
- FR-2: System must support Read and Review modes with clear layout differences.
- FR-3: System must allow creating comments from a single selected text range.
- FR-4: Selection comment creation must auto-open composer.
- FR-5: Comment anchor must include quote text and section reference.
- FR-6: System must support comment CRUD and status (`open`, `resolved`).
- FR-7: Next-unresolved navigation must be available in Review mode.
- FR-8: System must provide optional audio playback with sync toggle.
- FR-9: System must represent audio lifecycle states and expose valid actions.
- FR-10: Export must generate compact markdown optimized for agent consumption.
- FR-11: Default export scope must include only open comments.
- FR-12: Export entries must include selected quote snippets when present.
- FR-13: Anchor drift must fallback to section-level reference with warning.
- FR-14: Finish action must perform copy + close + auto-paste flow.
- FR-15: On automation failure, system must warn and preserve copy for manual paste.
- FR-16: Data model must support v2 anchored comments and migration from legacy data.
- FR-17: All mutation routes must remain localhost-only and token-protected.

---

## 5) Non-Goals (Out of Scope)

- Automated UX heuristic/a11y audit panel in-app
- Real-time multi-user collaboration
- Rich inline text editing of source documents inside the review UI
- Multi-range text selections for one comment
- Non-desktop automation support guarantees beyond primary local pi workflow

---

## 6) Design Considerations

- Visual tone: “charmy but practical” for long-form technical reading
- Prioritize typography, line-length control, and contrast over decorative complexity
- Keep interaction surfaces obvious: TOC, selection/commenting, unresolved nav, finish/export
- Preserve keyboard-friendly flow (shortcuts + predictable focus)
- Avoid anti-patterns:
  - hidden critical actions
  - unreadable low-contrast overlays
  - mode confusion between reading and reviewing
  - verbose export templates that waste tokens

---

## 7) Technical Considerations

- React-first rebuild in `extensions/review-hub/web-app`
- Markdown rendering and section mapping should produce deterministic anchors
- Text anchor strategy should combine:
  - section ID
  - exact quote
  - optional prefix/suffix context for re-matching
- Clipboard + auto-paste likely requires hybrid approach:
  - browser Clipboard API where possible
  - backend/local helper for close/paste automation when needed
- Security constraints:
  - mutation endpoints remain token-gated
  - localhost-only server binding
  - sanitize rendered HTML and exported payload

---

## 8) Success Metrics

- SM-1: Reviewer can complete first meaningful comment from text selection in under 10 seconds.
- SM-2: 0 blocking UI failures during a full review on 20+ section PRD.
- SM-3: Export payload is at least 30% shorter than current verbose format while preserving actionability.
- SM-4: Finish flow succeeds end-to-end (copy+close+paste) in primary desktop/pi setup with clear fallback on failure.
- SM-5: No regression in existing server security constraints.

---

## 9) Open Questions

- OQ-1: Exact OS-level mechanism for auto-paste into pi (AppleScript, accessibility APIs, or pi-side hook).
- OQ-2: Should finish flow be atomic from backend (single `/finish` endpoint) or client-orchestrated with retries?
- OQ-3: Preferred max quote length in exported markdown for best token efficiency.
- OQ-4: Should unresolved comments be sorted by document order or creation time in export (default recommendation: document order).
