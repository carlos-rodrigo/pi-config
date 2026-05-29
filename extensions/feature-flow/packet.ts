import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type FeaturePacketInput = {
	brief: string;
	slug: string;
	branch: string;
	workspacePath: string;
	createdDate?: string;
};

export type FeaturePacketResult = {
	packetDir: string;
	indexPath: string;
	created: string[];
	existing: string[];
};

export type RebuildFeatureViewResult =
	| { ok: true; packetDir: string; indexPath: string; sectionCount: number }
	| { ok: false; error: string; packetDir: string };

export type WorkOrderStatus = "draft" | "ready" | "blocked" | "done";

export type WorkOrderInfo = {
	path: string;
	id?: string;
	title: string;
	status: WorkOrderStatus;
	order: number;
};

export type ExecutionReportStatus = "draft" | "complete";

export type ExecutionReportInfo = {
	path: string;
	id?: string;
	workOrder?: string;
	status: ExecutionReportStatus;
	order: number;
};

export type FeaturePacketStatus = {
	ok: boolean;
	slug: string;
	packetDir: string;
	missingCoreDocs: string[];
	workOrderCount: number;
	readyWorkOrderCount: number;
	draftWorkOrderCount: number;
	blockedWorkOrderCount: number;
	doneWorkOrderCount: number;
	doneWorkOrderWithoutReportCount: number;
	readyWorkOrderPath?: string;
	diagramCount: number;
	executionReportCount: number;
	completeExecutionReportCount: number;
	draftExecutionReportCount: number;
	openDecisionCount: number;
	incompleteProofCount: number;
	nextAction: string;
	nextPrompt: string;
	error?: string;
};

type FeatureSection = {
	title: string;
	path: string;
	content: string;
};

type DiagramLink = {
	title: string;
	path: string;
	src: string;
};

type FeatureMetadata = {
	brief?: string;
	slug?: string;
	branch?: string;
	createdDate?: string;
};

const FEATURE_DOC_FILES = ["strategy.md", "system-model.md", "decisions.md", "proof.md", "review.md"] as const;

function posixPath(value: string): string {
	return value.split(path.sep).join("/");
}

function titleizeSlug(slug: string): string {
	return slug
		.split(/[-_]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ") || "Feature";
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function closeListIfNeeded(lines: string[], state: { inList: boolean }): void {
	if (!state.inList) return;
	lines.push("</ul>");
	state.inList = false;
}

function isTableDivider(line: string): boolean {
	const cells = splitTableRow(line);
	return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitTableRow(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((cell) => cell.trim());
}

function tableToHtml(headerLine: string, bodyLines: string[]): string {
	const headers = splitTableRow(headerLine);
	const rows = bodyLines.map(splitTableRow);
	const head = headers.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("");
	const body = rows
		.map((row) => `<tr>${headers.map((_header, index) => `<td>${escapeHtml(row[index] ?? "")}</td>`).join("")}</tr>`)
		.join("\n");
	return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function markdownToHtml(markdown: string): string {
	const lines: string[] = [];
	const rawLines = markdown.split(/\r?\n/);
	const state = { inList: false, inCode: false };
	let codeLines: string[] = [];
	let i = 0;

	while (i < rawLines.length) {
		const rawLine = rawLines[i] ?? "";
		const line = rawLine.trimEnd();

		if (line.trim().startsWith("```")) {
			if (state.inCode) {
				lines.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
				codeLines = [];
				state.inCode = false;
			} else {
				closeListIfNeeded(lines, state);
				state.inCode = true;
			}
			i++;
			continue;
		}

		if (state.inCode) {
			codeLines.push(rawLine);
			i++;
			continue;
		}

		const trimmed = line.trim();
		if (!trimmed) {
			closeListIfNeeded(lines, state);
			i++;
			continue;
		}

		if (trimmed.includes("|") && isTableDivider(rawLines[i + 1] ?? "")) {
			closeListIfNeeded(lines, state);
			const bodyLines: string[] = [];
			i += 2;
			while (i < rawLines.length && (rawLines[i] ?? "").trim().includes("|")) {
				bodyLines.push(rawLines[i] ?? "");
				i++;
			}
			lines.push(tableToHtml(trimmed, bodyLines));
			continue;
		}

		const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
		if (heading) {
			closeListIfNeeded(lines, state);
			const level = heading[1]?.length ?? 2;
			lines.push(`<h${level}>${escapeHtml(heading[2] ?? "")}</h${level}>`);
			i++;
			continue;
		}

		const unchecked = trimmed.match(/^- \[ \]\s+(.+)$/);
		const checked = trimmed.match(/^- \[x\]\s+(.+)$/i);
		const bullet = trimmed.match(/^-\s+(.+)$/);
		if (unchecked || checked || bullet) {
			if (!state.inList) {
				lines.push("<ul>");
				state.inList = true;
			}
			const text = unchecked?.[1] ?? checked?.[1] ?? bullet?.[1] ?? "";
			const marker = unchecked ? "☐ " : checked ? "☑ " : "";
			lines.push(`<li>${marker}${escapeHtml(text)}</li>`);
			i++;
			continue;
		}

		closeListIfNeeded(lines, state);
		lines.push(`<p>${escapeHtml(trimmed)}</p>`);
		i++;
	}

	if (state.inCode) lines.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
	closeListIfNeeded(lines, state);
	return lines.join("\n");
}

export function featurePacketDir(slug: string): string {
	return posixPath(path.join("docs", "features", slug));
}

function featurePacketPaths(slug: string): Record<string, string> {
	const dir = featurePacketDir(slug);
	return {
		metadata: `${dir}/feature.json`,
		strategy: `${dir}/strategy.md`,
		systemModel: `${dir}/system-model.md`,
		decisions: `${dir}/decisions.md`,
		proof: `${dir}/proof.md`,
		review: `${dir}/review.md`,
		workOrdersReadme: `${dir}/work-orders/README.md`,
		executionReadme: `${dir}/execution/README.md`,
		diagramsReadme: `${dir}/diagrams/README.md`,
		index: `${dir}/index.html`,
	};
}

function buildMetadataJson(input: FeaturePacketInput): string {
	const metadata: FeatureMetadata = {
		brief: input.brief,
		slug: input.slug,
		branch: input.branch,
		createdDate: input.createdDate ?? today(),
	};
	return `${JSON.stringify(metadata, null, 2)}\n`;
}

function buildStrategyMarkdown(input: FeaturePacketInput): string {
	const title = titleizeSlug(input.slug);
	return `# Strategy: ${title}

> Created: ${input.createdDate ?? today()}  
> Brief: ${input.brief}  
> Branch: ${input.branch}

## Problem to own

- [ ] What user/business/system pain are we solving?
- [ ] Who is affected by the current behavior?
- [ ] What makes this worth doing now?

## Desired system behavior

Describe the plain-language rule that should be true after this feature exists.

## Success / failure signals

- [ ] What observable evidence proves this worked?
- [ ] What would prove the strategy is wrong or incomplete?

## Constraints and non-goals

- [ ] Constraints:
- [ ] Non-goals:

## Strategic questions

- [ ] What decisions must the user own before delegation?

## Teach-back

After this feature, the user should be able to explain:

- why this matters,
- how the system should behave,
- which decisions shaped the implementation,
- what evidence proves it.
`;
}

function buildSystemModelMarkdown(input: FeaturePacketInput): string {
	const title = titleizeSlug(input.slug);
	return `# System Model: ${title}

> Source strategy: ./strategy.md

## Diagram question

What system story should the user be able to explain?

## Current system story

Actor/input → current components/functions → current behavior/output.

## Intended system story

Actor/input → changed components/functions → intended behavior/output.

## Key concepts and invariants

- [ ] Concept / state / lifecycle:
- [ ] Invariant that must remain true:

## Code anchors

Add real files/functions after exploration:

| Anchor | Responsibility | Why it matters |
| --- | --- | --- |
| TBD | TBD | TBD |

## Boundaries

- Runtime/service/API boundaries:
- Persistence boundaries:
- Human/agent decision boundaries:

## Open modeling questions

- [ ] What still needs source inspection?
`;
}

function buildDecisionsMarkdown(input: FeaturePacketInput): string {
	const title = titleizeSlug(input.slug);
	return `# Decisions: ${title}

> Strategic decisions the user owns. The agent may recommend options, but should not silently decide what the system means.

| ID | Status | Decision | Why | Rejected / tradeoff | Escalation trigger |
| --- | --- | --- | --- | --- | --- |
| D-001 | proposed | TBD | TBD | TBD | TBD |

## Decision workshop notes

Use this section to compare options before delegation.

### D-001: TBD

- Option A:
- Option B:
- Recommendation:
- User decision:
`;
}

function buildProofMarkdown(input: FeaturePacketInput): string {
	const title = titleizeSlug(input.slug);
	return `# Proof: ${title}

> Evidence plan and final verification record.

## Acceptance evidence

| Rule / claim | Evidence required | Status | Actual result |
| --- | --- | --- | --- |
| TBD | TBD | planned | TBD |

## Verification flows

- [ ] Targeted test:
- [ ] Integration/manual check:
- [ ] Regression gate:

## Execution evidence

Append commands, outputs, screenshots, or manual observations here as implementation proceeds.

## Unproven behavior / caveats

- [ ] TBD
`;
}

function buildReviewMarkdown(input: FeaturePacketInput): string {
	const title = titleizeSlug(input.slug);
	return `# Strategy Review: ${title}

> Final alignment check: strategy → decisions → implementation → proof.

## Original intent

Summarize the strategy this feature was meant to preserve.

## Actual implementation

Summarize what was built and where it lives.

## Match / mismatch

| Intent or decision | Actual behavior | Match? | Notes |
| --- | --- | --- | --- |
| TBD | TBD | TBD | TBD |

## Product/system rule now

State the rule that is actually true after implementation.

## What to retain

- [ ] The mental model future you should remember.

## Follow-up questions

- [ ] TBD
`;
}

function buildWorkOrdersReadme(input: FeaturePacketInput): string {
	return `# Work Orders: ${titleizeSlug(input.slug)}

Work orders are optional delegation briefs. Create them only when the feature should be split across steps, sessions, or agents.

## Work Order v2 contract

Every work order must start with frontmatter:

\`\`\`yaml
---
id: WO-001
status: draft # draft | ready | blocked | done
order: 1
created: ${input.createdDate ?? today()}
---
\`\`\`

Status meaning:

- \`draft\` — strategy or proof still needs review; agents must not implement.
- \`ready\` — user approved this delegation brief; agents may execute it.
- \`blocked\` — waiting for a strategic decision, dependency, or missing proof.
- \`done\` — implementation and execution report are complete.

Each work order should include:

- Mission
- Strategic context
- Decisions to preserve
- Agent-owned execution choices
- Escalation triggers
- Proof required
- Readiness checklist
- Execution report pointer

Use filenames like \`001-short-title.md\`.
`;
}

export function buildWorkOrderMarkdown(input: { id: string; order: number; title: string; createdDate?: string }): string {
	return `---
id: ${input.id}
status: draft
order: ${input.order}
created: ${input.createdDate ?? today()}
---

# ${input.id}: ${input.title}

## Mission

What outcome should this work order produce?

## Strategic context

Why this matters in the feature strategy and system model.

## Decisions to preserve

- [ ] D-XXX — decision/rule this work must preserve.

## Agent-owned execution choices

The agent may decide:

- implementation details that do not change product/system meaning,
- local naming and small refactors,
- test structure that proves the required behavior.

## Escalation triggers

Stop and ask if:

- product/system behavior changes,
- an approved decision conflicts with the code,
- proof cannot be produced,
- scope expands beyond this mission.

## Proof required

- [ ] Targeted check:
- [ ] Regression gate:

## Readiness checklist

- [ ] Strategy/model context is approved.
- [ ] Decisions referenced above are resolved.
- [ ] Proof required is specific enough to verify externally.
- [ ] Change \`status\` to \`ready\` only after user approval.

## Execution report

After implementation, write an execution report under \`../execution/\` and mark this work order \`done\`.
`;
}

function slugifyWorkOrderTitle(title: string): string {
	return title
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 56) || "work-order";
}

export async function createWorkOrder(root: string, slug: string, title: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
	const packetDir = featurePacketDir(slug);
	try {
		const info = await stat(path.join(root, packetDir));
		if (!info.isDirectory()) return { ok: false, error: `Feature packet is not a directory: ${packetDir}` };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, error: `Feature packet not found: ${packetDir}` };
		throw error;
	}

	const existing = await listWorkOrders(root, slug);
	const numericOrders = existing.map((workOrder) => workOrder.order).filter((order) => Number.isFinite(order) && order !== Number.MAX_SAFE_INTEGER);
	const order = numericOrders.length ? Math.max(...numericOrders) + 1 : 1;
	const id = `WO-${String(order).padStart(3, "0")}`;
	const fileName = `${String(order).padStart(3, "0")}-${slugifyWorkOrderTitle(title)}.md`;
	const relativePath = `${packetDir}/work-orders/${fileName}`;
	await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
	try {
		await writeFile(path.join(root, relativePath), buildWorkOrderMarkdown({ id, order, title }), { flag: "wx" });
		return { ok: true, path: relativePath };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return { ok: false, error: `Work order already exists: ${relativePath}` };
		throw error;
	}
}

function buildExecutionReadme(input: FeaturePacketInput): string {
	return `# Execution Reports: ${titleizeSlug(input.slug)}

Use this folder for implementation reports created after work orders or agent execution.

## Execution Report v1 contract

Every execution report must start with frontmatter:

\`\`\`yaml
---
id: ER-001
workOrder: WO-001
status: draft # draft | complete
created: ${input.createdDate ?? today()}
---
\`\`\`

Status meaning:

- \`draft\` — execution report still needs proof/evidence.
- \`complete\` — report includes files changed, deviations, and proof results.

Each execution report should include:

- Mission executed
- Linked work order
- Files changed (repo-relative only)
- Decisions preserved
- Deviations from plan
- Proof commands and results
- Strategic follow-up
`;
}

export function buildExecutionReportMarkdown(input: { id: string; order: number; workOrder: string; createdDate?: string }): string {
	return `---
id: ${input.id}
workOrder: ${input.workOrder}
status: draft
created: ${input.createdDate ?? today()}
---

# ${input.id}: Execution Report for ${input.workOrder}

## Mission executed

What work order mission was executed?

## Files changed

List repo-relative paths only:

- TBD

## Decisions preserved

- [ ] D-XXX — decision/rule preserved.

## Deviations from plan

- None known yet.

## Proof commands and results

| Check | Result | Evidence |
| --- | --- | --- |
| TBD | TBD | TBD |

## Strategic follow-up

- [ ] What should the user understand or decide next?

## Completion checklist

- [ ] Proof evidence is recorded above.
- [ ] Work order is marked \`status: done\`.
- [ ] Change this report to \`status: complete\` after evidence is final.
`;
}

function workOrderStableId(workOrder: WorkOrderInfo): string {
	return workOrder.id ?? path.basename(workOrder.path, ".md");
}

function workOrderReferenceCandidates(workOrder: WorkOrderInfo): string[] {
	return [workOrder.id, path.basename(workOrder.path, ".md"), workOrder.path, path.basename(workOrder.path), workOrder.title]
		.filter((candidate): candidate is string => Boolean(candidate?.trim()))
		.map((candidate) => candidate.trim().toLowerCase());
}

function reportReferencesWorkOrder(reportWorkOrder: string | undefined, workOrder: WorkOrderInfo): boolean {
	const normalized = reportWorkOrder?.trim().toLowerCase();
	if (!normalized) return false;
	return workOrderReferenceCandidates(workOrder).some((candidate) => candidate === normalized || candidate.includes(normalized) || normalized.includes(candidate));
}

function matchWorkOrderRef(workOrder: WorkOrderInfo, ref: string): boolean {
	const normalized = ref.trim().toLowerCase();
	return workOrderReferenceCandidates(workOrder).some((candidate) => candidate === normalized || candidate.includes(normalized));
}

export async function createExecutionReport(root: string, slug: string, workOrderRef: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
	const packetDir = featurePacketDir(slug);
	try {
		const info = await stat(path.join(root, packetDir));
		if (!info.isDirectory()) return { ok: false, error: `Feature packet is not a directory: ${packetDir}` };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, error: `Feature packet not found: ${packetDir}` };
		throw error;
	}

	const workOrders = await listWorkOrders(root, slug);
	const matches = workOrders.filter((workOrder) => matchWorkOrderRef(workOrder, workOrderRef));
	if (matches.length === 0) return { ok: false, error: `No work order found for '${workOrderRef}'` };
	if (matches.length > 1) return { ok: false, error: `Ambiguous work order '${workOrderRef}': ${matches.map((match) => match.id ?? match.path).join(", ")}` };
	const workOrder = matches[0]!;
	const workOrderId = workOrderStableId(workOrder);
	if (workOrder.status === "draft" || workOrder.status === "blocked") {
		return { ok: false, error: `Work order ${workOrderId} is ${workOrder.status}; mark it ready after approval before creating an execution report.` };
	}
	const existingReports = await listExecutionReports(root, slug);
	const duplicate = existingReports.find((report) => reportReferencesWorkOrder(report.workOrder, workOrder));
	if (duplicate) return { ok: false, error: `Execution report already exists for ${workOrderId}: ${duplicate.path}` };
	const numericOrders = existingReports.map((report) => report.order).filter((order) => Number.isFinite(order) && order !== Number.MAX_SAFE_INTEGER);
	const order = numericOrders.length ? Math.max(...numericOrders) + 1 : 1;
	const id = `ER-${String(order).padStart(3, "0")}`;
	const fileName = `${String(order).padStart(3, "0")}-${slugifyWorkOrderTitle(workOrderId)}.md`;
	const relativePath = `${packetDir}/execution/${fileName}`;
	await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
	try {
		await writeFile(path.join(root, relativePath), buildExecutionReportMarkdown({ id, order, workOrder: workOrderId }), { flag: "wx" });
		return { ok: true, path: relativePath };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return { ok: false, error: `Execution report already exists: ${relativePath}` };
		throw error;
	}
}

function buildDiagramsReadme(input: FeaturePacketInput): string {
	return `# Diagrams: ${titleizeSlug(input.slug)}

Use this folder for learning diagrams that clarify the system model.

Recommended diagrams:

- current-flow.html — how the system works today
- intended-flow.html — what changes after the strategy
- code-flow.html — classes, methods, function calls, jobs, events, and payloads
- communication-map.html — components/services/modules and how they talk
- domain-model.html — domain concepts, states, rules, and relationships
- code-ownership.html — files/functions and responsibility boundaries
- decision-map.html — strategic choices and tradeoffs

Prefer the system-diagram skill for HTML/SVG diagrams.
`;
}

function featureRelativeLink(slug: string, relativePath: string): string {
	return path.posix.relative(featurePacketDir(slug), relativePath);
}

function stateClass(value: string): string {
	return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "state";
}

function metricCard(label: string, value: number | string, detail: string): string {
	return `<article class="metric-card">
		<div class="metric-label">${escapeHtml(label)}</div>
		<div class="metric-value">${escapeHtml(String(value))}</div>
		<div class="metric-detail">${escapeHtml(detail)}</div>
	</article>`;
}

function buildWorkOrderDashboard(slug: string, workOrders: WorkOrderInfo[]): string {
	if (workOrders.length === 0) {
		return `<p>No work orders yet. That is OK for small/direct features; create work orders only when delegation, approval, or splitting helps.</p>`;
	}
	const rows = workOrders.map((workOrder) => {
		const href = featureRelativeLink(slug, workOrder.path);
		return `<tr>
			<td><span class="status-chip status-${stateClass(workOrder.status)}">${escapeHtml(workOrder.status)}</span></td>
			<td>${escapeHtml(workOrder.id ?? "—")}</td>
			<td>${escapeHtml(workOrder.title)}</td>
			<td><a href="${escapeHtml(href)}">${escapeHtml(href)}</a></td>
		</tr>`;
	}).join("\n");
	return `<div class="table-wrap"><table><thead><tr><th>Status</th><th>ID</th><th>Title</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function buildExecutionReportDashboard(slug: string, reports: ExecutionReportInfo[]): string {
	if (reports.length === 0) {
		return `<p>No execution reports yet. After implementation, record repo-relative files changed, proof, deviations, and strategic follow-up.</p>`;
	}
	const rows = reports.map((report) => {
		const href = featureRelativeLink(slug, report.path);
		return `<tr>
			<td><span class="status-chip status-${stateClass(report.status)}">${escapeHtml(report.status)}</span></td>
			<td>${escapeHtml(report.id ?? "—")}</td>
			<td>${escapeHtml(report.workOrder ?? "—")}</td>
			<td><a href="${escapeHtml(href)}">${escapeHtml(href)}</a></td>
		</tr>`;
	}).join("\n");
	return `<div class="table-wrap"><table><thead><tr><th>Status</th><th>ID</th><th>Work order</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function buildDiagramDashboard(diagrams: DiagramLink[]): string {
	if (diagrams.length === 0) return `<p>No diagrams yet. Use the system-diagram skill for current flow, intended flow, code flow, communication map, and domain model views.</p>`;
	return `<ul class="link-list">${diagrams.map((diagram) => `<li><a href="${escapeHtml(diagram.src)}">${escapeHtml(diagram.title)}</a> <span>${escapeHtml(diagram.path)}</span></li>`).join("\n")}</ul>`;
}

function buildFeatureDashboardHtml(input: {
	slug: string;
	status: FeaturePacketStatus;
	workOrders: WorkOrderInfo[];
	executionReports: ExecutionReportInfo[];
	diagrams: DiagramLink[];
}): string {
	const state = featurePacketDisplayState(input.status);
	const missingDocs = input.status.missingCoreDocs.length
		? `<div class="callout warning"><strong>Missing docs</strong><ul>${input.status.missingCoreDocs.map((doc) => `<li>${escapeHtml(doc)}</li>`).join("\n")}</ul></div>`
		: "";
	return `<section class="card dashboard" id="dashboard">
		<div class="dashboard-head">
			<div>
				<div class="section-kicker">feature dashboard</div>
				<h1>Feature Dashboard</h1>
				<p>Strategy → system model → decisions → proof → execution evidence → review. Markdown and JSON remain the source of truth; this page is a generated learning view.</p>
			</div>
			<span class="state-badge state-${stateClass(state)}">${escapeHtml(state)}</span>
		</div>
		<div class="next-panel">
			<strong>Next action</strong>
			<p>${escapeHtml(input.status.nextAction)}</p>
			<details>
				<summary>Suggested prompt</summary>
				<pre><code>${escapeHtml(input.status.nextPrompt)}</code></pre>
			</details>
		</div>
		${missingDocs}
		<div class="metric-grid">
			${metricCard("Work orders", input.status.workOrderCount, `${input.status.readyWorkOrderCount} ready · ${input.status.draftWorkOrderCount} draft · ${input.status.blockedWorkOrderCount} blocked · ${input.status.doneWorkOrderCount} done`)}
			${metricCard("Execution reports", input.status.executionReportCount, `${input.status.completeExecutionReportCount} complete · ${input.status.draftExecutionReportCount} draft · ${input.status.doneWorkOrderWithoutReportCount} missing for done work orders`)}
			${metricCard("Proof gaps", input.status.incompleteProofCount, "planned/TBD checklist or table items")}
			${metricCard("Open decisions", input.status.openDecisionCount, "proposed/open/TBD decisions and unchecked items")}
			${metricCard("Diagrams", input.status.diagramCount, "HTML/SVG system diagrams")}
		</div>
		<div class="dashboard-grid">
			<article>
				<h2>Work order states</h2>
				${buildWorkOrderDashboard(input.slug, input.workOrders)}
			</article>
			<article>
				<h2>Execution evidence</h2>
				${buildExecutionReportDashboard(input.slug, input.executionReports)}
			</article>
			<article>
				<h2>Diagram links</h2>
				${buildDiagramDashboard(input.diagrams)}
			</article>
			<article>
				<h2>Review / Remember</h2>
				<p>After evidence is complete, run <code>/feature review ${escapeHtml(input.slug)}</code> to write the strategy alignment teach-back. Use <code>/reown --remember</code> only when the lesson should become searchable ownership memory.</p>
			</article>
		</div>
	</section>`;
}

function buildFeatureLearningHtml(input: {
	slug: string;
	brief?: string;
	branch?: string;
	sections: FeatureSection[];
	diagrams: DiagramLink[];
	status: FeaturePacketStatus;
	workOrders: WorkOrderInfo[];
	executionReports: ExecutionReportInfo[];
}): string {
	const title = titleizeSlug(input.slug);
	const nav = [
		`<a href="#dashboard">Dashboard</a>`,
		...input.sections.map((section, index) => `<a href="#section-${index + 1}">${escapeHtml(section.title)}</a>`),
		...(input.diagrams.length ? [`<a href="#diagrams">Diagrams</a>`] : []),
	].join("\n");
	const sections = input.sections
		.map((section, index) => {
			const rel = escapeHtml(section.path);
			return `<section class="card" id="section-${index + 1}">
				<div class="section-kicker">${rel}</div>
				${markdownToHtml(section.content || `# ${section.title}\n\nNo content yet.`)}
			</section>`;
		})
		.join("\n");
	const diagrams = input.diagrams.length
		? `<section class="card" id="diagrams">
			<h1>System Diagrams</h1>
			<p>Visual learning artifacts for code flow, component communication, domain concepts, and system boundaries.</p>
			<div class="diagram-grid">
				${input.diagrams.map((diagram) => `<article class="diagram-card">
					<div class="section-kicker">${escapeHtml(diagram.path)}</div>
					<h2>${escapeHtml(diagram.title)}</h2>
					<iframe title="${escapeHtml(diagram.title)}" src="${escapeHtml(diagram.src)}" sandbox="" loading="lazy"></iframe>
					<p><a href="${escapeHtml(diagram.src)}">Open diagram</a></p>
				</article>`).join("\n")}
			</div>
		</section>`
		: "";

	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>${escapeHtml(title)} — Feature Learning View</title>
	<style>
		:root {
			--paper: #fbf7ef;
			--canvas: #fffaf0;
			--ink: #1f2937;
			--muted: #64748b;
			--accent: #6741d9;
			--green: #2f9e44;
			--blue: #1971c2;
			--line: rgba(31, 41, 55, .18);
			--shadow: rgba(31, 41, 55, .14);
		}
		* { box-sizing: border-box; }
		body { margin: 0; background: var(--paper); color: var(--ink); font-family: ui-rounded, "SF Pro Rounded", "Comic Sans MS", "Bradley Hand", "Segoe Print", system-ui, sans-serif; }
		.wrap { max-width: 1180px; margin: 0 auto; padding: 28px; }
		header { background: var(--canvas); border: 3px solid var(--ink); border-radius: 24px; padding: 26px; box-shadow: 7px 7px 0 var(--shadow); }
		h1 { margin: 0; font-size: clamp(32px, 5vw, 58px); letter-spacing: -.04em; }
		.subtitle { margin: 10px 0 0; max-width: 850px; color: var(--muted); font-size: 17px; line-height: 1.45; }
		.meta { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
		.pill { border: 2px solid var(--line); border-radius: 999px; padding: 6px 10px; background: rgba(255,255,255,.62); font-size: 13px; color: #334155; }
		nav { display: flex; flex-wrap: wrap; gap: 10px; margin: 22px 0; }
		nav a, .diagram-card a, .link-list a, td a { color: var(--accent); text-decoration: none; border: 2px solid rgba(103,65,217,.24); border-radius: 999px; padding: 8px 12px; background: rgba(255,255,255,.52); font-weight: 700; display: inline-block; }
		.grid { display: grid; grid-template-columns: 1fr; gap: 18px; }
		.card { background: rgba(255,255,255,.72); border: 2.5px solid var(--ink); border-radius: 20px; padding: 22px; box-shadow: 5px 5px 0 var(--shadow); }
		.dashboard { background: linear-gradient(135deg, rgba(255,255,255,.88), rgba(238,232,255,.72)); }
		.dashboard-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; flex-wrap: wrap; }
		.dashboard-head p { max-width: 780px; color: var(--muted); }
		.state-badge, .status-chip { border: 2px solid var(--ink); border-radius: 999px; padding: 7px 12px; font-weight: 800; background: white; display: inline-block; }
		.state-ready, .state-ready-to-execute, .status-ready, .status-complete, .status-done { background: rgba(47,158,68,.13); color: #1b6b2a; }
		.state-incomplete, .state-needs-review, .status-draft { background: rgba(250,176,5,.16); color: #8a5a00; }
		.state-needs-report, .status-blocked { background: rgba(224,49,49,.12); color: #a61e1e; }
		.next-panel { border: 2px solid rgba(103,65,217,.25); border-radius: 18px; padding: 16px; background: rgba(255,255,255,.62); margin: 16px 0; }
		.next-panel p { margin: 8px 0 0; }
		.metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 18px 0; }
		.metric-card { border: 2px solid var(--line); border-radius: 16px; padding: 14px; background: rgba(255,255,255,.58); }
		.metric-label { color: var(--muted); font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; }
		.metric-value { font-size: 30px; font-weight: 900; letter-spacing: -.05em; margin-top: 4px; }
		.metric-detail { color: var(--muted); font-size: 13px; line-height: 1.35; }
		.dashboard-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
		.dashboard-grid article, .callout { border: 2px dashed var(--line); border-radius: 16px; padding: 14px; background: rgba(255,255,255,.44); }
		.callout.warning { border-color: rgba(224,49,49,.35); background: rgba(255,245,245,.72); }
		.link-list { list-style: none; padding-left: 0; display: grid; gap: 8px; }
		.link-list span { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; margin-left: 6px; }
		.section-kicker { color: var(--blue); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; margin-bottom: 8px; }
		h1, h2, h3, h4 { line-height: 1.1; }
		.card h1 { font-size: 26px; margin: 0 0 14px; }
		.card h2 { font-size: 21px; margin: 22px 0 8px; }
		.card h3 { font-size: 17px; margin: 18px 0 8px; }
		p, li { line-height: 1.55; }
		ul { padding-left: 22px; }
		.table-wrap { overflow-x: auto; margin: 14px 0; }
		table { width: 100%; border-collapse: collapse; background: rgba(255,255,255,.58); }
		th, td { border: 1.5px solid var(--line); padding: 9px 10px; text-align: left; vertical-align: top; }
		th { background: rgba(103,65,217,.09); }
		pre { overflow: auto; background: #1f2937; color: #f8fafc; border-radius: 14px; padding: 14px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
		.diagram-grid { display: grid; grid-template-columns: 1fr; gap: 18px; margin-top: 14px; }
		.diagram-card { border: 2px dashed var(--line); border-radius: 18px; padding: 16px; background: rgba(255,255,255,.48); }
		.diagram-card iframe { width: 100%; min-height: 520px; border: 2px solid var(--line); border-radius: 14px; background: white; }
		.footer { margin-top: 22px; color: var(--muted); font-size: 13px; }
	</style>
</head>
<body>
	<div class="wrap">
		<header>
			<h1>${escapeHtml(title)}</h1>
			<p class="subtitle">Feature Learning View — a readable study guide generated from the source docs in <code>${escapeHtml(featurePacketDir(input.slug))}</code>.</p>
			<div class="meta">
				<span class="pill">slug: ${escapeHtml(input.slug)}</span>
				${input.branch ? `<span class="pill">branch: ${escapeHtml(input.branch)}</span>` : ""}
				${input.brief ? `<span class="pill">brief: ${escapeHtml(input.brief)}</span>` : ""}
			</div>
		</header>
		<nav>${nav}</nav>
		<main class="grid">${buildFeatureDashboardHtml(input)}${sections}${diagrams}</main>
		<p class="footer">Generated by feature-flow. Edit the markdown source docs, work orders, execution reports, or diagrams, then run <code>/feature view ${escapeHtml(input.slug)}</code> to refresh this page.</p>
	</div>
</body>
</html>
`;
}

async function writeIfMissing(root: string, relativePath: string, content: string, result: FeaturePacketResult): Promise<void> {
	const absolutePath = path.join(root, relativePath);
	await mkdir(path.dirname(absolutePath), { recursive: true });
	try {
		await writeFile(absolutePath, content, { flag: "wx" });
		result.created.push(relativePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			result.existing.push(relativePath);
			return;
		}
		throw error;
	}
}

async function readIfExists(root: string, relativePath: string): Promise<string> {
	try {
		return await readFile(path.join(root, relativePath), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

async function existsAsFile(root: string, relativePath: string): Promise<boolean> {
	try {
		const info = await stat(path.join(root, relativePath));
		return info.isFile();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export async function listFeaturePacketSlugs(root: string): Promise<string[]> {
	try {
		const entries = await readdir(path.join(root, "docs", "features"), { withFileTypes: true });
		const slugs: string[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const slug = entry.name;
			if (
				(await existsAsFile(root, `docs/features/${slug}/feature.json`)) ||
				(await existsAsFile(root, `docs/features/${slug}/strategy.md`))
			) {
				slugs.push(slug);
			}
		}
		return slugs.sort((a, b) => a.localeCompare(b));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

async function listFiles(root: string, relativeDir: string, extension: string): Promise<string[]> {
	try {
		const entries = await readdir(path.join(root, relativeDir), { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(extension))
			.map((entry) => `${relativeDir}/${entry.name}`)
			.sort((a, b) => a.localeCompare(b));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function sectionTitleFromPath(relativePath: string): string {
	const name = path.basename(relativePath, path.extname(relativePath));
	return name === "README"
		? path.basename(path.dirname(relativePath)).replace(/-/g, " ")
		: name.replace(/-/g, " ");
}

async function readFeatureMetadata(root: string, slug: string): Promise<FeatureMetadata> {
	const content = await readIfExists(root, `${featurePacketDir(slug)}/feature.json`);
	if (!content.trim()) return {};
	try {
		return JSON.parse(content) as FeatureMetadata;
	} catch {
		return {};
	}
}

async function readMarkdownSections(root: string, relativePaths: string[]): Promise<FeatureSection[]> {
	const sections: FeatureSection[] = [];
	for (const relativePath of relativePaths) {
		sections.push({
			title: sectionTitleFromPath(relativePath),
			path: relativePath,
			content: await readIfExists(root, relativePath),
		});
	}
	return sections;
}

async function readFeatureSections(root: string, slug: string): Promise<FeatureSection[]> {
	const dir = featurePacketDir(slug);
	const primaryPaths = FEATURE_DOC_FILES.map((file) => `${dir}/${file}`);
	const workOrders = (await listFiles(root, `${dir}/work-orders`, ".md")).filter((file) => !file.endsWith("/README.md"));
	const execution = (await listFiles(root, `${dir}/execution`, ".md")).filter((file) => !file.endsWith("/README.md"));
	const supportPaths = [`${dir}/work-orders/README.md`, ...workOrders, `${dir}/execution/README.md`, ...execution, `${dir}/diagrams/README.md`];
	return readMarkdownSections(root, [...primaryPaths, ...supportPaths]);
}

async function readDiagramLinks(root: string, slug: string): Promise<DiagramLink[]> {
	const dir = featurePacketDir(slug);
	const files = (await listFiles(root, `${dir}/diagrams`, ".html")).filter((file) => !file.endsWith("/index.html"));
	return files.map((file) => ({
		title: sectionTitleFromPath(file),
		path: file,
		src: path.posix.relative(dir, file),
	}));
}

function stripYamlInlineComment(value: string): string {
	let quote: string | undefined;
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if ((char === "'" || char === '"') && value[i - 1] !== "\\") {
			quote = quote === char ? undefined : quote ?? char;
			continue;
		}
		if (char === "#" && !quote && (i === 0 || /\s/.test(value[i - 1] ?? ""))) {
			return value.slice(0, i).trim();
		}
	}
	return value.trim();
}

function parseFrontmatter(content: string): Record<string, string> {
	if (!content.startsWith("---")) return {};
	const end = content.indexOf("\n---", 3);
	if (end === -1) return {};
	const frontmatter = content.slice(3, end).trim();
	const data: Record<string, string> = {};
	for (const line of frontmatter.split(/\r?\n/)) {
		const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!match) continue;
		data[match[1] ?? ""] = stripYamlInlineComment(match[2] ?? "").replace(/^['"]|['"]$/g, "").trim();
	}
	return data;
}

function normalizeWorkOrderStatus(value: string | undefined): WorkOrderStatus {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "ready" || normalized === "blocked" || normalized === "done") return normalized;
	return "draft";
}

function workOrderOrderFromPath(relativePath: string): number {
	const match = path.basename(relativePath).match(/^(\d+)/);
	return match?.[1] ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function workOrderTitleFromContent(content: string, relativePath: string): string {
	const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
	return heading || sectionTitleFromPath(relativePath);
}

export function parseWorkOrder(content: string, relativePath: string): WorkOrderInfo {
	const frontmatter = parseFrontmatter(content);
	const fallbackOrder = workOrderOrderFromPath(relativePath);
	const parsedOrder = Number.parseInt(frontmatter.order ?? "", 10);
	return {
		path: relativePath,
		id: frontmatter.id,
		title: frontmatter.title || workOrderTitleFromContent(content, relativePath),
		status: normalizeWorkOrderStatus(frontmatter.status),
		order: Number.isFinite(parsedOrder) ? parsedOrder : fallbackOrder,
	};
}

export async function listWorkOrders(root: string, slug: string): Promise<WorkOrderInfo[]> {
	const dir = `${featurePacketDir(slug)}/work-orders`;
	const files = (await listFiles(root, dir, ".md")).filter((file) => !file.endsWith("/README.md"));
	const workOrders = await Promise.all(files.map(async (file) => parseWorkOrder(await readIfExists(root, file), file)));
	return workOrders.sort((a, b) => a.order - b.order || a.path.localeCompare(b.path));
}

function normalizeExecutionReportStatus(value: string | undefined): ExecutionReportStatus {
	return value?.trim().toLowerCase() === "complete" ? "complete" : "draft";
}

function parseExecutionReport(content: string, relativePath: string): ExecutionReportInfo {
	const frontmatter = parseFrontmatter(content);
	const fallbackOrder = workOrderOrderFromPath(relativePath);
	const parsedOrder = Number.parseInt(frontmatter.order ?? frontmatter.id?.replace(/\D+/g, "") ?? "", 10);
	return {
		path: relativePath,
		id: frontmatter.id,
		workOrder: frontmatter.workOrder,
		status: normalizeExecutionReportStatus(frontmatter.status),
		order: Number.isFinite(parsedOrder) ? parsedOrder : fallbackOrder,
	};
}

export async function listExecutionReports(root: string, slug: string): Promise<ExecutionReportInfo[]> {
	const dir = `${featurePacketDir(slug)}/execution`;
	const files = (await listFiles(root, dir, ".md")).filter((file) => !file.endsWith("/README.md"));
	const reports = await Promise.all(files.map(async (file) => parseExecutionReport(await readIfExists(root, file), file)));
	return reports.sort((a, b) => a.order - b.order || a.path.localeCompare(b.path));
}

function countMatches(content: string, pattern: RegExp): number {
	return [...content.matchAll(pattern)].length;
}

function isDefaultStrategy(content: string): boolean {
	return /What user\/business\/system pain are we solving\?/i.test(content) || /Desired system behavior\s+Describe the plain-language rule/i.test(content);
}

function isDefaultSystemModel(content: string): boolean {
	return /Actor\/input → current components\/functions → current behavior\/output\./i.test(content);
}

function isDefaultDecisions(content: string): boolean {
	return /\| D-001 \| proposed \| TBD \| TBD \| TBD \| TBD \|/i.test(content);
}

function isDefaultProof(content: string): boolean {
	return /\| TBD \| TBD \| planned \| TBD \|/i.test(content);
}

function isDefaultReview(content: string): boolean {
	return /\| TBD \| TBD \| TBD \| TBD \|/i.test(content) || /The mental model future you should remember/i.test(content);
}

function chooseNextAction(input: {
	slug: string;
	missingCoreDocs: string[];
	strategy: string;
	systemModel: string;
	decisions: string;
	proof: string;
	review: string;
	workOrderCount: number;
	readyWorkOrderCount: number;
	draftWorkOrderCount: number;
	blockedWorkOrderCount: number;
	doneWorkOrderCount: number;
	doneWorkOrderWithoutReportCount: number;
	readyWorkOrderPath?: string;
	executionReportCount: number;
	completeExecutionReportCount: number;
	draftExecutionReportCount: number;
	openDecisionCount: number;
	incompleteProofCount: number;
}): { nextAction: string; nextPrompt: string } {
	if (input.missingCoreDocs.length) {
		return {
			nextAction: `Recreate missing feature docs: ${input.missingCoreDocs.join(", ")}`,
			nextPrompt: `Recreate the missing feature packet docs for docs/features/${input.slug}/: ${input.missingCoreDocs.join(", ")}. Preserve existing docs, use the strategy-first templates, and then run /feature view ${input.slug}.`,
		};
	}
	if (isDefaultStrategy(input.strategy)) {
		return {
			nextAction: "Frame the strategy: problem, desired system behavior, constraints, and success signals.",
			nextPrompt: `Help me fill docs/features/${input.slug}/strategy.md. Interview me on the problem, desired system behavior, constraints, non-goals, and success evidence. Do not implement yet.`,
		};
	}
	if (isDefaultSystemModel(input.systemModel)) {
		return {
			nextAction: "Model the current and intended system story with code anchors.",
			nextPrompt: `Inspect the repo and draft docs/features/${input.slug}/system-model.md: current flow, intended flow, key concepts, invariants, boundaries, and code anchors. Ask before making strategic assumptions.`,
		};
	}
	if (input.openDecisionCount > 0 || isDefaultDecisions(input.decisions)) {
		return {
			nextAction: "Resolve strategic decisions before delegation.",
			nextPrompt: `Walk me through the open decisions in docs/features/${input.slug}/decisions.md. Present options, tradeoffs, recommendation, and what I need to decide.`,
		};
	}
	if (input.incompleteProofCount > 0 || isDefaultProof(input.proof)) {
		return {
			nextAction: "Define proof before delegation.",
			nextPrompt: `Update docs/features/${input.slug}/proof.md with acceptance evidence, targeted checks, manual/E2E checks, and regression gates before creating or approving work orders.`,
		};
	}
	if (input.workOrderCount === 0 && input.executionReportCount === 0 && isDefaultReview(input.review)) {
		return {
			nextAction: "Execute directly from approved docs, or create a work order only if delegation is needed.",
			nextPrompt: `Implement directly from docs/features/${input.slug}/strategy.md, system-model.md, decisions.md, and proof.md if this is small enough for one execution step. If delegation or splitting would help, create a draft work order under docs/features/${input.slug}/work-orders/ first. Run proof and record implementation evidence before final review.`,
		};
	}
	if (input.doneWorkOrderWithoutReportCount > 0) {
		return {
			nextAction: "Write missing execution report(s) for completed work orders.",
			nextPrompt: `Create execution report(s) under docs/features/${input.slug}/execution/ for done work orders that do not have reports yet. Link each report to its workOrder id, record repo-relative files changed, proof results, deviations, and strategic follow-up.`,
		};
	}
	if (input.draftExecutionReportCount > 0) {
		return {
			nextAction: "Complete draft execution reports with proof evidence.",
			nextPrompt: `Review draft execution reports under docs/features/${input.slug}/execution/. Add proof evidence, repo-relative changed files, deviations, and strategic follow-up, then mark complete reports as status: complete.`,
		};
	}
	if (input.readyWorkOrderCount > 0) {
		return {
			nextAction: `Execute the first ready work order: ${input.readyWorkOrderPath}`,
			nextPrompt: `Implement the ready work order ${input.readyWorkOrderPath}. Preserve strategic decisions, escalate product/system ambiguity, run proof, write an execution report under docs/features/${input.slug}/execution/, and mark the work order done when complete.`,
		};
	}
	if (input.draftWorkOrderCount > 0 || input.blockedWorkOrderCount > 0) {
		return {
			nextAction: "Review work orders and mark one ready before execution.",
			nextPrompt: `Review the draft/blocked work orders under docs/features/${input.slug}/work-orders/. Resolve strategic ambiguity, verify proof requirements, and change exactly one approved work order to status: ready. Do not implement until a work order is ready.`,
		};
	}
	if (isDefaultReview(input.review)) {
		return {
			nextAction: "Review strategy alignment and write the final teach-back.",
			nextPrompt: `Review strategy alignment for docs/features/${input.slug}/: compare original intent, decisions, implementation, execution reports, and proof. Update review.md with match/mismatch, product/system rule now, what to retain, and follow-ups. If useful, run /reown --remember after the review to save searchable ownership memory.`,
		};
	}
	return {
		nextAction: "Feature packet looks complete; refresh the learning view or decide the next strategic question.",
		nextPrompt: `/feature view ${input.slug}`,
	};
}

export async function getFeaturePacketStatus(root: string, slug: string): Promise<FeaturePacketStatus> {
	const packetDir = featurePacketDir(slug);
	try {
		const info = await stat(path.join(root, packetDir));
		if (!info.isDirectory()) {
			return {
				ok: false,
				slug,
				packetDir,
				missingCoreDocs: [],
				workOrderCount: 0,
				readyWorkOrderCount: 0,
				draftWorkOrderCount: 0,
				blockedWorkOrderCount: 0,
				doneWorkOrderCount: 0,
				doneWorkOrderWithoutReportCount: 0,
				diagramCount: 0,
				executionReportCount: 0,
				completeExecutionReportCount: 0,
				draftExecutionReportCount: 0,
				openDecisionCount: 0,
				incompleteProofCount: 0,
				nextAction: "Create a feature packet first.",
				nextPrompt: `/feature <brief> --slug ${slug}`,
				error: `Feature packet is not a directory: ${packetDir}`,
			};
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {
				ok: false,
				slug,
				packetDir,
				missingCoreDocs: [],
				workOrderCount: 0,
				readyWorkOrderCount: 0,
				draftWorkOrderCount: 0,
				blockedWorkOrderCount: 0,
				doneWorkOrderCount: 0,
				doneWorkOrderWithoutReportCount: 0,
				diagramCount: 0,
				executionReportCount: 0,
				completeExecutionReportCount: 0,
				draftExecutionReportCount: 0,
				openDecisionCount: 0,
				incompleteProofCount: 0,
				nextAction: "Create a feature packet first.",
				nextPrompt: `/feature <brief> --slug ${slug}`,
				error: `Feature packet not found: ${packetDir}`,
			};
		}
		throw error;
	}

	const paths = featurePacketPaths(slug);
	const coreDocs = [paths.strategy, paths.systemModel, paths.decisions, paths.proof, paths.review];
	const missingCoreDocs = [];
	for (const relativePath of coreDocs) {
		if (!(await existsAsFile(root, relativePath))) missingCoreDocs.push(relativePath);
	}

	const strategy = await readIfExists(root, paths.strategy);
	const systemModel = await readIfExists(root, paths.systemModel);
	const decisions = await readIfExists(root, paths.decisions);
	const proof = await readIfExists(root, paths.proof);
	const review = await readIfExists(root, paths.review);
	const workOrders = await listWorkOrders(root, slug);
	const workOrderCount = workOrders.length;
	const readyWorkOrders = workOrders.filter((workOrder) => workOrder.status === "ready");
	const draftWorkOrderCount = workOrders.filter((workOrder) => workOrder.status === "draft").length;
	const blockedWorkOrderCount = workOrders.filter((workOrder) => workOrder.status === "blocked").length;
	const doneWorkOrders = workOrders.filter((workOrder) => workOrder.status === "done");
	const doneWorkOrderCount = doneWorkOrders.length;
	const diagramCount = (await listFiles(root, `${packetDir}/diagrams`, ".html")).filter((file) => !file.endsWith("/index.html")).length;
	const executionReports = await listExecutionReports(root, slug);
	const executionReportCount = executionReports.length;
	const completeExecutionReportCount = executionReports.filter((report) => report.status === "complete").length;
	const draftExecutionReportCount = executionReports.filter((report) => report.status === "draft").length;
	const doneWorkOrderWithoutReportCount = doneWorkOrders.filter((workOrder) => !executionReports.some((report) => reportReferencesWorkOrder(report.workOrder, workOrder))).length;
	const openDecisionCount = countMatches(decisions, /\|\s*D-\d+\s*\|\s*(?:proposed|open|todo|TBD)/gi) + countMatches(decisions, /- \[ \]/g);
	const incompleteProofCount = countMatches(proof, /\|[^\n|]*(?:planned|TBD|todo)[^\n|]*\|/gi) + countMatches(proof, /- \[ \]/g);
	const next = chooseNextAction({
		slug,
		missingCoreDocs,
		strategy,
		systemModel,
		decisions,
		proof,
		review,
		workOrderCount,
		readyWorkOrderCount: readyWorkOrders.length,
		draftWorkOrderCount,
		blockedWorkOrderCount,
		doneWorkOrderCount,
		doneWorkOrderWithoutReportCount,
		readyWorkOrderPath: readyWorkOrders[0]?.path,
		executionReportCount,
		completeExecutionReportCount,
		draftExecutionReportCount,
		openDecisionCount,
		incompleteProofCount,
	});

	return {
		ok: true,
		slug,
		packetDir,
		missingCoreDocs,
		workOrderCount,
		readyWorkOrderCount: readyWorkOrders.length,
		draftWorkOrderCount,
		blockedWorkOrderCount,
		doneWorkOrderCount,
		doneWorkOrderWithoutReportCount,
		readyWorkOrderPath: readyWorkOrders[0]?.path,
		diagramCount,
		executionReportCount,
		completeExecutionReportCount,
		draftExecutionReportCount,
		openDecisionCount,
		incompleteProofCount,
		...next,
	};
}

function featurePacketDisplayState(status: FeaturePacketStatus): string {
	if (!status.ok) return "missing";
	if (status.missingCoreDocs.length) return "incomplete";
	if (/^(Frame|Model|Resolve|Define proof)\b/i.test(status.nextAction)) return "incomplete";
	if (status.doneWorkOrderWithoutReportCount > 0) return "needs-report";
	if (status.draftExecutionReportCount > 0) return "needs-report";
	if (/^Execute directly\b/i.test(status.nextAction)) return "ready-to-execute";
	if (status.readyWorkOrderCount > 0) return "ready-to-execute";
	if (status.draftWorkOrderCount > 0 || status.blockedWorkOrderCount > 0) return "needs-review";
	if (/^Review strategy alignment\b/i.test(status.nextAction)) return "needs-review";
	return "ready";
}

export function formatFeaturePacketStatus(status: FeaturePacketStatus): string {
	const lines = [
		`# Feature Status: ${status.slug}`,
		"",
		`Packet: ${status.packetDir}`,
		`State: ${featurePacketDisplayState(status)}`,
		"",
		"## Counts",
		`- Work orders: ${status.workOrderCount} (${status.readyWorkOrderCount} ready, ${status.draftWorkOrderCount} draft, ${status.blockedWorkOrderCount} blocked, ${status.doneWorkOrderCount} done, ${status.doneWorkOrderWithoutReportCount} missing report)`,
		`- Diagrams: ${status.diagramCount}`,
		`- Execution reports: ${status.executionReportCount} (${status.completeExecutionReportCount} complete, ${status.draftExecutionReportCount} draft)`,
		`- Open decisions: ${status.openDecisionCount}`,
		`- Incomplete proof items: ${status.incompleteProofCount}`,
		"",
	];
	if (status.missingCoreDocs.length) {
		lines.push("## Missing core docs", ...status.missingCoreDocs.map((doc) => `- ${doc}`), "");
	}
	if (status.error) {
		lines.push("## Error", status.error, "");
	}
	lines.push("## Next action", status.nextAction, "", "## Suggested prompt", status.nextPrompt);
	return lines.join("\n");
}

export async function initializeFeaturePacket(root: string, input: FeaturePacketInput): Promise<FeaturePacketResult> {
	const paths = featurePacketPaths(input.slug);
	const result: FeaturePacketResult = {
		packetDir: paths.strategy.split("/strategy.md")[0] ?? featurePacketDir(input.slug),
		indexPath: paths.index,
		created: [],
		existing: [],
	};

	await writeIfMissing(root, paths.metadata, buildMetadataJson(input), result);
	await writeIfMissing(root, paths.strategy, buildStrategyMarkdown(input), result);
	await writeIfMissing(root, paths.systemModel, buildSystemModelMarkdown(input), result);
	await writeIfMissing(root, paths.decisions, buildDecisionsMarkdown(input), result);
	await writeIfMissing(root, paths.proof, buildProofMarkdown(input), result);
	await writeIfMissing(root, paths.review, buildReviewMarkdown(input), result);
	await writeIfMissing(root, paths.workOrdersReadme, buildWorkOrdersReadme(input), result);
	await writeIfMissing(root, paths.executionReadme, buildExecutionReadme(input), result);
	await writeIfMissing(root, paths.diagramsReadme, buildDiagramsReadme(input), result);

	const rebuilt = await rebuildFeatureLearningView(root, input.slug, {
		brief: input.brief,
		branch: input.branch,
	});
	if (!rebuilt.ok) throw new Error(rebuilt.error);
	if (!result.created.includes(paths.index) && !result.existing.includes(paths.index)) result.created.push(paths.index);
	return result;
}

export async function rebuildFeatureLearningView(
	root: string,
	slug: string,
	metadata: { brief?: string; branch?: string } = {},
): Promise<RebuildFeatureViewResult> {
	const packetDir = featurePacketDir(slug);
	const absoluteDir = path.join(root, packetDir);
	try {
		const info = await stat(absoluteDir);
		if (!info.isDirectory()) return { ok: false, error: `Feature packet is not a directory: ${packetDir}`, packetDir };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { ok: false, error: `Feature packet not found: ${packetDir}`, packetDir };
		}
		throw error;
	}

	const storedMetadata = await readFeatureMetadata(root, slug);
	const sections = await readFeatureSections(root, slug);
	const diagrams = await readDiagramLinks(root, slug);
	const status = await getFeaturePacketStatus(root, slug);
	const workOrders = await listWorkOrders(root, slug);
	const executionReports = await listExecutionReports(root, slug);
	const html = buildFeatureLearningHtml({ ...storedMetadata, ...metadata, slug, sections, diagrams, status, workOrders, executionReports });
	const indexPath = `${packetDir}/index.html`;
	await writeFile(path.join(root, indexPath), html);
	return { ok: true, packetDir, indexPath, sectionCount: sections.length };
}
