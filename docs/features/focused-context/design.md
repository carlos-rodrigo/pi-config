# Focused Context — Design

> PRD: `docs/features/focused-context/prd.md`

## Architecture Overview

Focused Context adds a generic topic-brief system to pi-config so agents can start short sessions with the right durable context, refresh that context cheaply, and know when to move to a fresh session.

### Core pieces

1. **Focused Context extension**
   - Owns topic detection, active brief selection, freshness, drift heuristics, and session recommendations
   - Publishes lightweight status and integrates with existing handoff/session-query/dumb-zone behavior

2. **Brief store**
   - Discovers briefs from project-local `.pi/briefs/` and global `~/.pi/agent/briefs/`
   - Resolves project-local override over global briefs
   - Preserves user-maintained notes when refreshing a brief

3. **Brief engine**
   - Ensures a usable brief exists for a task
   - Refreshes briefs from bounded sources: docs, code hot files, current session, latest handoff
   - Produces compact slices for context injection instead of full-file dumps

4. **Drift monitor**
   - Observes read/grep/find/bash exploration loops and topic shifts
   - Marks briefs stale for reasons T/C/R/H (time/session drift, code changes, repeated rereads, handoff/task transition)
   - Suggests a fresh session before quality degrades

5. **Transition adapter**
   - Preserves active brief context across compaction and handoff
   - Carries only brief identity + recent delta into the next session
   - Leaves deeper ancestry lookup to explicit `session_query`

---

## Architectural Decisions

### 1) Extension name and packaging

V1 ships as a new extension:

```text
extensions/focused-context/
```

This keeps the feature generic and reusable across repositories while still allowing targeted integration with `dumb-zone`, `handoff`, and `session-query`.

### 2) Brief storage locations

Briefs are discovered from both scopes:

```text
<project>/.pi/briefs/*.md
~/.pi/agent/briefs/*.md
```

Resolution rules:
- Project-local wins over global on topic name collision
- Global briefs provide reusable baseline knowledge
- Project-local briefs carry repo-specific hot files, commands, and constraints

### 3) One active brief per session

V1 keeps exactly one active brief at a time.

Why:
- prevents context inflation from multi-brief merges
- forces a bounded task/topic lens
- keeps topic detection, freshness, and injection logic simple and testable

If multiple briefs are plausible, Focused Context will not auto-prepare; it will fall back to suggestive behavior or require explicit pinning/ensure.

### 4) Brief file format: markdown with lightweight frontmatter

V1 uses self-describing markdown files with a small machine-readable header.

Example shape:

```md
---
topic: billing
aliases:
  - invoices
  - invoice-export
scope: project
updatedAt: 2026-04-10T00:00:00Z
hotFiles:
  - src/billing/export.ts
  - src/billing/export.test.ts
hotDocs:
  - docs/playbooks/billing.md
---

# Billing

## Objective
...

## Stable Facts
...

## Hot Files
...

## Common Commands
...

## Gotchas
...

## Open Questions
...

## Next Slice
...

## Manual Notes
...
```

Why frontmatter instead of a sidecar registry:
- simpler discovery and portability
- no required central index to keep in sync
- easy to inspect/edit by humans
- enough structure for matching, freshness, and refresh selection

### 5) Manual notes preservation contract

Refresh does not overwrite the whole brief.

V1 reserves one heading:

```md
## Manual Notes
```

The brief engine preserves that section across refreshes. Generated sections are replaced; manual notes stay intact.

### 6) State persistence via extension entries, not LLM context

Session/runtime state that should not consume model context is stored via `pi.appendEntry(...)`.

Tracked state includes:
- active topic
- pinned topic override
- last ensure/refresh time
- staleness reasons
- repeated-reread counters
- last recommendation timestamp
- latest handoff-linked brief metadata

Why:
- survives reloads/restarts
- avoids leaking operational state into the agent context window
- aligns with existing pi extension patterns

### 7) Helper-model-first refresh strategy

Brief refresh uses an ordered helper-model strategy:
- prefer a cheaper/faster helper model
- fall back to the current active model if no helper model is available/authenticated

This applies to:
- brief creation
- stale brief refresh
- bounded recon summaries
- brief-aware compaction when custom summarization is needed

### 8) Automatic source boundary

V1 automatic brief generation/refresh can use:
- relevant docs/playbooks
- hot files from the brief or detected work area
- current session context
- latest handoff context

V1 will **not** auto-query deeper session ancestry.
Older sessions remain an explicit user/agent action through `session_query`.

### 9) Session recommendation behavior = suggest + prefill

When drift heuristics or context quality signals fire, V1:
- suggests starting a fresh session
- prefills the editor with a `/handoff ...` command containing the right goal
- does **not** auto-handoff

Why:
- keeps the human in control
- reuses the existing handoff extension path
- avoids surprising session switches during active work

### 10) Status contract

Focused Context publishes a compact extension status, e.g.:

```text
brief:billing · fresh
brief:auth · stale:R,C
new-session?
```

This uses the normal extension status surface so it can appear in bordered-editor without new UI primitives. V1 keeps the string compact to avoid crowding the footer/editor border.

---

## Data and Control Flow

### Brief discovery and selection

1. Scan project-local brief directory
2. Scan global brief directory
3. Merge by topic key with project-local precedence
4. Build a topic index from:
   - topic id
   - aliases
   - hot file paths
   - brief title
5. Resolve the active brief using this order:
   - explicitly pinned topic
   - session-restored active topic
   - clear match from current user input/task
   - no active brief if ambiguous

### Auto-prepare before a turn

On `input` / `before_agent_start`:
1. detect clear topic match
2. load brief metadata and freshness state
3. if missing or stale, run brief ensure/refresh
4. generate a compact topic slice
5. inject the slice into the turn context

If matching is ambiguous:
- skip auto-refresh
- optionally surface a suggestive status or steer the agent to `brief_ensure`

### Brief ensure / compact recon

The primary tool path is one idempotent operation:

```text
brief_ensure(topic?, task, refreshPolicy?)
```

Responsibilities:
- select or infer a topic
- create a new brief if none exists
- refresh if stale or explicitly requested
- return a compact task-relevant slice
- optionally include bounded recon output (relevant files, small snippets, common commands, gotchas)

This avoids giving the model too many overlapping tools.

### Drift and staleness monitoring

Focused Context listens to tool activity and session changes.

Signals:
- **T**: time/session drift since last refresh
- **C**: changes in hot files/docs since refresh
- **R**: repeated read/grep/find/bash exploration loops
- **H**: handoff started or major task/topic transition

When stale:
- update brief status
- steer toward `brief_ensure` when appropriate
- prepare fresh-session recommendation when quality is degrading

### Fresh-session recommendation

When heuristics indicate the task is drifting or the session is getting too heavy:
- set status to a recommendation state
- prefill the editor with a `/handoff <goal>` command
- notify the user why a fresh session is recommended

The `/handoff` goal focuses on:
- active topic
- what changed since the last fresh brief
- next bounded slice

### Handoff continuity

When handoff runs:
- current active topic and stale/fresh state are persisted as extension state
- latest handoff metadata becomes available as a refresh source for the next session
- the next session restores active-topic awareness without forcing a deep session replay

### Compaction continuity

When compaction runs with an active brief:
- preserve the brief identity and compact slice in the post-compaction context
- summarize only the recent delta instead of expecting the model to rediscover durable topic facts
- keep brief metadata in extension state/details so refresh logic stays consistent after compaction

---

## Module Breakdown

### Module: Focused Context Extension

Responsibilities:
- register commands and the primary tool
- manage active brief selection
- wire event hooks (`input`, `before_agent_start`, `context`, `tool_call`, `turn_end`, `session_before_compact`, session events)
- publish status
- send session recommendations

### Module: Brief Store

Responsibilities:
- discover project/global brief files
- parse frontmatter + markdown sections
- merge local/global views
- write refreshed briefs
- preserve `## Manual Notes`

Extract pure helpers for:
- frontmatter parsing/serialization
- section replacement
- topic discovery precedence

### Module: Topic Matcher

Responsibilities:
- identify clear matches from user input and explicit pins
- score topic ids/aliases against prompt text
- avoid false-positive auto-prep when multiple topics are plausible

V1 matching strategy is intentionally simple and deterministic.

### Module: Brief Engine

Responsibilities:
- create and refresh briefs
- select bounded sources
- assemble helper-model prompt
- return compact topic slice
- support manual `/brief-refresh` and agent `brief_ensure`

### Module: Drift Monitor

Responsibilities:
- observe exploration-heavy tool patterns
- track rereads of the same files or clusters
- compute stale reasons T/C/R/H
- decide when to suggest refresh vs fresh session

### Module: Transition Adapter

Responsibilities:
- integrate with `handoff` and `HANDOFF_SESSION_STARTED_EVENT`
- integrate with custom compaction hooks
- persist/restore active brief state across sessions
- keep deeper history access explicit via `session_query`

---

## Commands and Tool Surface

### Commands

V1 manual controls:
- `/brief` — show the active brief and freshness summary
- `/brief-pin <topic>` — pin a topic for this session
- `/brief-refresh [topic]` — force refresh of the active or named topic
- `/brief-list` — list available topics and freshness state

No `/brief-new` in v1.
Creation happens through ensure/refresh.

### Tool

Primary agent-callable tool:
- `brief_ensure`

High-level contract:
- input: task, optional topic, optional refresh policy
- output: active topic, freshness state, compact topic slice, optional recon hints

V1 keeps compact recon behind the ensure path instead of introducing a second mandatory tool.

---

## Integration Plan with Existing Extensions

### dumb-zone

Focused Context does not replace dumb-zone.

Integration contract:
- dumb-zone continues to monitor raw context percent / quality thresholds
- focused-context monitors task drift and reread loops
- both can publish status, but focused-context uses compact strings
- if dumb-zone says “dumb” and focused-context also sees drift, the recommended handoff goal should include the active topic and latest brief delta

### handoff

Focused Context reuses existing handoff flow instead of inventing a new one.

Integration contract:
- recommendations prefill `/handoff ...` in the editor
- handoff packets inherit active topic framing via the goal text
- handoff session-start events restore active-topic/session metadata on the next session

### session-query

Focused Context treats session-query as an explicit deep-history escape hatch.

Integration contract:
- automatic refresh may use current session + latest handoff only
- if the agent truly needs older history, it can call `session_query`
- focused-context may steer the agent toward session-query when a brief says older decisions are required but not locally present

---

## Testing Strategy

Follow `docs/playbooks/pi-extension-testing.md`.

### Pure-helper coverage

Extract and test pure helpers for:
- brief discovery precedence (project vs global)
- frontmatter parsing and serialization
- manual-notes preservation
- topic matching and ambiguity detection
- stale reason calculation (T/C/R/H)
- repeated-reread detection
- compact slice generation and truncation
- handoff-goal prefilling

### Extension behavior tests

Use minimal mocks for:
- command registration
- tool registration
- status publishing
- `pi.appendEntry(...)`
- `pi.sendMessage(...)`
- event-driven recommendation behavior

### Focused regressions

Add tests to ensure:
- ambiguous topic matches do not auto-refresh
- local brief overrides global brief
- refresh preserves `## Manual Notes`
- helper model fallback uses active model when needed
- repeated exploration loops trigger stale/recommend flows only once per window
- compaction/handoff restoration does not lose active topic state

---

## Vertical Slices

---

## Phase 1: Brief Foundation and Manual Flow

**User stories**: US-002, US-006

### What to build

Create the reusable brief foundation: extension scaffold, brief discovery, markdown/frontmatter format, manual commands, helper-model refresh, single active-topic state, and lightweight freshness status.

This slice should let a user:
- discover available briefs
- pin one topic
- create/refresh it
- inspect it
- see whether it is fresh or stale

### Acceptance criteria

- [ ] Project-local and global briefs are both discoverable, with local override
- [ ] `/brief`, `/brief-pin`, `/brief-refresh`, and `/brief-list` work end-to-end
- [ ] Refresh can create a missing brief
- [ ] Refresh preserves `## Manual Notes`
- [ ] Active topic and freshness status survive reloads via extension state

---

## Phase 2: Automatic Ensure and Context Injection

**User stories**: US-001, US-002, US-003

### What to build

Add the primary agent path: clear-match topic detection, automatic brief preparation before a turn, compact topic-slice injection, and the idempotent `brief_ensure` tool with bounded recon output.

This slice should make a fresh session on a known topic start with the right brief without the user having to invoke commands manually.

### Acceptance criteria

- [ ] Clear topic matches auto-prepare the right brief before the turn starts
- [ ] Ambiguous matches do not auto-refresh
- [ ] `brief_ensure` creates/refreshes briefs and returns a bounded task-relevant slice
- [ ] Refresh sources are limited to docs, hot files, current session, and latest handoff context
- [ ] Injected context is a compact slice, not the entire brief

---

## Phase 3: Drift Monitoring and Fresh-Session Recommendation

**User stories**: US-003, US-004, US-006

### What to build

Add drift heuristics and stale tracking: repeated-reread detection, hot-file change checks, time/session drift, and task-transition detection. When needed, steer the agent to refresh the brief or recommend a fresh session by prefilling `/handoff ...`.

This slice turns the brief system into a workflow assistant, not just a file generator.

### Acceptance criteria

- [ ] Stale reasons T/C/R/H are computed and surfaced in status
- [ ] Repeated exploration loops steer the agent toward `brief_ensure`
- [ ] Major drift can recommend a new session and prefill a `/handoff ...` goal
- [ ] Recommendation is suggestive only; it does not auto-handoff
- [ ] Recommendation behavior integrates cleanly with dumb-zone without replacing it

---

## Phase 4: Handoff and Compaction Continuity

**User stories**: US-005

### What to build

Integrate focused-context with transition mechanics so active topic context survives compaction and handoff. Preserve the active brief identity and recent delta, restore it in the next session, and keep older-history retrieval explicit through session-query.

This slice completes the short-session workflow: brief → work → recommend handoff → new session starts with the right durable context.

### Acceptance criteria

- [ ] Active brief identity survives handoff and can be restored in the next session
- [ ] Latest handoff context becomes an automatic source for the next brief refresh
- [ ] Brief-aware compaction preserves durable topic context and summarizes only recent delta
- [ ] Deeper session ancestry is still queried explicitly through `session_query`, not automatically
- [ ] New sessions resume with better first-turn context on the same topic

---

## Risks and Mitigations

### Risk: Over-eager auto-refresh increases token usage
Mitigation:
- only auto-refresh on clear matches
- helper-model-first refresh
- bounded recon source counts and output caps
- ambiguous matches fall back to suggestion/pinning

### Risk: Status noise crowds bordered-editor
Mitigation:
- keep status strings compact
- publish recommendation status only when actionable
- preserve dumb-zone as the core quality-warning status when needed

### Risk: Topic matching is too weak or too eager
Mitigation:
- deterministic alias-based matching in v1
- explicit pin override
- ambiguous/no-match path does nothing automatically

### Risk: Brief refresh erases user-authored knowledge
Mitigation:
- preserve `## Manual Notes`
- replace only generated sections
- test round-trip parsing and writes thoroughly

### Risk: Transition integration becomes brittle
Mitigation:
- reuse existing `handoff` command/tool path instead of replacing it
- keep session ancestry access explicit via `session_query`
- use persisted extension state and existing session-start events

---

## Open Questions

- Should focused-context status always be visible, or only when stale/recommending?
- Should hot-file change detection rely on git state, file mtimes, or whichever signal is available first?
- Should helper-model selection be configurable in v1 or hard-coded with fallback order?
