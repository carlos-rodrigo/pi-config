# Focused Context — PRD

## Problem

Pi sessions get expensive and less reliable when work stays in one long thread. Agents repeatedly reread the same files, drag too much stale context forward, and start new sessions without a compact, durable understanding of the current topic. Existing extensions help with handoff and context monitoring, but there is no reusable system for topic briefs, compact recon, freshness tracking, and phase-aware nudges across any project.

## Goals

1. **Durable topic briefs** — maintain compact topic-level context outside the live session history
2. **Automatic brief preparation** — detect clear topic matches and auto-prepare the right brief before the turn starts
3. **Compact recon** — provide a read-only tool that can create or refresh a brief from docs, code hot files, and the current session/latest handoff
4. **Short-session support** — detect when work is drifting or context is degrading and recommend a fresh session with a prefilled handoff prompt
5. **Freshness tracking** — mark briefs stale when age, relevant file changes, repeated recon loops, or major task transitions indicate drift
6. **Context transfer integration** — preserve the active brief through compaction and handoff flows
7. **Reusable package design** — make the system generic so it works for any topic and any project, not just one integration area

## Non-goals

- Building a vector store, semantic search index, or knowledge graph
- Full session/thread map UI in v1
- Auto-handoff without user review in v1
- Injecting multiple briefs into a session at once by default
- Automatically querying deep session ancestry beyond the current session and latest handoff context
- Replacing existing handoff, session-query, or dumb-zone extensions entirely

## Users

- **Primary:** Pi users working on multi-step coding tasks across several short sessions
- **Secondary:** Agents that need to start a new task with high first-turn accuracy and minimal redundant exploration

## User Stories

### US-001: Auto-prepare a single active brief for a clear topic

**As a** Pi user,
**I want** the agent to start with the most relevant topic brief when my task clearly matches one,
**so that** new sessions do not begin with redundant rereading.

**Given** a project with available briefs and a user request that clearly matches one topic
**When** a new agent turn starts
**Then** the system selects one active brief, refreshes it if needed, and injects only the relevant brief slice into context

**Acceptance Criteria:**
- [ ] V1 supports exactly one active brief per session by default
- [ ] Briefs can live in both project-local `.pi/briefs/` and global `~/.pi/agent/briefs/`
- [ ] Project-local briefs override global briefs with the same topic name
- [ ] Auto-preparation only runs for clear topic matches; uncertain matches fall back to suggestive behavior
- [ ] Injected content is a compact topic slice, not the entire brief file

---

### US-002: Ensure and refresh a topic brief from bounded sources

**As an** agent,
**I want** one idempotent way to get a usable brief for the current task,
**so that** I do not need to decide between many separate briefing commands.

**Given** a topic request or task description
**When** the agent calls the brief tool
**Then** the system returns a usable brief, creating or refreshing it first if missing or stale

**Acceptance Criteria:**
- [ ] V1 exposes one primary read-oriented tool for the agent (for example `brief_ensure`)
- [ ] The tool can create a missing brief and refresh a stale brief
- [ ] Brief refresh may use docs, code hot files, and current session + latest handoff context
- [ ] Older session history is not auto-queried in v1; deeper history remains an explicit action via existing tooling
- [ ] Brief generation uses a cheaper helper model by default, with fallback when unavailable
- [ ] Refresh preserves a dedicated manual-notes section instead of overwriting the whole file

---

### US-003: Run compact recon instead of repeated exploration loops

**As an** agent,
**I want** a bounded recon path that summarizes the most relevant files and commands for a task,
**so that** I can avoid long grep/read/find loops.

**Given** a task question for a topic
**When** the agent needs codebase recon
**Then** it can request a compact structured result instead of manually stitching together many tool turns

**Acceptance Criteria:**
- [ ] V1 provides a compact recon flow through the primary brief tool or a closely related helper path
- [ ] Recon output is read-only and size-capped
- [ ] Recon prefers relevant files, small snippets, common commands, and gotchas over full-file dumps
- [ ] Recon results can be used to seed or refresh the brief
- [ ] The system can detect repeated exploration loops and suggest using the brief flow

---

### US-004: Recommend a fresh session before quality degrades

**As a** Pi user,
**I want** the system to recommend a new session when the current one is getting unfocused or too heavy,
**so that** I can switch threads before quality and token efficiency collapse.

**Given** an active session with an identified topic
**When** the system detects context degradation or a major task transition
**Then** it suggests a new session and prepares a handoff prompt instead of auto-handing off immediately

**Acceptance Criteria:**
- [ ] V1 supports “new session recommended” behavior as suggest + prefilled handoff prompt
- [ ] Trigger signals include age/session drift, relevant file changes, repeated rereads/recon loops, and major task transitions
- [ ] Recommendation integrates with existing `handoff` behavior instead of replacing it
- [ ] The system does not auto-handoff in v1

---

### US-005: Preserve active brief context across compaction and handoff

**As an** agent user,
**I want** durable topic context to survive compaction and handoff,
**so that** new sessions keep the important brief and only pass a small recent delta.

**Given** a session with an active brief
**When** the session compacts or hands off
**Then** the active brief remains available and the transferred context focuses on what changed recently

**Acceptance Criteria:**
- [ ] Compaction preserves active brief context rather than forcing it to be rediscovered from scratch
- [ ] Handoff packets include active brief identity and relevant delta context
- [ ] Latest handoff context can be used as an automatic source when refreshing the next brief
- [ ] V1 integrates with `handoff`, `session-query`, and `dumb-zone`

---

### US-006: Show brief state and offer lightweight manual controls

**As a** Pi user,
**I want** simple commands and visible freshness state,
**so that** I can inspect, pin, or refresh the active brief without leaving the flow.

**Given** a project using the focused-context system
**When** I want to inspect or control briefing behavior
**Then** I can use a small set of commands and see whether the current brief is fresh or stale

**Acceptance Criteria:**
- [ ] V1 includes `/brief`, `/brief-pin`, `/brief-refresh`, and `/brief-list`
- [ ] V1 does not require a separate `/brief-new`; creation can happen through the ensure/refresh path
- [ ] The system exposes freshness state and active topic in a lightweight status surface
- [ ] Briefs track staleness based on time/usage drift, relevant file changes, repeated rereads, and handoff/task transitions

## Functional Requirements

- FR-1: The system must store briefs in both project-local and global locations, with project-local override semantics.
- FR-2: The system must support one active brief per session in v1.
- FR-3: The system must detect clear topic matches from user input and/or active task context.
- FR-4: The system must auto-prepare a brief before the turn starts when there is a clear topic match.
- FR-5: The system must expose a primary agent-callable tool that ensures a usable brief exists for a task.
- FR-6: The system must support brief refresh from docs, code hot files, and current session + latest handoff context.
- FR-7: The system must preserve a manual-notes section during brief refresh.
- FR-8: The system must track brief freshness and mark briefs stale using age/session drift, relevant file changes, repeated rereads/recon loops, and handoff/task transitions.
- FR-9: The system must support a bounded, read-only compact recon path with hard output caps.
- FR-10: The system must detect repeated exploration behavior and steer the agent toward the brief path.
- FR-11: The system must recommend a new session via suggestion + prefilled handoff prompt, not auto-handoff, in v1.
- FR-12: The system must preserve active brief context through compaction and handoff flows.
- FR-13: The system must integrate with `dumb-zone`, `handoff`, and `session-query` in v1.
- FR-14: The system must use a cheaper helper model for brief generation/refresh by default, with graceful fallback.
- FR-15: The system must provide `/brief`, `/brief-pin`, `/brief-refresh`, and `/brief-list` manual controls.

## Modules

| Module | Responsibility | New or Modified |
|--------|---------------|-----------------|
| Focused Context Extension | Own topic detection, brief preparation, staleness, commands, and steering behavior | New |
| Brief Store | Resolve project/global brief locations, load/write files, preserve manual sections | New |
| Brief Engine | Ensure/create/refresh briefs and generate compact topic slices | New |
| Compact Recon Layer | Build bounded recon outputs from docs, hot files, and current session/latest handoff | New |
| Session Transition Adapter | Integrate with handoff and compaction flows to carry brief + delta | Modified / integrated |
| Context Drift Signals | Integrate with dumb-zone and tool-call observation to recommend fresh sessions | Modified / integrated |
| Status Surface | Publish active topic and freshness state for lightweight UI visibility | New |

## Design Principles

- **One active brief, not many** — v1 optimizes for clarity and bounded context
- **Automatic when obvious, suggestive when uncertain** — avoid expensive false-positive refreshes
- **Durable knowledge lives outside the thread** — live sessions should carry delta, not full history
- **One primary tool** — prefer an idempotent `ensure` path over many overlapping briefing tools
- **Refresh is bounded** — source selection and output size must stay capped to protect context economy
- **Manual notes survive automation** — refresh should not erase user-maintained insights

## Out of Scope for V1

- Multi-brief active context merging
- Visual session/thread graph or cluster map
- Deep automatic mining of older session ancestry
- Auto-handoff without user confirmation/review
- Cross-project shared taxonomy or remote brief sync
- Vector retrieval or semantic indexing infrastructure

## Success Criteria

- Noticeable reduction in repeated reads of the same files within a workstream
- Fewer long sessions that continue after context has clearly degraded
- Better first-turn accuracy when starting a new session on an existing topic
- Brief refresh becomes the default path for durable topic context instead of ad hoc rereading
- Handoff and compaction preserve focused topic state with less manual repair work

## References

- Existing pi-config work: `docs/features/context-engineering/*`
- Amp note: “200k Tokens Is Plenty” — short threads, selective context transfer, one-task-per-thread workflow
- HumanLayer context engineering references already captured in `docs/features/context-engineering/prd.md`

## Open Questions

- [ ] Should brief freshness be displayed in `bordered-editor`, a dedicated status key, or both?
- [ ] Should compact recon exist as a separate explicit tool in v1, or stay behind the primary ensure path until needed?
- [ ] Should the brief file format be pure markdown, or markdown with a small machine-readable metadata header?
