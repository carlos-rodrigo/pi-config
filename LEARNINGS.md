# LEARNINGS

## Review Hub: Server-owned timestamps for comment mutations

**Date:** 2026-03-02
**Context:** Task 007 (comment status persistence) added resolve/reopen updates through the existing `/comments` upsert route.
**Learning:** Keep `createdAt` and `updatedAt` server-owned to avoid client-side audit drift and inconsistent ordering.
**Applies to:** Any API mutation endpoint that writes lifecycle metadata.

## Review Hub: TypeScript tests for ESM `.js` specifiers

**Date:** 2026-03-02
**Context:** Backend modules use ESM imports ending with `.js` while source files are TypeScript.
**Learning:** Running tests with `tsx --test` avoids module resolution issues that appear with Node strip-types in this setup.
**Applies to:** Extension-level integration tests under `extensions/review-hub/test`.

## Review Hub: Model keyboard workflows as pure helpers

**Date:** 2026-03-02
**Context:** Task 008 added next-unresolved navigation plus a keyboard shortcut.
**Learning:** Put event-gating rules in a pure helper (`shouldHandleNextUnresolvedShortcut`) so shortcuts are testable without browser harnesses and easier to reason about.
**Applies to:** Any feature with global keyboard shortcuts in the React frontend.

## Review Hub: Split audio UX into pure mapping + runtime hook

**Date:** 2026-03-02
**Context:** Task 009 introduced sticky narration playback with section sync.
**Learning:** Keep state derivation in pure helpers (`resolveAudioUxState`, `findSectionAtTime`) and keep media side effects in a dedicated hook (`useAudioSync`) for easier testing and simpler UI components.
**Applies to:** Media/timeline features that combine server metadata with browser playback state.

## Review Hub: Generated HTML controls should use SVG icons, not glyph emojis

**Date:** 2026-03-02
**Context:** Task 010 removed emoji-based controls from the visual generator.
**Learning:** For server-rendered controls, inline SVG icons provide consistent styling, accessibility labeling, and easier compliance checks than Unicode emoji glyphs.
**Applies to:** Any generated HTML UI affordance outside the React component tree.

## Review Hub: Centralize motion variants with reduced-motion fallbacks

**Date:** 2026-03-02
**Context:** Task 011 introduced Framer Motion transitions across shell panels and comment cards.
**Learning:** Shared motion utilities should return both animated and static (reduced-motion) variants so components can opt in consistently without duplicating accessibility logic.
**Applies to:** Any feature adding multi-component animation systems in React.
