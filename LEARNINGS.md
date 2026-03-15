## Extensions: Cross-platform external launcher pattern

**Date:** 2026-03-05
**Context:** Implementing `/review` command scaffolding with browser launch support.
**Learning:** Keep platform-specific launcher attempts in a shared helper (`extensions/lib/open-external.ts`), catch per-attempt execution failures, and return a user-runnable fallback command for recovery.
**Applies to:** Any extension that needs to open URLs/files externally from Pi commands.

## Extensions: Safer file target validation for command inputs

**Date:** 2026-03-05
**Context:** Validating `/review <path>` inputs before launching review flow.
**Learning:** Prefer `fs.promises.lstat()` with explicit `ENOENT` handling and symlink rejection over `existsSync + statSync` to avoid race windows and extension-based bypasses.
**Applies to:** Future command handlers that accept local file paths.

## UI Rendering: Treat third-party SVG output as untrusted

**Date:** 2026-03-06
**Context:** Rendering Mermaid diagrams from markdown code fences in the document reviewer web UI.
**Learning:** Even when using a trusted renderer, parse and sanitize returned SVG before inserting into the DOM; keep a per-block fallback source path so diagram failures degrade locally without breaking the surrounding document.
**Applies to:** Any extension UI that renders generated SVG/HTML from user-controlled markdown or code blocks.

## UI Interaction: Separate key intent from DOM effects

**Date:** 2026-03-06
**Context:** Implementing Vim-style navigation and visual mode in the document reviewer UI.
**Learning:** A pure keymap resolver (`event + mode -> action`) combined with a focused selection controller keeps keyboard behavior easy to test and prevents state drift between mode badges, scrolling, and DOM selection state.
**Applies to:** Future keyboard-heavy extension UIs (reviewers, viewers, terminal-like overlays).

## Reviewer UX: Preserve in-flight input across panel rerenders

**Date:** 2026-03-06
**Context:** Adding threaded comments and replies in the document reviewer side panel.
**Learning:** If a panel re-renders via `innerHTML`, keep per-thread reply drafts and error state in keyed maps so pending/error updates don’t wipe user input; update active anchor marker classes in-place when possible instead of rebuilding all anchors.
**Applies to:** Any DOM-rendered sidebar/workflow with optimistic updates and per-item forms.

## Review Anchors: Normalize + re-anchor instead of trusting stored offsets

**Date:** 2026-03-06
**Context:** Persisting threaded comments across markdown edits in sidecar files.
**Learning:** Store a normalized `exact` selector with optional prefix/suffix + offsets, then re-anchor on session load and mark unresolved matches as `stale` rather than dropping threads. This keeps context resilient across minor document edits and backward-compatible with legacy `quote` selectors.
**Applies to:** Any annotation workflow that persists text anchors outside the primary document.

## Reviewer Export UX: Model clipboard flow as explicit state transitions

**Date:** 2026-03-06
**Context:** Implementing End Review export + clipboard fallback for document reviewer comments.
**Learning:** Keep export interactions in a dedicated controller that emits explicit states (`copied`, `manual-copy`, `empty`, `error`) and only clears fallback text on successful/empty outcomes. This prevents accidental loss of manual-copy content during retry failures.
**Applies to:** Any extension workflow that combines async export with clipboard APIs and manual recovery paths.

## Local API Hardening: Pair ephemeral session tokens with centralized fetch helpers

**Date:** 2026-03-06
**Context:** Hardening document-reviewer localhost APIs before final QA.
**Learning:** Require a per-session token on all session-scoped endpoints and inject it via server-rendered bootstrap data; then route every frontend request through one helper that always applies the token header. This closes accidental unauthenticated access gaps while keeping client code maintainable.
**Applies to:** Any localhost extension service exposing session-specific APIs to a browser UI.

## Recovery UX: Keep launch-fallback messaging pure and testable

**Date:** 2026-03-06
**Context:** Improving `/review` behavior when automatic browser launch fails in SSH/headless environments.
**Learning:** Generate fallback guidance in a dedicated pure helper so command handlers can show consistent manual-open + SSH tunnel instructions, and tests can validate copy quality without mocking extension runtime internals.
**Applies to:** Commands that spawn external apps (browser/editor) where launch can fail by environment.

## Extension Testing: Compile ESM TypeScript tests to a temp dir when runtime imports use `.js`

**Date:** 2026-03-15
**Context:** Adding coverage for new `document-reviewer` GitHub adapter helpers in a repo without an existing TS test runner.
**Learning:** For extension modules that use bundler-style `.js` imports in source, run focused tests by compiling the `.test.ts` entrypoint to a temp directory with `tsc --outDir` and then executing the emitted JS with `node --test`.
**Applies to:** Future targeted tests for extension modules in this repo before a dedicated test harness exists.

## Worktree Safety: Reserve a dedicated namespace for automation-owned checkouts

**Date:** 2026-03-15
**Context:** Implementing deterministic PR review worktrees for `/review-pr`.
**Learning:** Automation-owned worktrees should live under a dedicated reserved root (for example `<repo>-pr-review-worktrees/pr-<n>`) and cleanup should derive that path from validated metadata, not trust arbitrary caller-provided paths. This prevents collisions with user-created worktrees and reduces accidental deletion risk.
**Applies to:** Future git worktree automation, cleanup helpers, and any feature that recreates deterministic workspace paths.
