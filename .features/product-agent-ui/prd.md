# PRD: Product Agent UI (Pi TUI)

## 1. Introduction / Overview

Create a **Pi TUI-first Product Agent UI** that matches your workflow end-to-end:

1. Plan (PRD)
2. Design
3. Tasks
4. Implement task loop

The goal is to stop "babysitting" by making workflow state, approvals, task status, and autonomous execution visible and controllable from one terminal-native interface.

This feature reframes the current coding assistant into a **product workflow agent** with explicit stage gates and configurable autonomy policy.

## 2. Goals

- Provide a single TUI workspace for PRD, design, tasks, execution, and final review.
- Enforce strict stage approvals by default (configurable later).
- Show tasks in both:
  - a grouped list view ordered by status (`TODO`, `In Progress`, `Done`)
  - a board view with the same statuses.
- Enable autonomous execution mode (`Run loop`) that proceeds until blocked.
- Surface live run visibility (what the agent is doing, where it paused, why blocked).
- Keep markdown artifacts as source of truth in `.features/{feature}`.

## 3. User Stories

### US-001: Stage-aware workflow shell

**Description:** As a product engineer, I want to see and navigate workflow stages (Plan, Design, Tasks, Implement, Review) so I always know current state and next gate.

**BDD Spec:**
- Given: A feature folder exists
- When: I open Product Agent UI
- Then: I see current stage, gate state, and next required action

**Acceptance Criteria:**
- [ ] Stage header displays: `Plan | Design | Tasks | Implement | Review`
- [ ] Current stage is visually highlighted
- [ ] Gate status shown per stage: `Draft`, `Needs Approval`, `Approved`, `In Progress`, `Blocked`, `Done`
- [ ] Stage transition is blocked when required approval is missing
- [ ] `npm run typecheck` passes
- [ ] Verified in interactive Pi TUI session

### US-002: PRD workspace with approval gate

**Description:** As a product engineer, I want to read/edit/approve `prd.md` in TUI so planning is explicit and governed.

**BDD Spec:**
- Given: PRD exists at `.features/{feature}/prd.md`
- When: I open the Plan stage
- Then: I can review content and approve/reject with rationale

**Acceptance Criteria:**
- [ ] PRD content renders in a dedicated workspace panel
- [ ] I can trigger edit flow for PRD from TUI
- [ ] Approval action records approver, timestamp, and decision note
- [ ] Reject action records rationale and keeps stage unapproved
- [ ] Approval state persists across session reload
- [ ] `npm run typecheck` passes
- [ ] Verified in interactive Pi TUI session

### US-003: Design workspace with approval gate

**Description:** As a product engineer, I want to review/edit/approve `design.md` so implementation only starts from approved architecture.

**BDD Spec:**
- Given: Design doc exists at `.features/{feature}/design.md`
- When: I open Design stage
- Then: I can approve/reject and move workflow forward only when approved

**Acceptance Criteria:**
- [ ] Design content renders in workspace panel
- [ ] Edit flow available from TUI
- [ ] Approval metadata stored persistently
- [ ] Cannot move to task execution mode without design approval
- [ ] `npm run typecheck` passes
- [ ] Verified in interactive Pi TUI session

### US-004: Task list view grouped by status (required ordering)

**Description:** As a product engineer, I want a task list grouped by status in this exact order (`TODO`, `In Progress`, `Done`) so I can quickly prioritize and monitor progress.

**BDD Spec:**
- Given: Task files and `_active.md` exist
- When: I open list view
- Then: Tasks are grouped and displayed in required status order

**Acceptance Criteria:**
- [ ] List sections appear strictly in this order: `TODO` → `In Progress` → `Done`
- [ ] All TODO tasks appear under TODO; all in-progress under In Progress; all completed under Done
- [ ] Each task row shows task id/title and current status
- [ ] Empty-state message shown for status sections with no tasks
- [ ] `npm run typecheck` passes
- [ ] Verified in interactive Pi TUI session

### US-005: Task board view with the same statuses

**Description:** As a product engineer, I want a board view in addition to list view so I can choose the visualization I prefer.

**BDD Spec:**
- Given: Tasks exist
- When: I switch to board view
- Then: I see columns `TODO`, `In Progress`, `Done` populated consistently with list view

**Acceptance Criteria:**
- [ ] View toggle exists: `List` / `Board`
- [ ] Board has exactly three columns: `TODO`, `In Progress`, `Done`
- [ ] Task counts per status match list view
- [ ] Board updates after status changes without restart
- [ ] `npm run typecheck` passes
- [ ] Verified in interactive Pi TUI session

### US-006: Autonomous execution mode (Run loop)

**Description:** As a product engineer, I want to run the implement loop autonomously so the agent executes tasks until blocked.

**BDD Spec:**
- Given: At least one task is ready and required gates are approved
- When: I start Run loop
- Then: The agent executes tasks sequentially until completion or a blocking condition

**Acceptance Criteria:**
- [ ] `Run loop` action starts autonomous execution
- [ ] Execution picks next eligible task from task state
- [ ] Stops on blocking conditions (failed checks, missing approvals, explicit uncertainty)
- [ ] Block reason is shown in UI and recorded in run log
- [ ] `npm run typecheck` passes
- [ ] Verified in interactive Pi TUI session

### US-007: Live run console and checkpoint transparency

**Description:** As a product engineer, I want live visibility into agent actions and pause points so I can trust autonomy without constant supervision.

**BDD Spec:**
- Given: Agent is executing
- When: I open run console
- Then: I can see current step, recent actions, and pending checkpoint decisions

**Acceptance Criteria:**
- [ ] Console shows current action summary and recent event timeline
- [ ] Pending checkpoint cards show decision needed and impact
- [ ] Controls available: `Continue`, `Pause`, `Request changes`
- [ ] Run timeline persists across reloads for active feature
- [ ] `npm run typecheck` passes
- [ ] Verified in interactive Pi TUI session

### US-008: Configurable approval policy via JSON (future-proof)

**Description:** As a product engineer, I want strict approval defaults with configurable policy in a JSON file so I can adjust autonomy later without building a dedicated policy UI first.

**BDD Spec:**
- Given: Product Agent UI is configured
- When: I change the policy JSON file
- Then: gate behavior updates according to selected policy

**Acceptance Criteria:**
- [ ] A built-in default policy config exists (strict gate approvals for Plan, Design, Tasks, Implement, Review transitions)
- [ ] If `.pi/product-agent-policy.json` is missing, system uses built-in defaults
- [ ] Policy is loaded from project JSON config when present (no dedicated policy configuration UI in this milestone)
- [ ] Policy changes only affect future transitions unless explicitly re-evaluated
- [ ] A README section documents JSON schema, built-in defaults, and examples
- [ ] `npm run typecheck` passes
- [ ] Verified in interactive Pi TUI session

### US-009: Interactive artifact composition and review

**Description:** As a product engineer, I want to compose/refine PRD, design, and tasks interactively with the agent, then review the resulting files directly.

**BDD Spec:**
- Given: I am in Plan, Design, or Tasks stage
- When: I trigger generate/refine for that artifact
- Then: agent runs an interactive flow, writes markdown files, and I can review them immediately

**Acceptance Criteria:**
- [ ] Stage actions support interactive compose/refine for PRD, design, and tasks
- [ ] Generated/refined output is written to canonical files in `.features/{feature}/`
- [ ] After write, I can review using workspace panel and `/open` (`view`/`diff`/`edit`)
- [ ] Approval is a separate explicit action after review
- [ ] `npm run typecheck` passes
- [ ] Verified in interactive Pi TUI session

### US-010: End-of-feature review

**Description:** As a product engineer, I want a final review view of changed files so I can review what will ship.

**BDD Spec:**
- Given: Work has been executed for a feature
- When: I open Review
- Then: I see changed files and can inspect each before shipping

**Acceptance Criteria:**
- [ ] Review view lists changed files with status (`A`, `M`, `D`)
- [ ] Per file actions available: `View`, `Diff`, `Edit`
- [ ] File actions integrate with existing `/open`/`open_file` behavior
- [ ] A keyboard shortcut in Product Agent UI opens the selected file through the `/open` extension flow
- [ ] Review view includes a compact pre-ship checklist (approvals + quality gates)
- [ ] `npm run typecheck` passes
- [ ] Verified in interactive Pi TUI session

## 4. Functional Requirements

- **FR-1:** System must provide a stage header with the five workflow stages and current state.
- **FR-2:** System must load and display markdown artifacts from `.features/{feature}/` as source of truth.
- **FR-3:** System must support PRD approval and rejection with persistent decision metadata.
- **FR-4:** System must support Design approval and rejection with persistent decision metadata.
- **FR-5:** System must block forward transitions when required approvals are missing under strict policy.
- **FR-6:** System must provide two task visualizations: grouped list and board.
- **FR-7:** Grouped list view must render statuses in exact order: `TODO`, `In Progress`, `Done`.
- **FR-8:** Board view must expose exactly the same three statuses and remain consistent with list view.
- **FR-9:** System must provide autonomous `Run loop` execution over eligible tasks.
- **FR-10:** System must log execution events and block reasons for transparency.
- **FR-11:** System must provide execution controls (`Continue`, `Pause`, `Request changes`) at checkpoints.
- **FR-12:** System must support configurable approval policy loaded from JSON, with strict as default.
- **FR-13:** Workflow and run state must survive session reload/resume.
- **FR-14:** System must include a built-in default policy config used when project policy JSON is absent.
- **FR-15:** System must document policy configuration in README, including file location, schema, built-in defaults, and examples.
- **FR-16:** System must support interactive compose/refine flows for PRD, design, and tasks, writing outputs to `.features/{feature}/` files.
- **FR-17:** System must provide artifact review actions that integrate with `/open`/`open_file` (`view`, `diff`, `edit`).
- **FR-18:** System must provide keyboard shortcuts in Product Agent UI to open the currently selected file via the `/open` extension flow.
- **FR-19:** System must provide an end-of-feature review listing changed files with git status (`A`, `M`, `D`) and per-file review actions.
- **FR-20:** System must include a pre-ship checklist in review (required approvals and quality gates status).

## 5. Non-Goals (Out of Scope)

- Web or Electron UI in this milestone (TUI only).
- Multi-user approvals, roles, or remote collaboration.
- Replacing existing skills (prd, design-solution, simple-tasks, implement-task); this UI orchestrates them.
- Full analytics dashboard (cycle time/cost trends) beyond basic run visibility.
- Automatic rewriting of project methodology in AGENTS.md.

## 6. Design Considerations

- Reuse Pi extension + TUI patterns already present in this repo (`file-opener`, `subagent`, `bordered-editor`).
- Prioritize legibility and low cognitive load: stage header, artifact panel, task views, run console.
- Prefer progressive disclosure: concise status by default, expandable details for logs/checkpoints.

## 7. Technical Considerations

- Implement as Pi extension(s) in this repo.
- Persist UI/workflow state using extension custom entries and/or markdown-backed state files.
- Load policy from JSON config at `.pi/product-agent-policy.json` (project-local source of truth for this milestone).
- Provide a built-in default policy object used when the JSON file does not exist or fails validation.
- Do not build a dedicated policy editor UI in this milestone; configure policy by editing JSON directly.
- Add README documentation for policy configuration (schema, defaults, examples, and reload behavior).
- Watch/sync markdown artifacts to avoid stale views after agent writes.
- Keep deterministic state transitions with explicit gate checks.
- Reuse existing file review integration via `/open` and `open_file` (`view`, `diff`, `edit`) instead of creating custom file viewers from scratch.
- Build review from git-tracked changes (`A`, `M`, `D`) scoped to current working tree.
- Integrate with existing command/tool surface (`/plan`, skills, subagent orchestration) without breaking backward compatibility.

## 8. Success Metrics

- Reduce manual intervention prompts per implemented task.
- Increase percentage of tasks completed in uninterrupted Run loop sessions.
- Decrease time from PRD approval to first completed task.
- Zero unauthorized stage transitions under strict policy.

## 9. Open Questions

- Should task status source of truth be `_active.md` only or merged from per-task files + `_active.md`?
- What is the minimal event schema for run timeline (to support future analytics without migration pain)?
- Do we need explicit "re-open approval" actions when approved artifacts are edited?
