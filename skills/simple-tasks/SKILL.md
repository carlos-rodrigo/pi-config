---
name: simple-tasks
description: "Project-local task management in .features/{feature}/tasks/. Use when creating, listing, or updating compact agent-readable task briefs with feedback loops. Triggers on: create tasks, list tasks, task status, task briefs."
compatibility: "Task validation requires Node.js 18 or newer. Approved-design authorization also requires installed html-report-designer/system-diagram companions and their declared setup."
---

# Simple Tasks

Use tasks only when work needs sequencing, delegation, looping, or resumption. `.features/` is task-loop state, not durable product documentation.

```text
.features/{feature}/tasks/_active.md    # loop progress board and next-task pointer
.features/{feature}/tasks/NNN-title.md  # task brief, lifecycle state, and result
.features/{feature}/artifacts/          # large run artifacts, screenshots, logs when needed
```

Durable context stays outside tasks:

```text
docs/features/{feature}/prd.document.json
docs/features/{feature}/prd.html
docs/features/{feature}/design.document.json
docs/features/{feature}/design.html
docs/adrs/{architecture,api,web}.md
```

## Authority and authorization

Task content must trace to approved authority without silently becoming permission to execute:

- For non-trivial feature work, an Approved design source/report pair supplies acceptance anchors, seam, invariants, accepted decisions, boundaries, proof expectations, and ADR links.
- For a tiny clear change that legitimately skipped durable design, the explicit user request supplies the bounded behavior and proof authority.
- New tasks default to `draft`. An Approved design authorizes task drafting; it does not by itself authorize generated task details for execution.
- A task becomes `ready` only after explicit user authorization. Record `authorized_by`, `authorized_at`, a parseable `authorization_basis`, and the validator-generated `authorization_fingerprint`.
- Use `authorization_basis: "approved-design: docs/features/{feature}/design.document.json"` for non-trivial work or `authorization_basis: "user-request: {bounded request context}"` for a tiny clear/directly approved change.
- The fingerprint binds authorization to Goal, Change, Done, authorization basis, and binding Execute behavior/scope/constraints/invariants. Changed binding content requires renewed user authorization and a new fingerprint.
- A previously authorized task may be restored to `ready` after an agent-owned blocker is removed only when authorization metadata is preserved, upstream authority remains current, the binding task contract is unchanged, and validation passes.

Do not infer or create authorization from completeness, passing checks, prior implementation, or an agent-authored status change.

## Task prompt design

Write the shortest complete contract a fresh agent can execute without chat history. Task text remains below higher-priority instructions, `AGENTS.md`, skills, and safety gates.

- Lead with outcome, smallest slice, and observable done state.
- Keep execution-critical facts; state each instruction once and omit empty fields or generic reminders.
- Link durable sources; summarize any needed chat-only decision in the task.
- Separate advisory navigation from binding behavior, scope, implementation constraints, and invariants.
- A `ready` change/build/fix task authorizes safe in-scope inspection, local edits, and non-destructive checks. Review/diagnose/plan tasks inspect and report unless the brief requests edits. Name only task-specific delegated choices and approval decisions.
- Graph context and code cleanup guidance are execution aids; neither grants authority or changes the task contract.
- Pair checks with setup and expected results; record actual action → observation evidence in `## Result`.
- For implementation tasks, call `task_context_graph` before editing when the relevant surface is unknown. Record its files, relationships, risks, and fingerprint as advisory navigation context, not authorization.
- If generated code needs cleanup, record the bounded cleanup scope and applicable `code-un-slopify` categories in the brief. Cleanup must preserve behavior and be verified separately from the implementation.
- Prefer completeness over a line cap. Split only for multiple behaviors; never remove facts needed for a solo loop run.

---

## Active progress board

For multi-task, delegated, looped, or resumable work, maintain `.features/{feature}/tasks/_active.md`. It is the loop's first-read map of goal, status, current/next task, and blockers—not a duplicate brief.

Minimum shape:

```markdown
# Current Feature: {name}

Started: YYYY-MM-DD

## Goal
- {one sentence}

## Progress
- [ ] TASK-001 — {title} ({status})
- [ ] TASK-002 — {title} ({status})

## Current / Next
- Current: {TASK-... | none}
- Next: {TASK-... | complete | blocked}
- Blockers: {none | ...}
```

Update `_active.md` whenever a task is added, blocked, or completed. Check off a task only after the task's `## Result` records feedback-loop results.

---

## Task template

Use separate `Required behavior` bullets for independent behaviors. Omit only fields explicitly marked optional.

```markdown
---
id: TASK-001
status: draft # draft | ready | blocked | done
order: 1
created: YYYY-MM-DD
authorized_by: "{human authorizer; required for ready/blocked/done | omit for draft}"
authorized_at: YYYY-MM-DD # required for ready/blocked/done
authorization_basis: "{approved-design: project-relative design.document.json | user-request: bounded request context}"
authorization_fingerprint: "sha256:{validator-generated binding-contract digest}"
---

# TASK-001 — {verb + object}

## Brief

- Goal: {desired user/system outcome and why it matters}
- Change: {one smallest vertical slice}
- Done: {observable completion state}

## Context

- Source anchors: `{durable path#heading}`; `{path:symbol}`; `{TASK-...#Result}` | no external source; approved brief captured below
- Facts / decisions: {execution-critical requirements not obvious from the anchors, including approved chat-only decisions}
- Depends: {none | TASK-...}

## Execute

- Required behavior: {one observable success/failure behavior; repeat this bullet for each behavior}
- Required implementation: {mandated file/API/pattern/approach; omit when the agent may choose}
- In scope: {specific surfaces and deliverables}
- Out of scope: {adjacent behavior explicitly excluded or deferred}
- Invariants: {existing behavior, compatibility, failure, security, or data property that must remain true}
- Inspect first (advisory, not a required edit): `{path:symbol}`; mirror `{path:symbol}`
- May decide without approval: {specific local choices that preserve Goal, Done, scope, and invariants}

## Feedback loop

- State: {externally observable state to prove}
- Contract: prove each explicit `Goal`, `Change`, `Done`, and binding `Execute` item, or name the blocker and owner
- Setup / repro: {fixture, data, environment, or pre-change failing action | not needed because ...}
- Fast: `{narrow command}` → {expected result}
- User/system: {API/browser/CLI/manual action} → {expected observation}
- Edge: {important boundary/failure case} → {expected result}
- Gate: `{regression command}` → {expected result} | {exception and reason}
- Result: record `action` → actual observation, evidence paths, and skip/blocker reasons in `## Result`

## Escalate if

- Approval required: {task-specific decision and owner | none beyond repository gates}
- Blocked when: {condition not safely repairable within this slice}

## Notes

{Optional information that prevents rediscovery or a likely mistake}
```

Optional detail sections: `## Investigation`, `## Fixtures / setup`, `## Rollback`, `## Local alternatives rejected`.

## Loop-ready detail floor

Before setting `status: ready`, run the **fresh agent readiness check**: can an agent derive the implementation checklist and execute the feedback loop without chat history, broad rediscovery, or invented product behavior?

## Are You Proud review gate

After generating or materially revising a task brief and before presenting it as complete, load `are-you-proud` and review the task, its authority/authorization boundary, execution contract, feedback loop, and stopping scope using that skill's rubric.

Resolve every finding from the review, then run `are-you-proud` again. Repeat the repair-and-review cycle until it reports no findings. Do not stop at “mostly proud” while actionable findings remain. If a finding requires user authority, changes the approved contract, or cannot be repaired safely in scope, keep the task `draft` or `blocked`, record the finding and owner, and ask for input rather than claiming a clean result.

Record the final review outcome in the task or handoff. For authorized completed tasks, the `## Result` receipt must state the review iterations and that no findings remained.

- Source anchors open directly. Non-trivial work links an Approved design and tiny clear work captures the explicit user request; never rely on chat history.
- `authorized_by`, `authorized_at`, `authorization_basis`, and `authorization_fingerprint` record explicit user authorization before `ready`; completeness alone is insufficient.
- For `approved-design`, the validator confirms Approved JSON authority and that the adjacent HTML embeds the same canonical DocumentSpec.
- Every required user/system behavior is a separate bullet, including material failure behavior.
- In-scope surfaces, adjacent non-goals, and invariants make the stopping boundary explicit.
- Inspection anchors name likely files and symbols plus a nearby pattern when one exists; they do not mandate edits.
- Verification names setup/reproduction, the narrow check, user/system observation, important edge, regression gate, and expected result for each.
- No unresolved placeholders, `TBD`, critical “as needed,” or product decisions remain. Keep such tasks `draft` or `blocked` with an owner.

---

## Status semantics

- `draft` — not authorized for execution.
- `ready` — explicitly user-authorized and executable.
- `blocked` — previously authorized execution stopped with a complete blocked Result. Work still waiting on upstream authority remains `draft` and records the blocker on `_active.md`.
- `done` — authorized implementation complete and `## Result` records feedback-loop results.
- Legacy `open` may be treated as `ready` only when the brief is executable and contains equivalent explicit authorization evidence.

## Ready gate

`ready` means explicit user authorization, the loop-ready detail floor, upstream authority checks, and the fresh agent readiness check all pass. Use `feedback-loop` to tighten proof; otherwise keep the task `draft` or `blocked`.

After the user authorizes the final binding task content, resolve this loaded skill's directory, generate the fingerprint, write it to frontmatter, and validate:

```bash
node "<simple-tasks-dir>/scripts/validate-task.mjs" --fingerprint \
  .features/{feature}/tasks/NNN-title.md
node "<simple-tasks-dir>/scripts/validate-task.mjs" \
  .features/{feature}/tasks/NNN-title.md \
  .features/{feature}/tasks/_active.md
```

Run the same validator after writing a `done` or `blocked` Result and synchronizing `_active.md`. A validation failure keeps the task non-executable or incomplete.

---

## Operations

```bash
# List task briefs
ls -1 .features/{feature}/tasks/*.md 2>/dev/null | grep -Ev '(_active|README)'

# Find executable task briefs
grep -El "status: (ready|open)" .features/{feature}/tasks/*.md 2>/dev/null | grep -v '/_active\.md$'

# Validate one task and its active board through the installed skill
node "<simple-tasks-dir>/scripts/validate-task.mjs" \
  .features/{feature}/tasks/NNN-title.md \
  .features/{feature}/tasks/_active.md
```

Create the next task as:

```text
.features/{feature}/tasks/NNN-short-title.md
```

Then add/update the matching line in `.features/{feature}/tasks/_active.md` with its status and checklist state.

Use the exact Result receipt matching terminal state.

Done:

```markdown
## Result

- Status: done
- Changed: `path`, `path` | none
- TDD: acceptance red → inner red/green/refactor → acceptance green | sourced no-op | explicit exception + reason
- Task contract: binding `Goal` / `Change` / `Done` / `Execute` items → satisfied
- Feedback loop: `action` → actual observation; evidence path when applicable
- Gate: `action` → passed
- Review: Are You Proud iterations `{n}` → final review reports no findings | blocked with owner and reason
- Follow-up applied to next task: none | `TASK-002`
```

Blocked after authorized execution starts:

```markdown
## Result

- Status: blocked
- Changed: `path`, `path` | none
- Last failing check: `command/action` → failure summary | not run because ...
- Attempts: count and what changed | 0 because no safe attempt was possible
- TDD state: no acceptance boundary | acceptance red | unit red/green | acceptance still failing | exception
- Blocker owner: user | oracle | environment | upstream
- Gate: skipped because ...
- Needed to unblock: ...
```

If a later task needs information discovered during execution, write it into that task directly instead of creating a separate handoff/report file.
