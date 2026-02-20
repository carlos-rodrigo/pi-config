# Technical Design: Product Agent UI (Pi TUI)

## 1. Overview

We will implement a new Pi extension `extensions/product-agent-ui/` that orchestrates the full product workflow in-terminal:

`Plan → Design → Tasks → Implement → Review`.

The extension is artifact-first (`.features/{feature}` markdown files), policy-driven (`.pi/product-agent-policy.json` + built-in defaults), and integrates with existing extensions (`/open`, `subagent`) rather than re-implementing those capabilities.

---

## 2. Codebase Analysis

### Reusable Components

| Component | Path | Usage in this feature |
|---|---|---|
| File overlay + diff + edit | `extensions/file-opener.ts` | Reuse `/open` flow for artifact/review (`view`/`diff`/`edit`) |
| Rich tool rendering + streaming updates | `extensions/subagent/index.ts` | Reuse run timeline rendering patterns for execution console |
| Status in UI/editor border patterns | `extensions/bordered-editor.ts` | Reuse stage/status visual language |
| Async custom UI flow with loader | `extensions/handoff.ts` | Reuse `ctx.ui.custom` + `BorderedLoader` interaction pattern |

### Existing Task/Workflow Patterns

| Pattern | Path | Usage in this feature |
|---|---|---|
| Task file format (`status`, `depends`, `_active.md`) | `/Users/carlosrodrigo/.pi/agent/skills/simple-tasks/SKILL.md` | Canonical parsing/writing for task views and run loop readiness |
| Skill-based PRD generation | `/Users/carlosrodrigo/.pi/agent/skills/prd/SKILL.md` | Interactive compose flow for PRD stage |
| Skill-based design generation | `/Users/carlosrodrigo/.pi/agent/skills/design-solution/SKILL.md` | Interactive compose flow for Design stage |
| Task decomposition | `/Users/carlosrodrigo/.pi/agent/skills/simple-tasks/SKILL.md` | Interactive compose flow for Tasks stage |

### Pi Platform APIs to Follow

| API/Pattern | Path | Why |
|---|---|---|
| `ctx.ui.custom()` component lifecycle + keyboard handling | `docs/tui.md`, `docs/extensions.md` | Main interaction surface |
| `pi.registerShortcut(...)` + `matchesKey(...)` | `docs/keybindings.md`, `docs/tui.md` | Global + in-panel shortcuts |
| `pi.sendUserMessage(...)` for command orchestration | `docs/extensions.md`, `examples/extensions/send-user-message.ts` | Invoke `/open`, `/skill:*`, and orchestration prompts safely |
| `pi.appendEntry(...)` + reconstruction on `session_start` | `docs/extensions.md` | Persist approvals and run timeline across resume |

### Existing Patterns to Follow

- **Extension modularization**: split into `index.ts`, `services/`, `components/`, `types.ts`.
- **Progressive disclosure UI**: compact by default, details on demand (as in `subagent` rendering).
- **Do not duplicate file viewer**: integrate `/open` command/tool behavior.
- **Explicit state transitions**: no hidden stage jumps.

---

## 3. Data Model

### 3.1 Policy Config (JSON + Defaults)

**Primary file**: `.pi/product-agent-policy.json` (project-local)

**Fallback**: built-in strict default object in code.

```ts
interface ProductAgentPolicy {
  version: 1;
  mode: "strict" | "soft" | "mixed";
  gates: {
    planApprovalRequired: boolean;
    designApprovalRequired: boolean;
    tasksApprovalRequired: boolean;
    reviewRequired: boolean;
  };
  execution: {
    autoRunLoop: boolean;
    stopOnFailedChecks: boolean;
    stopOnUncertainty: boolean;
    maxConsecutiveTasks?: number;
  };
}
```

**Built-in default** (strict): all approvals required, `autoRunLoop=true`, stop on failed checks/uncertainty.

### 3.2 Runtime Workflow State

Persisted via `pi.appendEntry("product-agent-state", ...)`.

```ts
interface WorkflowState {
  feature: string; // e.g. "product-agent-ui"
  currentStage: "plan" | "design" | "tasks" | "implement" | "review";
  approvals: {
    prd?: ApprovalRecord;
    design?: ApprovalRecord;
    tasks?: ApprovalRecord;
  };
  view: {
    taskView: "list" | "board";
    selectedTaskId?: string;
    selectedPath?: string;
  };
}

interface ApprovalRecord {
  status: "approved" | "rejected";
  note?: string;
  by: string;
  at: string; // ISO
}
```

### 3.3 Task/Execution Models

```ts
interface TaskItem {
  id: string; // 001
  path: string;
  title: string;
  status: "TODO" | "In Progress" | "Done";
  rawStatus: "open" | "in-progress" | "done" | "blocked";
  depends: string[];
}

interface RunEvent {
  id: string;
  at: string;
  type: "task_start" | "task_done" | "task_blocked" | "checkpoint" | "info";
  taskId?: string;
  message: string;
}

interface ReviewFile {
  status: "A" | "M" | "D";
  path: string;
}
```

Status mapping: `open|blocked -> TODO`, `in-progress -> In Progress`, `done -> Done`.

---

## 4. API Design (Extension-facing)

### 4.1 Slash Commands

| Command | Purpose |
|---|---|
| `/product` | Open Product Agent shell for current feature |
| `/product <feature>` | Open shell for specific feature folder |
| `/product-policy` | Show active policy source (file vs defaults) |
| `/product-run` | Start/continue run loop |
| `/product-review` | Open final review panel |

### 4.2 Shortcuts

| Scope | Shortcut | Action |
|---|---|---|
| Global | `Ctrl+Alt+W` | Open Product Agent shell |
| In Product UI | `o` | Open selected file via `/open <path>` |
| In Product UI | `d` | Open selected file diff via `/open <path> --diff` |
| In Product UI | `e` | Open selected file edit via `/open_file` mode `edit` or `/open` + edit key |
| In Product UI | `v` | Toggle task view `List <-> Board` |

### 4.3 Orchestration via Existing Commands/Skills

- PRD compose: `pi.sendUserMessage("/skill:prd ...")`
- Design compose: `pi.sendUserMessage("/skill:design-solution ...")`
- Tasks compose: `pi.sendUserMessage("/skill:simple-tasks ...")`
- File review: `pi.sendUserMessage("/open <path>")`

When streaming, use `deliverAs: "followUp"`.

---

## 5. Component Architecture (Frontend/TUI)

### 5.1 New Components

| Component | Responsibility | Reuses |
|---|---|---|
| `ProductShell` | Stage header, navigation, active panel router | `Container`, `Text`, theme patterns |
| `ArtifactPanel` | View PRD/Design, trigger compose/refine, approve/reject | markdown rendering + `/open` integration |
| `TaskPanel` | List/Board views with required grouped order | task parsing service |
| `RunConsolePanel` | Live events, blocked reasons, checkpoint controls | `subagent`-like timeline rendering |
| `ReviewPanel` | Changed files list (A/M/D) + quick open/diff/edit + checklist | git diff parsing + `/open` integration |

### 5.2 State Management

- In-memory state in extension closure.
- Persist snapshots on meaningful transitions (`approve`, `stage change`, `run event`).
- Reconstruct from latest `product-agent-state` custom entry on `session_start`.

### 5.3 Data Fetching

- Artifact reads: Node `fs` from `.features/{feature}`.
- Tasks: parse frontmatter from `tasks/*.md` + `_active.md` context.
- Review files: `git diff --name-status` + optionally `git diff --cached --name-status`.

---

## 6. Backend Architecture (Extension Service Layer)

No server/backend. Equivalent layering inside extension:

`UI Component -> Orchestrator Service -> File/Policy/Task/Git Services`

### Services

- `policy-service.ts`: load/validate policy JSON; fallback defaults.
- `artifact-service.ts`: locate/read/write PRD/design/task artifacts.
- `task-service.ts`: parse tasks, compute ready tasks, update task status safely.
- `runloop-service.ts`: choose next ready task and trigger implement flow.
- `review-service.ts`: collect changed files and checklist signals.
- `state-service.ts`: persist/reconstruct extension state entries.

### Business Rules

- Stage transitions run through `canTransition(current, next, policy, approvals)`.
- Run loop only starts when required approvals pass.
- Failed quality checks or uncertainty => block and emit run event.

---

## 7. Integration Points

1. **File opener integration**
   - UI actions call `pi.sendUserMessage("/open ...")`.
   - Mitigation: if agent not idle, use `deliverAs: "followUp"`.

2. **Skill workflow integration**
   - PRD/Design/Tasks composition launched via `/skill:*` commands.
   - Output remains markdown files under `.features/{feature}`.

3. **Subagent / loop integration**
   - Run loop can use existing `subagent` tool/command orchestration for isolated execution where needed.

4. **Git integration**
   - Review uses working-tree diff (`A/M/D`) as final review bundle.
   - Before each file action (`view`/`diff`/`edit`), re-validate file existence/status and show "state changed, refresh" if stale.

---

## 8. Suggested Improvements

| Area | Current State | Suggested Improvement | Impact | Priority |
|---|---|---|---|---|
| `/open` integration contract | Invoked indirectly via message string | Add optional event-bus contract (`pi.events.emit("file:open", ...)`) between extensions later | More robust than command-string coupling | Medium |
| Task status vocabulary | `open/in-progress/done/blocked` in files; UI wants TODO/In Progress/Done | Centralize status normalization in `task-service` and display `blocked` as TODO+blocked badge | Prevents semantic loss and inconsistent grouping | High |
| State persistence | Potential spread across multiple custom entry types | Single consolidated `product-agent-state` snapshot schema | Easier recovery/debugging | High |
| Reconciliation | File state and entry-log state can diverge | Rebuild from files first, then replay events as timeline-only metadata (never overwrite file state) | Prevents resurrection/drift bugs | High |
| Policy safety | Invalid JSON might silently fallback | Validate policy schema and show warning banner when fallback defaults are used | Safer and more transparent behavior | High |
| Review checklist | Ad hoc checks risk drift | Single `checklist-service` with explicit checks (approvals, typecheck, tests) | Deterministic ship gate | Medium |

---

## 9. Trade-offs & Alternatives

### Decision 1: Use command orchestration for file open
- **Chosen:** trigger `/open` via `pi.sendUserMessage`.
- **Alternative:** duplicate file viewer logic inside Product UI.
- **Why:** avoids duplicated maintenance; immediate reuse of mature viewer/diff/edit behavior.
- **Risk:** string-coupled command invocation.
- **Mitigation:** central helper `openPath(mode, path)` + optional future event-bus API.

### Decision 2: Persist runtime state in custom entries (not extra JSON state file)
- **Chosen:** `pi.appendEntry` state snapshots and timeline events.
- **Alternative:** separate `.pi/product-agent-state.json`.
- **Why:** naturally follows session branching/resume behavior and existing Pi patterns.
- **Risk:** state bloat/fragmentation and potential divergence with file state.
- **Mitigation:** `.features/{feature}` files remain canonical for artifacts/tasks; reconstruct from files first, then replay entries as metadata.

### Decision 3: Policy file project-local only for MVP
- **Chosen:** `.pi/product-agent-policy.json` + built-in defaults.
- **Alternative:** global + project merge precedence from day one.
- **Why:** simpler mental model and lower implementation risk.
- **Risk:** no cross-project reuse initially.
- **Mitigation:** include versioned schema and README for future global override extension.

### Decision 4: Run loop MVP sequential only
- **Chosen:** execute one ready task at a time.
- **Alternative:** parallel task execution.
- **Why:** easier consistency with dependencies and review visibility.
- **Risk:** lower throughput.
- **Mitigation:** add parallel mode only after stable auditability.

### Decision 5: Reuse `/open` via `sendUserMessage`
- **Chosen:** open/diff/edit actions dispatch through existing `/open` flow.
- **Alternative:** direct file-view API or duplicated viewer implementation.
- **Why:** immediate reuse and consistent UX with existing extension.
- **Risk:** queued command interleaving while agent is streaming.
- **Mitigation:** central action dispatcher (`openPath`) that uses `deliverAs: "followUp"` when not idle and surfaces pending-action status in UI.

---

## 10. Open Questions

- [ ] Should `blocked` tasks always display in `TODO`, or do we add a fourth visual badge within TODO section?
- [ ] Review scope: include staged + unstaged by default, or only unstaged?
- [ ] Should `/product` auto-detect current feature from active file context if not provided?

---

## Implementation Notes for MVP Simplicity

1. Start with one command (`/product`) + one shortcut (`Ctrl+Alt+W`).
2. Implement list view first, then board view toggle on same data model.
3. Use strict defaults hardcoded, then overlay JSON policy if present.
4. Treat compose/refine as orchestrated prompts to existing skills (no custom prompt DSL yet).
5. Make Review panel read-only first; reuse `/open` for all deep review actions.
