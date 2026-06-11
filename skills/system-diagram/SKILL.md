---
name: system-diagram
description: "Create System Diagrams: Excalidraw-style HTML/SVG learning diagrams for application flows, classes/methods/call chains, component communication, architecture boundaries, domain concepts, and system mental models."
argument-hint: "[feature-or-doc-path]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
---

# System Diagram

Create a clean, hand-drawn/Excalidraw-style **System Diagram** that helps the user understand how part of a software system works.

A System Diagram can explain either:

1. **Code flow** — classes, methods, functions, calls, events, jobs, and data passed between components.
2. **System model** — parts of the product/system, domain concepts, states, ownership boundaries, and how they relate.

The diagram is a **learning artifact**, not decoration. It should help the user explain:

- what exists in the system,
- how the parts communicate,
- where responsibilities and boundaries live,
- which domain concepts are being introduced,
- how data/state moves,
- which strategic decisions or proof points matter.

## When to Use

Use this skill when the user asks for:

- a System Diagram,
- an Excalidraw-style/sketchy/visual diagram,
- a flow diagram for part of an application,
- a class/method/function call diagram,
- a component communication map,
- a domain model or concept relationship diagram,
- a current-flow / intended-flow comparison,
- an architecture/data-flow/sequence diagram,
- a feature mental model,
- a learning-oriented HTML page with a diagram.

## Diagram Modes

Pick the smallest mode that teaches the user what they need.

| Need | Diagram mode | Shows |
| --- | --- | --- |
| Understand implementation flow | Code Flow | class/function/method calls, events, jobs, payloads |
| Understand how components talk | Component Communication | modules/services/components, protocols, boundaries |
| Understand product concepts | Domain Concept Model | entities/concepts/states and relationships |
| Understand current vs intended behavior | Before/After System Story | old flow next to new flow |
| Understand ownership | Ownership/Lane Map | runtime/team/module responsibility |
| Understand strategic choices | Decision Map | options, tradeoffs, escalation points |
| Understand lifecycle | State/Lifecycle Diagram | states, transitions, triggers, terminal states |

## Core Principles

### 1. Inspect reality before drawing

Do not infer ownership or call flow from folder names alone. Read/search actual source, tests, routes, docs, and types first.

Before drawing, identify:

- real actors and triggers,
- real classes/functions/modules/routes/events,
- call order and data passed between calls,
- domain concepts and their relationships,
- state transitions and persistence points,
- runtime/process/service boundaries,
- error/retry/recovery paths,
- intentionally absent or removed paths if they explain confusion.

### 2. Color by ownership/responsibility

Color means **where responsibility lives**, not what looks nice. Define a legend for every diagram.

Suggested generic palette:

- Green = primary app/domain owner
- Purple = secondary module/service/runtime
- Orange = async worker/job/background runtime
- Blue dashed arrows = network/API/process boundary
- Red dashed arrows = error/recovery/cancellation/removed path
- Black/gray arrows = same-runtime calls or local handoff

Adapt labels/colors to the project, but keep them consistent within the diagram.

### 3. Show real names plus plain-language meaning

For implementation-oriented boxes, include:

```text
Human label
RealClass.realMethod() / realFunctionName()
owner/runtime/layer
input/output: important payload or state
```

For domain-oriented boxes, include:

```text
Concept name
Plain-language meaning
Key fields/states/rules
Relationship to other concepts
```

Use plain language for understanding and real code names for traceability.

### 4. Prefer step-by-step learning over dense topology

The user should be able to follow the diagram in order.

Good structures:

- numbered vertical flow,
- lanes by runtime/module/owner,
- side-by-side current vs intended flow,
- domain concept cluster with relationship arrows,
- small callout rail for writes, external systems, TODOs, removed paths,
- compact code ownership map with arrows only where they teach something.

Avoid hairballs. If the diagram is crowded, split it into multiple diagrams.

### 5. Label every meaningful arrow

For call-flow arrows, label:

- method/function/event/job name,
- payload or argument shape,
- sync vs async if relevant.

For cross-boundary arrows, label:

- protocol/mechanism,
- route/topic/event/job name,
- important payload shape,
- response/signal when relevant.

Examples:

```text
ShippingService.book(loadId)
→ emits LoadBooked(load_id)
```

```text
HTTP POST /api/runs
body: { operationName, input }
```

```text
queue job: ProcessImportJob
args: { importId }
```

### 6. Make strategic ambiguity visible

If product/system behavior is unresolved, show it as a decision node or callout, not as settled implementation.

Use labels such as:

- `decision needed`,
- `agent must escalate`,
- `assumption`,
- `unproven`,
- `not used / removed`.

## Workflow

### Step 1: Define the diagram question

State the question the diagram should answer, for example:

- “Which classes and methods run when a user submits this form?”
- “How does this event move from controller → service → job → subscriber?”
- “What domain concepts are introduced by this feature and how do they relate?”
- “How do ownership-loop, feature-flow, work orders, and proof docs communicate?”

If the question is unclear, ask one focused clarifying question before drawing.

### Step 2: Inspect the system

Use targeted reads/searches. Capture evidence while exploring.

A useful exploration checklist:

```markdown
Diagram question:
- ...

Actors / triggers:
- ...

Code anchors:
- path:function — why it matters

Calls / handoffs:
- caller → callee — payload/state

Domain concepts:
- concept — meaning — relationships

Boundaries:
- runtime/service/module/persistence boundary

Unclear or strategic decisions:
- ...
```

### Step 3: Choose the diagram mode

Use the table above. Prefer one clear diagram over a generic mega-diagram.

For complex features, create a small set:

```text
current-flow.html
intended-flow.html
code-flow.html
domain-model.html
communication-map.html
```

### Step 4: Create the artifact

Preferred outputs:

- `docs/features/{feature}/diagrams/{name}.html` for feature-specific diagrams
- `docs/architecture/{name}.html` for cross-feature architecture diagrams
- another durable docs folder if the project already has one

Use a self-contained HTML file with inline SVG and CSS. Start from `resources/system-diagram-template.html` when helpful.

### Step 5: Open or report the view

If local UI/browser access is available, open the HTML file. Otherwise, report the path and how to open it.

```bash
open docs/features/<feature>/diagrams/<name>.html
```

### Step 6: Iterate for ownership clarity

When the user says a layer, responsibility, domain relationship, or call arrow feels wrong, re-check the source and update the diagram. The goal is clarity and truth, not defending the first layout.

## HTML/SVG Drawing Rules

- Use inline SVG inside self-contained HTML.
- Use a warm paper background, rounded boxes, subtle roughening/filter, soft shadows, and handwritten/system-rounded fonts.
- Keep text readable; do not shrink below 11px in SVG.
- Use `foreignObject` only when necessary, and give it extra height to avoid clipping.
- Use numbered steps for the main story when order matters.
- Keep side effects inside cards as chips/callouts instead of drawing every side-effect arrow.
- Use red dashed arrows only for exceptional paths.
- Add a legend that defines colors for this specific diagram.
- Include a short “How to read this” note above or below the canvas.

## Output Format

When done, report:

```markdown
Created: <path>
Opened in browser: yes/no
Diagram mode: <Code Flow | Component Communication | Domain Concept Model | ...>
Diagram question: <question answered>
Key ownership/concept decisions:
- ...
What this should help you explain:
- ...
Uncertainty / follow-up:
- ...
```

## Safety Rules

- Documentation/diagram generation only.
- Do not change runtime behavior while using this skill.
- Do not call production services, send emails, publish webhooks, or run destructive commands.
- If runtime validation is needed, use tests, local logs, or ask for explicit approval.
