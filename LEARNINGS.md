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
