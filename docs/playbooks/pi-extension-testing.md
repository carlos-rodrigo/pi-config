# Testing Pi Extensions

> When to use: Writing or running tests for pi extensions.

## Overview

Extension tests use Node's built-in test runner (`node --test`) with TypeScript type stripping. Tests live alongside source in each extension directory. The pattern emphasizes pure helper extraction for testability without needing DOM or full runtime mocks.

## Patterns

### Test runner setup

```json
// package.json
{
  "scripts": {
    "test": "node --test extensions/*/test/*.test.ts",
    "test:my-ext": "node --test extensions/my-ext/test/*.test.ts"
  }
}
```

Run with `npm test` (all) or `npm run test:my-ext` (single extension).

### ESM `.js` import workaround

Extension modules using bundler-style `.js` imports in source won't resolve directly under `node --test`. Compile the `.test.ts` entrypoint to a temp directory with `tsc --outDir` and execute the emitted JS:

```bash
tsc --outDir /tmp/test-build extensions/my-ext/test/helpers.test.ts
node --test /tmp/test-build/test/helpers.test.js
```

### Mock patterns for pi API

```typescript
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

const mockCtx = {
  setStatus: mock.fn(),
  sendMessage: mock.fn(),
  registerTool: mock.fn(),
};
```

Keep mocks minimal — only mock what the test actually exercises.

### Extract pure helpers for testability

When extension UI is rendered as inline HTML/JS, lift payload builders and mode-specific logic into exported pure helpers. This makes `tsc → node --test` coverage practical without a DOM harness.

```typescript
// Pure helper — testable
export function buildExportPayload(comments: Comment[], mode: "pr" | "doc") {
  // ...
}

// Browser script uses the helper
// Tests import and validate directly
```

### TDD with sub-agents

When using sub-agents for implementation, write test expectations first in the parent agent, then delegate implementation to the sub-agent with the test file as context.

## Constraints

- Tests must pass with `node --test` — no additional test frameworks
- Each extension's tests should be runnable independently
- Don't mock what you can test directly — prefer pure function extraction

## Gotchas

- `node --test` with TypeScript requires Node 22+ (type stripping support)
- Import paths in tests must match the module resolution strategy — `.js` extensions in ESM source won't resolve without the compile workaround
- `mock.fn()` from `node:test` resets between tests automatically in `describe` blocks, but not between top-level `it` calls
