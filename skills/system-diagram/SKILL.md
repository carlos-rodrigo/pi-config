---
name: system-diagram
description: "Create reviewable HTML/SVG system diagrams and diagram-led report pages for application flows, classes/methods/call chains, component communication, architecture boundaries, domain concepts, and system mental models."
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

Create a clean, reviewable **System Diagram** that helps the user understand how part of a software system works. Use `html-report-designer` when the diagram is part of a durable PRD/design/report page.

A System Diagram can explain either:

1. **Code flow** — classes, methods, functions, calls, events, jobs, and data passed between components.
2. **System design** — parts of the product/system, domain concepts, states, ownership boundaries, and how they relate.

The diagram is a **learning artifact**, not decoration. It should help the user explain:

- what exists in the system,
- how the parts communicate,
- where responsibilities and boundaries live,
- which domain concepts are being introduced,
- how data/state moves,
- which strategic decisions or feedback-loop evidence matter.

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
- a learning-oriented HTML page with a diagram,
- a polished reviewable diagram/report experience.

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

## Diagram brief contract

Before drawing, write a compact brief. The final diagram must make this brief obvious in the page:

```markdown
Diagram question: What single question should this diagram answer?
Audience: Who needs to understand it?
Mode: Context | Flow | Sequence | State | Ownership | Slice | Decision
Scope: What is included and intentionally excluded?
Evidence: Which files/docs/tests/logs back this drawing?
Nodes: What actors/components/concepts must appear?
Edges: What calls/events/transitions must be labelled?
Boundaries: What runtime/team/module/process boundaries matter?
Uncertainty: What is assumed, unresolved, removed, risky, or decision-needed?
```

If the brief cannot be filled from repo/product context, ask one focused question instead of drawing a vague topology.

## Workflow

### Step 1: Define the diagram question

State the question the diagram should answer, for example:

- “Which classes and methods run when a user submits this form?”
- “How does this event move from controller → service → job → subscriber?”
- “What domain concepts are introduced by this feature and how do they relate?”
- “How do PRDs, design.html, ADRs, task briefs, and task results communicate?”

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

For complex features, create a small set of diagram sections inside the main report by default:

```text
current-flow
intended-flow
code-flow
domain-model
communication-map
```

Create sibling `diagrams/{name}.html` files only when a diagram needs its own focused review page.

### Step 4: Create the artifact

Preferred outputs:

- `docs/features/{feature}/design.html` for the main feature design review artifact
- `docs/features/{feature}/prd.html` only when the PRD itself needs a product behavior/scope diagram
- `docs/features/{feature}/diagrams/{name}.html` for optional supporting diagrams when a single design page would be crowded
- `docs/architecture/{name}.html` for cross-feature architecture diagrams
- another durable docs folder if the project already has one

Use a self-contained HTML file with inline SVG and CSS.

- For durable report pages, start from `../html-report-designer/resources/report-template.html` and embed the SVG as a figure.
- For diagram-only pages, start from `resources/system-diagram-template.html` when helpful.

### Step 5: Open or report the view

If local UI/browser access is available, open the HTML file. Otherwise, report the path and how to open it.

```bash
open docs/features/<feature>/design.html
```

### Step 6: Iterate for ownership clarity

When the user says a layer, responsibility, domain relationship, or call arrow feels wrong, re-check the source and update the diagram. The goal is clarity and truth, not defending the first layout.

## HTML/SVG Drawing Rules

- Use inline SVG inside self-contained HTML.
- Treat the diagram as an informational figure with a title, caption, legend, and “How to read this” note.
- Use the `html-report-designer` shell for polished long-form pages: breadcrumbs, collapsible left sidebar, no top menu/right rail, semantic sections, feedback, provenance, and print styles.
- Use `resources/system-diagram-template.html` for diagram-only pages. It uses build-time Tailwind and inline compiled CSS; edit `resources/system-diagram.tailwind.css`, then run `npm run build:report-css` from `/Users/carlosrodrigo/agents` before handoff/commit.
- Do not use Tailwind CDN/runtime, remote fonts, Mermaid runtime, or external CSS in finished diagrams. D2/Mermaid/Graphviz may be used only at build time if the final SVG is inlined and restyled to this system.
- Prefer the build-time ELK renderer for multi-node architecture/call-flow diagrams: create an ELK JSON spec, run `node /Users/carlosrodrigo/agents/scripts/render-elk-diagram.mjs spec.json output.svg`, inspect spacing/labels, then inline the SVG. Use manual SVG only for tiny diagrams or intentionally custom spatial metaphors.
- Use a tokenized Vercel-style diagram system: semantic surfaces, text ranks, borders, neutral default, status colors, spacing, radius, focus rings, and reduced-motion-safe motion.
- Use subtle scroll appearance, SVG node reveal, and path draw-in motion when it teaches reading order; keep content visible without JavaScript and honor `prefers-reduced-motion`.
- Keep text readable; do not shrink below 12px effective size in SVG.
- Prefer semantic HTML text around the SVG over packing every explanation into SVG labels.
- Use `foreignObject` only when necessary, and give it extra height to avoid clipping.
- Use numbered steps for the main story when order matters.
- Keep side effects inside cards as chips/callouts instead of drawing every side-effect arrow.
- Use red dashed arrows only for exceptional paths.
- Add a legend that defines colors for this specific diagram.
- Add stable `data-review-id` anchors to major sections and meaningful SVG groups/nodes.
- Include accessible SVG `<title>` and `<desc>` plus a visible figure caption/legend.
- Avoid decorative complexity that makes the system harder to understand.

## Diagram primitives

Use these reusable primitives instead of ad hoc boxes:

- **Lanes/boundaries** — dashed rounded regions for actor, system/module, external dependency, worker/process, or team ownership.
- **Nodes** — rounded cards with a human label, real symbol/path when known, owner/runtime/layer, and important input/output/state.
- **Edges** — labelled arrows; solid for local/same-runtime handoffs, blue dashed for boundary/API/process crossings, red dashed for risk/recovery/removed paths. Use ELK orthogonal routing for 4+ node flows. Put labels in foreground pill groups (`diagram.edge-label.*`) so they are never hidden behind nodes or clipped by nearby components.
- **Decision/callout nodes** — amber cards for unresolved decisions, assumptions, unproven claims, or escalation triggers.
- **Legend** — visible semantic color/line guide tied to this diagram, not a generic decorative palette.

For design reports, reuse the same semantics in embedded architecture and slice diagrams even when the SVG is smaller.

## Diagram quality gate

Before handoff, check:

- the diagram answers one explicit question, not a vague topic;
- source evidence was inspected for real actors, calls, state, and boundaries;
- every color has a responsibility meaning documented in the legend;
- every meaningful arrow is labeled with call/event/protocol/payload;
- for 4+ node diagrams, spacing/routing is generated with ELK or the manual layout has an explicit reason;
- key SVG groups/nodes have stable `data-review-id` anchors;
- SVG has `<title>` and `<desc>` and a visible caption/how-to-read note;
- text remains readable at the expected viewport and is at least 12px effective size;
- uncertainty, removed paths, recovery, or decision-needed paths are visible instead of implied;
- progressive motion is optional and respects `prefers-reduced-motion`;
- final HTML has no external CSS/JS/runtime assets;
- build-time Tailwind CSS is current (`npm run check:report-css` in `/Users/carlosrodrigo/agents`);
- diagram-only pages pass `node /Users/carlosrodrigo/agents/scripts/validate-html-report.mjs --allow-placeholders resources/system-diagram-template.html` when validating templates, and finished diagrams pass without `--allow-placeholders`.

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
