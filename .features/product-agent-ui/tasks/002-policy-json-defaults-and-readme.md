---
id: 002
status: done
depends: [001]
parent: null
created: 2026-02-19
---

# Implement policy service with JSON config, defaults, and README documentation

Add policy loading from `.pi/product-agent-policy.json` with strict built-in defaults and validation fallback behavior.

## What to do

- Create `policy-service.ts` with schema/type validation.
- Implement load order: project JSON -> built-in defaults.
- On invalid JSON/schema, fallback to defaults and expose warning state.
- Add README section documenting:
  - file path
  - JSON schema
  - built-in default config
  - examples
  - reload behavior

## Acceptance criteria

- [ ] Missing policy file uses strict built-in default policy.
- [ ] Valid policy file overrides defaults.
- [ ] Invalid policy file falls back safely and exposes warning to UI.
- [ ] README contains policy config documentation with example JSON.
- [ ] `npm run typecheck` passes.

## Files

- `extensions/product-agent-ui/services/policy-service.ts`
- `README.md`

## Verify

```bash
npm run typecheck
```
