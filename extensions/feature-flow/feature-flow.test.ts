import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import featureFlowExtension from "./index.ts";
import { createExecutionReport, createWorkOrder, formatFeaturePacketStatus, getFeaturePacketStatus, initializeFeaturePacket, markdownToHtml, rebuildFeatureLearningView } from "./packet.ts";
import { buildKickoffPrompt } from "./prompt.ts";

function createHarness(root: string) {
	const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	const eventHandlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
	const notifications: Array<{ message: string; level: string }> = [];
	const execCalls: Array<{ command: string; args: string[] }> = [];
	const messages: Array<{ customType: string; content: string; display?: boolean }> = [];
	const statuses: Array<{ key: string; value: string | undefined }> = [];
	let editorText = "";
	const pi = {
		registerCommand(name: string, definition: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, definition);
		},
		on(eventName: string, handler: (event: any, ctx: any) => Promise<any>) {
			eventHandlers.set(eventName, handler);
		},
		exec: async (command: string, args: string[]) => {
			execCalls.push({ command, args });
			return { code: 0, stdout: "", stderr: "" };
		},
		sendMessage(message: { customType: string; content: string; display?: boolean }) {
			messages.push(message);
		},
	};
	const ctx = {
		cwd: root,
		hasUI: false,
		ui: {
			setEditorText(text: string) {
				editorText = text;
			},
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
			setStatus(key: string, value: string | undefined) {
				statuses.push({ key, value });
			},
		},
	};
	return { pi, ctx, commands, eventHandlers, notifications, execCalls, getEditorText: () => editorText, getMessages: () => messages, getStatuses: () => statuses };
}

test("buildKickoffPrompt starts a strategy-first docs/features workflow", () => {
	const prompt = buildKickoffPrompt({
		brief: "Add review summaries to pull request mode",
		slug: "pr-review-summaries",
		branch: "feat/pr-review-summaries",
		workspacePath: "/tmp/pi-config-pr-review-summaries",
		fallbackUsed: false,
	});

	assert.match(prompt, /strategy-first feature workflow/i);
	assert.match(prompt, /user owns product strategy, system design, solution architecture/i);
	assert.match(prompt, /agent owns execution mechanics/i);
	assert.match(prompt, /Strategy → System model → Design → Architecture decisions → Work orders → Execute\/report → Review → PR\/user guide/i);
	assert.match(prompt, /lightest workflow that preserves user ownership of strategy and solution design/i);
	assert.match(prompt, /Design-to-execution matters/i);
	assert.match(prompt, /feature packet lives under docs\/features\/ by default, not \.features\//i);
	assert.match(prompt, /docs\/features\/pr-review-summaries\/strategy\.md/i);
	assert.match(prompt, /docs\/features\/pr-review-summaries\/system-model\.md/i);
	assert.match(prompt, /docs\/features\/pr-review-summaries\/decisions\.md/i);
	assert.match(prompt, /docs\/features\/pr-review-summaries\/proof\.md/i);
	assert.match(prompt, /docs\/features\/pr-review-summaries\/work-orders\//i);
	assert.match(prompt, /docs\/features\/pr-review-summaries\/diagrams\//i);
	assert.match(prompt, /docs\/features\/pr-review-summaries\/index\.html/i);
	assert.match(prompt, /system-diagram skill/i);
	assert.match(prompt, /code flow, component communication, domain concepts/i);
	assert.match(prompt, /Do not create \.features\/ task state unless the user explicitly asks/i);
	assert.match(prompt, /review the model before relying on it as execution authority/i);
	assert.match(prompt, /Review the work-order split with the user before running a loop or executing a ready work order/i);
	assert.doesNotMatch(prompt, /docs\/features\/pr-review-summaries\/prd\.md/i);
	assert.doesNotMatch(prompt, /docs\/features\/pr-review-summaries\/design\.md/i);
	assert.doesNotMatch(prompt, /\.features\/pr-review-summaries\/tasks\//i);
	assert.doesNotMatch(prompt, new RegExp(`After PRD approv${"al"}`, "i"));
	assert.doesNotMatch(prompt, new RegExp(`After design approv${"al"}`, "i"));
});

test("buildKickoffPrompt preserves fallback mode context", () => {
	const prompt = buildKickoffPrompt({
		brief: "Improve feature kickoff",
		slug: "feature-kickoff",
		branch: "feat/feature-kickoff",
		workspacePath: "/tmp/pi-config-feature-kickoff",
		fallbackUsed: true,
		fallbackReason: "git worktree add failed",
	});

	assert.match(prompt, /single-working-copy fallback mode/i);
	assert.match(prompt, /Reason: git worktree add failed/i);
});

test("buildKickoffPrompt includes initialized feature packet paths when provided", () => {
	const prompt = buildKickoffPrompt({
		brief: "Improve feature kickoff",
		slug: "feature-kickoff",
		branch: "feat/feature-kickoff",
		workspacePath: "/tmp/pi-config-feature-kickoff",
		fallbackUsed: false,
		packetDir: "docs/features/feature-kickoff",
		learningViewPath: "docs/features/feature-kickoff/index.html",
	});

	assert.match(prompt, /Feature Packet/i);
	assert.match(prompt, /Source docs: docs\/features\/feature-kickoff/i);
	assert.match(prompt, /Learning view: docs\/features\/feature-kickoff\/index\.html/i);
	assert.match(prompt, /markdown docs as source of truth/i);
});

test("initializeFeaturePacket scaffolds docs/features learning packet without legacy .features state", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "feature-flow-"));
	const result = await initializeFeaturePacket(root, {
		brief: "Make re-own useful for strategic understanding",
		slug: "reown-strategy",
		branch: "feat/reown-strategy",
		workspacePath: root,
		createdDate: "2026-05-26",
	});

	assert.equal(result.packetDir, "docs/features/reown-strategy");
	assert.equal(result.indexPath, "docs/features/reown-strategy/index.html");
	assert.ok(result.created.includes("docs/features/reown-strategy/feature.json"));
	assert.ok(result.created.includes("docs/features/reown-strategy/strategy.md"));
	assert.ok(result.created.includes("docs/features/reown-strategy/system-model.md"));
	assert.ok(result.created.includes("docs/features/reown-strategy/decisions.md"));
	assert.ok(result.created.includes("docs/features/reown-strategy/proof.md"));
	assert.ok(result.created.includes("docs/features/reown-strategy/review.md"));
	assert.ok(result.created.includes("docs/features/reown-strategy/work-orders/README.md"));
	assert.ok(result.created.includes("docs/features/reown-strategy/execution/README.md"));
	assert.ok(result.created.includes("docs/features/reown-strategy/diagrams/README.md"));
	assert.ok(result.created.includes("docs/features/reown-strategy/index.html"));

	const strategy = await readFile(path.join(root, "docs/features/reown-strategy/strategy.md"), "utf8");
	assert.match(strategy, /Problem to own/i);
	assert.match(strategy, /Desired system behavior/i);
	assert.match(strategy, /Teach-back/i);
	const review = await readFile(path.join(root, "docs/features/reown-strategy/review.md"), "utf8");
	assert.match(review, /PR summary draft/i);
	assert.match(review, /User guide \/ manual draft/i);
	const systemModel = await readFile(path.join(root, "docs/features/reown-strategy/system-model.md"), "utf8");
	assert.match(systemModel, /## Solution design/i);
	assert.match(systemModel, /## Execution slices \/ Work Order plan/i);

	const index = await readFile(path.join(root, "docs/features/reown-strategy/index.html"), "utf8");
	assert.match(index, /Feature Learning View/i);
	assert.match(index, /Feature Dashboard/i);
	assert.match(index, /generated learning manual/i);
	assert.match(index, /Work order states/i);
	assert.match(index, /Review \/ PR \/ User Guide/i);
	assert.match(index, /PR summary draft/i);
	assert.match(index, /user-guide\/manual draft/i);
	assert.match(index, /docs\/features\/reown-strategy\/strategy\.md/i);
	const diagramsReadme = await readFile(path.join(root, "docs/features/reown-strategy/diagrams/README.md"), "utf8");
	assert.match(diagramsReadme, /code-flow\.html/i);
	assert.match(diagramsReadme, /communication-map\.html/i);
	assert.match(diagramsReadme, /domain-model\.html/i);
	assert.match(diagramsReadme, /system-diagram skill/i);
	const metadataText = await readFile(path.join(root, "docs/features/reown-strategy/feature.json"), "utf8");
	const metadata = JSON.parse(metadataText);
	assert.equal(metadata.brief, "Make re-own useful for strategic understanding");
	assert.equal(metadata.workspacePath, undefined);
	assert.doesNotMatch(metadataText, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.doesNotMatch(strategy, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.doesNotMatch(index, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	await assert.rejects(stat(path.join(root, ".features")), { code: "ENOENT" });
});

test("initializeFeaturePacket preserves existing source docs and rebuilds learning view", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "feature-flow-"));
	await mkdir(path.join(root, "docs/features/reown-strategy"), { recursive: true });
	await writeFile(path.join(root, "docs/features/reown-strategy/strategy.md"), "# Custom Strategy\n\nKeep this.", { flag: "wx" });

	const result = await initializeFeaturePacket(root, {
		brief: "Make re-own useful for strategic understanding",
		slug: "reown-strategy",
		branch: "feat/reown-strategy",
		workspacePath: root,
		createdDate: "2026-05-26",
	});

	assert.ok(result.existing.includes("docs/features/reown-strategy/strategy.md"));
	const strategy = await readFile(path.join(root, "docs/features/reown-strategy/strategy.md"), "utf8");
	assert.equal(strategy, "# Custom Strategy\n\nKeep this.");

	const index = await readFile(path.join(root, "docs/features/reown-strategy/index.html"), "utf8");
	assert.match(index, /Custom Strategy/i);
	assert.match(index, /Keep this\./i);
});

test("/feature migrate upgrades legacy PRD/design/tasks without deleting sources", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "feature-flow-"));
	await mkdir(path.join(root, "docs/features/legacy-checkout"), { recursive: true });
	await mkdir(path.join(root, ".features/legacy-checkout/tasks"), { recursive: true });
	await writeFile(path.join(root, "docs/features/legacy-checkout/prd.md"), "# PRD: Legacy Checkout\n\n## Problem\n\nCheckout needs saved cards.");
	await writeFile(path.join(root, "docs/features/legacy-checkout/design.md"), "# Design: Legacy Checkout\n\nUse the existing payment service boundary.");
	await writeFile(path.join(root, ".features/legacy-checkout/tasks/001-add-saved-card-api.md"), `---\nid: 001\nstatus: open\n---\n\n# Add saved card API\n\n## What to do\n\nCreate the endpoint.\n\n## Verify\n\nnpm test\n`);
	const harness = createHarness(root);
	featureFlowExtension(harness.pi as any);

	await harness.commands.get("feature")?.handler("migrate legacy-checkout", harness.ctx as any);

	assert.match(harness.getMessages().at(-1)?.content ?? "", /# Feature Migration: legacy-checkout/);
	assert.match(harness.getMessages().at(-1)?.content ?? "", /docs\/features\/legacy-checkout\/prd\.md/);
	assert.match(harness.getMessages().at(-1)?.content ?? "", /\.features\/legacy-checkout\/tasks\/001-add-saved-card-api\.md/);
	assert.match(harness.notifications.at(-1)?.message ?? "", /Migrated feature packet/i);
	const strategy = await readFile(path.join(root, "docs/features/legacy-checkout/strategy.md"), "utf8");
	assert.match(strategy, /Migrated from legacy PRD\/design artifacts/i);
	assert.match(strategy, /Checkout needs saved cards/i);
	const systemModel = await readFile(path.join(root, "docs/features/legacy-checkout/system-model.md"), "utf8");
	assert.match(systemModel, /Migrated 1 legacy task/);
	assert.match(systemModel, /Use the existing payment service boundary/i);
	const workOrder = await readFile(path.join(root, "docs/features/legacy-checkout/work-orders/001-add-saved-card-api.md"), "utf8");
	assert.match(workOrder, /id: WO-001/);
	assert.match(workOrder, /status: draft/);
	assert.match(workOrder, /legacySource: \.features\/legacy-checkout\/tasks\/001-add-saved-card-api\.md/);
	assert.match(workOrder, /# Add saved card API/);
	const index = await readFile(path.join(root, "docs/features/legacy-checkout/index.html"), "utf8");
	assert.match(index, /Feature Dashboard/);
	assert.match(index, /WO-001/);
	await readFile(path.join(root, "docs/features/legacy-checkout/prd.md"), "utf8");
});

test("/feature migrate allocates around unrelated work orders and keeps blocked legacy tasks draft", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "feature-flow-"));
	await mkdir(path.join(root, "docs/features/legacy-checkout/work-orders"), { recursive: true });
	await mkdir(path.join(root, ".features/legacy-checkout/tasks"), { recursive: true });
	await writeFile(path.join(root, "docs/features/legacy-checkout/work-orders/001-existing-slice.md"), `---\nid: WO-001\nstatus: ready\norder: 1\n---\n\n# WO-001: Existing Slice\n`);
	await writeFile(path.join(root, ".features/legacy-checkout/tasks/001-add-saved-card-api.md"), `---\nid: 001\nstatus: blocked\n---\n\n# Add saved card API\n\nNeeds strategy review.\n`);
	const harness = createHarness(root);
	featureFlowExtension(harness.pi as any);

	await harness.commands.get("feature")?.handler("migrate legacy-checkout", harness.ctx as any);

	const workOrder = await readFile(path.join(root, "docs/features/legacy-checkout/work-orders/002-add-saved-card-api.md"), "utf8");
	assert.match(workOrder, /id: WO-002/);
	assert.match(workOrder, /status: draft/);
	assert.match(workOrder, /legacyStatus: blocked/);
	assert.match(workOrder, /legacySource: \.features\/legacy-checkout\/tasks\/001-add-saved-card-api\.md/);
	assert.doesNotMatch(workOrder.split("---")[1] ?? "", /^status: blocked$/m);

	await harness.commands.get("feature")?.handler("migrate legacy-checkout", harness.ctx as any);
	await assert.rejects(stat(path.join(root, "docs/features/legacy-checkout/work-orders/003-add-saved-card-api.md")), { code: "ENOENT" });
	assert.match(harness.getMessages().at(-1)?.content ?? "", /docs\/features\/legacy-checkout\/work-orders\/002-add-saved-card-api\.md/);
});

test("/feature migrate preserves existing packet docs and reports missing legacy sources", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "feature-flow-"));
	await mkdir(path.join(root, "docs/features/legacy-checkout"), { recursive: true });
	await writeFile(path.join(root, "docs/features/legacy-checkout/prd.md"), "# PRD: Legacy Checkout\n\nKeep old source.");
	await writeFile(path.join(root, "docs/features/legacy-checkout/strategy.md"), "# Custom Strategy\n\nDo not overwrite.");
	const harness = createHarness(root);
	featureFlowExtension(harness.pi as any);

	await harness.commands.get("feature")?.handler("migrate legacy-checkout", harness.ctx as any);

	const strategy = await readFile(path.join(root, "docs/features/legacy-checkout/strategy.md"), "utf8");
	assert.equal(strategy, "# Custom Strategy\n\nDo not overwrite.");
	assert.match(harness.getMessages().at(-1)?.content ?? "", /Existing \/ preserved/);
	assert.match(harness.getMessages().at(-1)?.content ?? "", /docs\/features\/legacy-checkout\/strategy\.md/);

	await harness.commands.get("feature")?.handler("migrate missing-legacy", harness.ctx as any);
	assert.match(harness.getMessages().at(-1)?.content ?? "", /Feature Migration Failed: missing-legacy/);
	assert.match(harness.notifications.at(-1)?.message ?? "", /No legacy PRD\/design\/tasks found/i);
});

test("rebuildFeatureLearningView reports missing feature packet", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "feature-flow-"));
	const result = await rebuildFeatureLearningView(root, "missing-feature");

	assert.deepEqual(result, {
		ok: false,
		error: "Feature packet not found: docs/features/missing-feature",
		packetDir: "docs/features/missing-feature",
	});
});

test("status suggests recreating missing core docs instead of refreshing the view", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "feature-flow-"));
	await initializeFeaturePacket(root, {
		brief: "Make re-own useful for strategic understanding",
		slug: "reown-strategy",
		branch: "feat/reown-strategy",
		workspacePath: root,
		createdDate: "2026-05-26",
	});
	await rm(path.join(root, "docs/features/reown-strategy/system-model.md"));

	const status = await getFeaturePacketStatus(root, "reown-strategy");

	assert.match(status.nextAction, /Recreate missing feature docs/i);
	assert.equal(Object.keys(status).includes(`next${"Prompt"}`), false);
	assert.match(formatFeaturePacketStatus(status), /State: incomplete/);
});

test("work order status requires review before execution", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "feature-flow-"));
	await initializeFeaturePacket(root, {
		brief: "Make re-own useful for strategic understanding",
		slug: "reown-strategy",
		branch: "feat/reown-strategy",
		workspacePath: root,
		createdDate: "2026-05-26",
	});
	await writeFile(path.join(root, "docs/features/reown-strategy/strategy.md"), "# Strategy\n\nProblem and desired system behavior are reviewed.");
	await writeFile(path.join(root, "docs/features/reown-strategy/system-model.md"), "# System Model\n\nCurrent and intended flows are modeled.");
	await writeFile(path.join(root, "docs/features/reown-strategy/decisions.md"), "# Decisions\n\n| ID | Status | Decision | Why |\n| --- | --- | --- | --- |\n| D-001 | decided | Keep strategy authority with the user | Prevent silent scope changes |\n");
	await writeFile(path.join(root, "docs/features/reown-strategy/proof.md"), "# Proof\n\nAcceptance evidence and regression gate are defined.");
	const created = await createWorkOrder(root, "reown-strategy", "Change re-own output");
	assert.equal(created.ok, true);

	let status = await getFeaturePacketStatus(root, "reown-strategy");
	assert.equal(status.workOrderCount, 1);
	assert.equal(status.draftWorkOrderCount, 1);
	assert.equal(status.readyWorkOrderCount, 0);
	assert.match(status.nextAction, /Review work orders and select one ready/i);
	assert.equal(Object.keys(status).includes(`next${"Prompt"}`), false);

	const workOrderPath = created.ok ? created.path : "";
	const content = await readFile(path.join(root, workOrderPath), "utf8");
	await writeFile(path.join(root, workOrderPath), content.replace("status: draft", "status: ready # reviewed"));
	status = await getFeaturePacketStatus(root, "reown-strategy");

	assert.equal(status.readyWorkOrderCount, 1);
	assert.equal(status.readyWorkOrderPath, "docs/features/reown-strategy/work-orders/001-change-re-own-output.md");
	assert.match(status.nextAction, /Execute the first ready work order: docs\/features\/reown-strategy\/work-orders\/001-change-re-own-output\.md/);

	await writeFile(path.join(root, workOrderPath), content.replace("status: draft", "status: done # implemented"));
	status = await getFeaturePacketStatus(root, "reown-strategy");
	assert.equal(status.doneWorkOrderCount, 1);
	assert.equal(status.executionReportCount, 0);
	assert.match(status.nextAction, /Write missing execution report/i);

	const report = await createExecutionReport(root, "reown-strategy", "WO-001");
	assert.equal(report.ok, true);
	status = await getFeaturePacketStatus(root, "reown-strategy");
	assert.equal(status.executionReportCount, 1);
	assert.equal(status.draftExecutionReportCount, 1);
	assert.match(status.nextAction, /Complete draft execution reports/i);
});

test("work orders are optional for direct execution and completed zero-work-order packets", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "feature-flow-"));
	await initializeFeaturePacket(root, {
		brief: "Make re-own useful for strategic understanding",
		slug: "reown-strategy",
		branch: "feat/reown-strategy",
		workspacePath: root,
		createdDate: "2026-05-26",
	});
	await writeFile(path.join(root, "docs/features/reown-strategy/strategy.md"), "# Strategy\n\nProblem and desired system behavior are reviewed.");
	await writeFile(path.join(root, "docs/features/reown-strategy/system-model.md"), "# System Model\n\nCurrent and intended flows are modeled.");
	await writeFile(path.join(root, "docs/features/reown-strategy/decisions.md"), "# Decisions\n\n| ID | Status | Decision | Why |\n| --- | --- | --- | --- |\n| D-001 | decided | Keep strategy authority with the user | Prevent silent scope changes |\n");
	await writeFile(path.join(root, "docs/features/reown-strategy/proof.md"), "# Proof\n\nAcceptance evidence and regression gate are defined.");

	let status = await getFeaturePacketStatus(root, "reown-strategy");
	assert.equal(status.workOrderCount, 0);
	assert.match(status.nextAction, /Execute directly from reviewed docs/i);
	assert.equal(Object.keys(status).includes(`next${"Prompt"}`), false);
	assert.match(formatFeaturePacketStatus(status), /State: ready-to-execute/);

	await writeFile(path.join(root, "docs/features/reown-strategy/review.md"), "# Review\n\nImplementation matches strategy and proof passed.");
	status = await getFeaturePacketStatus(root, "reown-strategy");
	assert.match(status.nextAction, /Feature packet looks complete/i);
	assert.doesNotMatch(status.nextAction, /Create work orders/i);
});

test("status state reflects unresolved strategy/proof before ready", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "feature-flow-"));
	await initializeFeaturePacket(root, {
		brief: "Make re-own useful for strategic understanding",
		slug: "reown-strategy",
		branch: "feat/reown-strategy",
		workspacePath: root,
		createdDate: "2026-05-26",
	});

	const status = await getFeaturePacketStatus(root, "reown-strategy");

	assert.match(status.nextAction, /Frame the strategy/i);
	assert.match(formatFeaturePacketStatus(status), /State: incomplete/);
});

test("rebuildFeatureLearningView aggregates work orders, execution reports, diagrams, and tables", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "feature-flow-"));
	await initializeFeaturePacket(root, {
		brief: "Make re-own useful for strategic understanding",
		slug: "reown-strategy",
		branch: "feat/reown-strategy",
		workspacePath: root,
		createdDate: "2026-05-26",
	});
	await writeFile(path.join(root, "docs/features/reown-strategy/work-orders/001-review-output.md"), "# Work Order 001\n\n| Mission | Proof |\n| --- | --- |\n| Change review output | npm test |", { flag: "wx" });
	await writeFile(path.join(root, "docs/features/reown-strategy/execution/001-report.md"), "# Execution Report 001\n\nProof passed.", { flag: "wx" });
	await writeFile(path.join(root, "docs/features/reown-strategy/diagrams/code-flow.html"), "<!doctype html><title>Code Flow</title>", { flag: "wx" });

	const result = await rebuildFeatureLearningView(root, "reown-strategy");
	assert.equal(result.ok, true);
	const index = await readFile(path.join(root, "docs/features/reown-strategy/index.html"), "utf8");

	assert.match(index, /Feature Dashboard/);
	assert.match(index, /Next action/);
	assert.match(index, /Work order states/);
	assert.match(index, /Execution evidence/);
	assert.match(index, /Diagram links/);
	assert.match(index, /Proof gaps/);
	assert.match(index, /Work Order 001/);
	assert.match(index, /Execution Report 001/);
	assert.match(index, /<table>/);
	assert.match(index, /Change review output/);
	assert.match(index, /System Diagrams/);
	assert.match(index, /src="diagrams\/code-flow\.html"/);
});

test("/feature view regenerates and opens the learning view", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "feature-flow-"));
	await initializeFeaturePacket(root, {
		brief: "Make re-own useful for strategic understanding",
		slug: "reown-strategy",
		branch: "feat/reown-strategy",
		workspacePath: root,
		createdDate: "2026-05-26",
	});
	const harness = createHarness(root);
	featureFlowExtension(harness.pi as any);

	await harness.commands.get("feature")?.handler("view reown-strategy", harness.ctx as any);

	assert.equal(harness.getMessages().at(-1)?.content, "docs/features/reown-strategy/index.html");
	assert.equal(harness.execCalls.length, 1);
	assert.match(harness.execCalls[0]?.args.join(" ") ?? "", /file:\/\//);
	assert.match(harness.notifications.at(-1)?.message ?? "", /Opened feature learning view/i);
});

test("/feature view reports missing feature packets without opening a browser", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "feature-flow-"));
	const harness = createHarness(root);
	featureFlowExtension(harness.pi as any);

	await harness.commands.get("feature")?.handler("view missing-feature", harness.ctx as any);

	assert.equal(harness.execCalls.length, 0);
	assert.match(harness.getMessages().at(-1)?.content ?? "", /docs\/features\/missing-feature/);
	assert.match(harness.notifications.at(-1)?.message ?? "", /Feature packet not found/i);
});

test("/feature status summarizes packet counts and next action", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "feature-flow-"));
	await initializeFeaturePacket(root, {
		brief: "Make re-own useful for strategic understanding",
		slug: "reown-strategy",
		branch: "feat/reown-strategy",
		workspacePath: root,
		createdDate: "2026-05-26",
	});
	await writeFile(path.join(root, "docs/features/reown-strategy/work-orders/001-review-output.md"), "# Work Order 001", { flag: "wx" });
	await writeFile(path.join(root, "docs/features/reown-strategy/diagrams/code-flow.html"), "<!doctype html><title>Code Flow</title>", { flag: "wx" });
	const harness = createHarness(root);
	featureFlowExtension(harness.pi as any);

	await harness.commands.get("feature")?.handler("status reown-strategy", harness.ctx as any);

	assert.match(harness.getMessages().at(-1)?.content ?? "", /# Feature Status: reown-strategy/);
	assert.match(harness.getMessages().at(-1)?.content ?? "", /Work orders: 1/);
	assert.match(harness.getMessages().at(-1)?.content ?? "", /Diagrams: 1/);
	assert.match(harness.getMessages().at(-1)?.content ?? "", /Next action/);
	assert.match(harness.getStatuses().at(-1)?.value ?? "", /feature: reown-strategy/);
	assert.match(harness.notifications.at(-1)?.message ?? "", /Feature status shown/i);
});

test("/feature next shows only the next action", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "feature-flow-"));
	await initializeFeaturePacket(root, {
		brief: "Make re-own useful for strategic understanding",
		slug: "reown-strategy",
		branch: "feat/reown-strategy",
		workspacePath: root,
		createdDate: "2026-05-26",
	});
	const harness = createHarness(root);
	featureFlowExtension(harness.pi as any);

	await harness.commands.get("feature")?.handler("next reown-strategy", harness.ctx as any);

	assert.equal(harness.getEditorText(), "");
	assert.match(harness.getMessages().at(-1)?.content ?? "", /# Feature Next: reown-strategy/);
	assert.match(harness.getMessages().at(-1)?.content ?? "", /Frame the strategy/i);
	assert.doesNotMatch(harness.getMessages().at(-1)?.content ?? "", /Interview me/i);
	assert.match(harness.notifications.at(-1)?.message ?? "", /Next action/i);
});

test("/feature next moves from reviewed strategy to solution design", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "feature-flow-"));
	await initializeFeaturePacket(root, {
		brief: "Make re-own useful for strategic understanding",
		slug: "reown-strategy",
		branch: "feat/reown-strategy",
		workspacePath: root,
		createdDate: "2026-05-26",
	});
	await writeFile(path.join(root, "docs/features/reown-strategy/strategy.md"), "# Strategy\n\nProblem, desired system behavior, constraints, and success signals are reviewed.");
	const harness = createHarness(root);
	featureFlowExtension(harness.pi as any);

	await harness.commands.get("feature")?.handler("next reown-strategy", harness.ctx as any);

	assert.equal(harness.getEditorText(), "");
	assert.match(harness.getMessages().at(-1)?.content ?? "", /# Feature Next: reown-strategy/);
	assert.match(harness.getMessages().at(-1)?.content ?? "", /Model\/design the solution before execution/i);
	assert.doesNotMatch(harness.getMessages().at(-1)?.content ?? "", /\/feature design reown-strategy/);
	assert.match(harness.notifications.at(-1)?.message ?? "", /Model\/design the solution before execution/i);
});

test("feature-flow does not intercept natural-language input", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "feature-flow-"));
	const harness = createHarness(root);
	featureFlowExtension(harness.pi as any);

	assert.equal(harness.eventHandlers.has("input"), false);
});

test("/feature design shows a review-before-execution solution-design prompt", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "feature-flow-"));
	await initializeFeaturePacket(root, {
		brief: "Make re-own useful for strategic understanding",
		slug: "reown-strategy",
		branch: "feat/reown-strategy",
		workspacePath: root,
		createdDate: "2026-05-26",
	});
	const harness = createHarness(root);
	featureFlowExtension(harness.pi as any);

	await harness.commands.get("feature")?.handler("design reown-strategy", harness.ctx as any);

	assert.match(harness.getMessages().at(-1)?.content ?? "", /Partner with me as a solution architect/i);
	assert.match(harness.getMessages().at(-1)?.content ?? "", /Do not implement code yet/i);
	assert.match(harness.getMessages().at(-1)?.content ?? "", /system-model\.md/);
	assert.match(harness.getMessages().at(-1)?.content ?? "", /decisions\.md/);
	assert.match(harness.getMessages().at(-1)?.content ?? "", /proof\.md/);
	assert.match(harness.getMessages().at(-1)?.content ?? "", /draft Work Orders/i);
	assert.match(harness.getMessages().at(-1)?.content ?? "", /Do not mark work orders ready/i);
	assert.match(harness.getMessages().at(-1)?.content ?? "", /review the design and work-order split before any loop or execution starts/i);
	assert.match(harness.notifications.at(-1)?.message ?? "", /solution-design prompt/i);
});

test("/feature work-order creates a review-before-execution delegation brief", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "feature-flow-"));
	await initializeFeaturePacket(root, {
		brief: "Make re-own useful for strategic understanding",
		slug: "reown-strategy",
		branch: "feat/reown-strategy",
		workspacePath: root,
		createdDate: "2026-05-26",
	});
	const harness = createHarness(root);
	featureFlowExtension(harness.pi as any);

	await harness.commands.get("feature")?.handler("work-order Change re-own output", harness.ctx as any);

	assert.equal(harness.getMessages().at(-1)?.content, "docs/features/reown-strategy/work-orders/001-change-re-own-output.md");
	const workOrder = await readFile(path.join(root, harness.getMessages().at(-1)?.content ?? ""), "utf8");
	assert.match(workOrder, /status: draft/);
	assert.match(workOrder, /## Mission/);
	assert.match(workOrder, /## Code anchors/);
	assert.match(workOrder, /code_find\/semantic_search/);
	assert.match(workOrder, /## Minimal-change plan/);
	assert.match(workOrder, /broad refactor looks necessary/);
	assert.match(workOrder, /## Escalation triggers/);
	assert.match(workOrder, /## Proof required/);
	assert.match(workOrder, /Review this work order before changing `status` to `ready`/);
	assert.match(harness.notifications.at(-1)?.message ?? "", /Created draft work order/i);

	await harness.commands.get("feature")?.handler("work-order --slug reown-strategy", harness.ctx as any);
	assert.match(harness.notifications.at(-1)?.message ?? "", /Usage: \/feature work-order <title>/i);
});

test("execution report matching accepts manual work-order basename/path/title links", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "feature-flow-"));
	await initializeFeaturePacket(root, {
		brief: "Make re-own useful for strategic understanding",
		slug: "reown-strategy",
		branch: "feat/reown-strategy",
		workspacePath: root,
		createdDate: "2026-05-26",
	});
	await writeFile(path.join(root, "docs/features/reown-strategy/strategy.md"), "# Strategy\n\nProblem and desired system behavior are reviewed.");
	await writeFile(path.join(root, "docs/features/reown-strategy/system-model.md"), "# System Model\n\nCurrent and intended flows are modeled.");
	await writeFile(path.join(root, "docs/features/reown-strategy/decisions.md"), "# Decisions\n\n| ID | Status | Decision | Why |\n| --- | --- | --- | --- |\n| D-001 | decided | Keep strategy authority with the user | Prevent silent scope changes |\n");
	await writeFile(path.join(root, "docs/features/reown-strategy/proof.md"), "# Proof\n\nAcceptance evidence and regression gate are defined.");
	const workOrder = await createWorkOrder(root, "reown-strategy", "Change re-own output");
	assert.equal(workOrder.ok, true);
	const workOrderPath = workOrder.ok ? workOrder.path : "";
	const workOrderContent = await readFile(path.join(root, workOrderPath), "utf8");
	await writeFile(path.join(root, workOrderPath), workOrderContent.replace("status: draft", "status: done"));

	await writeFile(path.join(root, "docs/features/reown-strategy/execution/manual-basename.md"), `---\nid: ER-999\nworkOrder: 001-change-re-own-output\nstatus: complete\n---\n\n# Manual Report\n`, { flag: "wx" });
	let status = await getFeaturePacketStatus(root, "reown-strategy");
	assert.equal(status.doneWorkOrderWithoutReportCount, 0);
	let duplicate = await createExecutionReport(root, "reown-strategy", "WO-001");
	assert.equal(duplicate.ok, false);
	assert.match(duplicate.ok ? "" : duplicate.error, /Execution report already exists for WO-001/i);

	await writeFile(path.join(root, "docs/features/reown-strategy/execution/manual-basename.md"), `---\nid: ER-999\nworkOrder: ${workOrderPath}\nstatus: complete\n---\n\n# Manual Report\n`);
	status = await getFeaturePacketStatus(root, "reown-strategy");
	assert.equal(status.doneWorkOrderWithoutReportCount, 0);

	await writeFile(path.join(root, "docs/features/reown-strategy/execution/manual-basename.md"), `---\nid: ER-999\nworkOrder: WO-001: Change re-own output\nstatus: complete\n---\n\n# Manual Report\n`);
	status = await getFeaturePacketStatus(root, "reown-strategy");
	assert.equal(status.doneWorkOrderWithoutReportCount, 0);
});

test("/feature report creates a draft execution report linked to a ready work order", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "feature-flow-"));
	await initializeFeaturePacket(root, {
		brief: "Make re-own useful for strategic understanding",
		slug: "reown-strategy",
		branch: "feat/reown-strategy",
		workspacePath: root,
		createdDate: "2026-05-26",
	});
	const workOrder = await createWorkOrder(root, "reown-strategy", "Change re-own output");
	assert.equal(workOrder.ok, true);
	const workOrderPath = workOrder.ok ? workOrder.path : "";
	const workOrderContent = await readFile(path.join(root, workOrderPath), "utf8");
	await writeFile(path.join(root, workOrderPath), workOrderContent.replace("status: draft", "status: ready"));
	const harness = createHarness(root);
	featureFlowExtension(harness.pi as any);

	await harness.commands.get("feature")?.handler("report WO-001", harness.ctx as any);

	assert.equal(harness.getMessages().at(-1)?.content, "docs/features/reown-strategy/execution/001-wo-001.md");
	const report = await readFile(path.join(root, harness.getMessages().at(-1)?.content ?? ""), "utf8");
	assert.match(report, /id: ER-001/);
	assert.match(report, /workOrder: WO-001/);
	assert.match(report, /status: draft/);
	assert.match(report, /repo-relative paths only/i);
	assert.match(harness.notifications.at(-1)?.message ?? "", /Created draft execution report/i);

	await harness.commands.get("feature")?.handler("report WO-001", harness.ctx as any);
	assert.match(harness.notifications.at(-1)?.message ?? "", /Execution report already exists for WO-001/i);
});

test("/feature report rejects draft work orders and slug-only missing refs", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "feature-flow-"));
	await initializeFeaturePacket(root, {
		brief: "Make re-own useful for strategic understanding",
		slug: "reown-strategy",
		branch: "feat/reown-strategy",
		workspacePath: root,
		createdDate: "2026-05-26",
	});
	const workOrder = await createWorkOrder(root, "reown-strategy", "Change re-own output");
	assert.equal(workOrder.ok, true);
	const harness = createHarness(root);
	featureFlowExtension(harness.pi as any);

	await harness.commands.get("feature")?.handler("report WO-001", harness.ctx as any);
	assert.match(harness.notifications.at(-1)?.message ?? "", /Work order WO-001 is draft/i);

	await harness.commands.get("feature")?.handler("report --slug reown-strategy", harness.ctx as any);
	assert.match(harness.notifications.at(-1)?.message ?? "", /Usage: \/feature report <work-order>/i);
});

test("/feature review shows strategy, PR, and user-guide review prompt", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "feature-flow-"));
	await initializeFeaturePacket(root, {
		brief: "Make re-own useful for strategic understanding",
		slug: "reown-strategy",
		branch: "feat/reown-strategy",
		workspacePath: root,
		createdDate: "2026-05-26",
	});
	const harness = createHarness(root);
	featureFlowExtension(harness.pi as any);

	await harness.commands.get("feature")?.handler("review reown-strategy", harness.ctx as any);

	assert.match(harness.getMessages().at(-1)?.content ?? "", /Review strategy alignment for docs\/features\/reown-strategy/);
	assert.match(harness.getMessages().at(-1)?.content ?? "", /execution\//);
	assert.match(harness.getMessages().at(-1)?.content ?? "", /PR summary draft/);
	assert.match(harness.getMessages().at(-1)?.content ?? "", /User guide \/ manual draft/);
	assert.match(harness.getMessages().at(-1)?.content ?? "", /Do not push, open a PR, or publish docs unless I explicitly ask/);
	assert.match(harness.getMessages().at(-1)?.content ?? "", /\/reown --remember/);
	assert.match(harness.notifications.at(-1)?.message ?? "", /strategy-review prompt/i);
});

test("/feature status and view infer the slug when there is one feature packet", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "feature-flow-"));
	await initializeFeaturePacket(root, {
		brief: "Make re-own useful for strategic understanding",
		slug: "reown-strategy",
		branch: "feat/reown-strategy",
		workspacePath: root,
		createdDate: "2026-05-26",
	});
	const harness = createHarness(root);
	featureFlowExtension(harness.pi as any);

	await harness.commands.get("feature")?.handler("status", harness.ctx as any);
	assert.match(harness.getMessages().at(-1)?.content ?? "", /# Feature Status: reown-strategy/);

	await harness.commands.get("feature")?.handler("view", harness.ctx as any);
	assert.equal(harness.getMessages().at(-1)?.content, "docs/features/reown-strategy/index.html");
	assert.equal(harness.execCalls.length, 1);
});

test("/feature status without slug reports ambiguity when multiple packets exist", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "feature-flow-"));
	await initializeFeaturePacket(root, {
		brief: "First feature",
		slug: "first-feature",
		branch: "feat/first-feature",
		workspacePath: root,
		createdDate: "2026-05-26",
	});
	await initializeFeaturePacket(root, {
		brief: "Second feature",
		slug: "second-feature",
		branch: "feat/second-feature",
		workspacePath: root,
		createdDate: "2026-05-26",
	});
	const harness = createHarness(root);
	featureFlowExtension(harness.pi as any);

	await harness.commands.get("feature")?.handler("status", harness.ctx as any);

	assert.match(harness.getMessages().at(-1)?.content ?? "", /Multiple feature packets found: first-feature, second-feature/);
	assert.match(harness.notifications.at(-1)?.message ?? "", /Multiple feature packets found/i);
});

test("markdownToHtml escapes generated learning view content and renders tables", () => {
	const html = markdownToHtml("# Title\n\n<script>alert('x')</script>\n\n- [ ] Decide <scope>\n\n| A | B |\n| --- | --- |\n| <x> | y |  ");

	assert.match(html, /<h1>Title<\/h1>/);
	assert.match(html, /&lt;script&gt;alert\(&#39;x&#39;\)&lt;\/script&gt;/);
	assert.match(html, /☐ Decide &lt;scope&gt;/);
	assert.match(html, /<table>/);
	assert.match(html, /<th>A<\/th>/);
	assert.match(html, /<td>&lt;x&gt;<\/td>/);
});
