export function buildKickoffPrompt(input: {
	brief: string;
	slug: string;
	branch: string;
	workspacePath: string;
	fallbackUsed: boolean;
	fallbackReason?: string;
	packetDir?: string;
	learningViewPath?: string;
}): string {
	const fallbackSection = input.fallbackUsed
		? [
			"## Runtime Mode",
			"Worktree creation failed, so this run is using single-working-copy fallback mode.",
			input.fallbackReason ? `Reason: ${input.fallbackReason}` : "",
		]
				.filter(Boolean)
				.join("\n")
		: "";
	const packetSection = input.packetDir
		? [
			"## Feature Packet",
			`- Source docs: ${input.packetDir}`,
			input.learningViewPath ? `- Learning view: ${input.learningViewPath}` : "",
			"- Treat the markdown docs as source of truth and the HTML view as a generated study guide.",
		]
				.filter(Boolean)
				.join("\n")
		: "";

	return [
		"You are starting a strategy-first feature workflow.",
		"",
		"## Feature Context",
		`- Brief: ${input.brief}`,
		`- Slug: ${input.slug}`,
		`- Branch: ${input.branch}`,
		`- Workspace: ${input.workspacePath}`,
		fallbackSection,
		packetSection,
		"",
		"## Role Split",
		"- The user owns product strategy, system design, solution architecture, slicing, tradeoffs, scope, and acceptance evidence.",
		"- The agent owns execution mechanics: code exploration, implementation edits, tests, proof runs, and execution reports.",
		"- Escalate product/system/design ambiguity instead of silently deciding what the system should mean.",
		"",
		"## Workflow Doctrine",
		"- Do not force a strict artifact sequence; choose the lightest workflow that preserves user ownership of strategy and solution design.",
		"- Possible phases: Frame → Model/Design → Decide → Slice → Execute → Report → Review/Remember.",
		"- Design-to-execution matters: create Work Orders from the approved system model, decisions, and proof plan, not as generic task churn.",
		"- Each phase should produce or update understandable feature content as a byproduct of the conversation.",
		"- Explain which path you chose and why before writing durable artifacts.",
		"",
		"## Feature Documentation Doctrine",
		"- The feature packet lives under docs/features/ by default, not .features/.",
		"- Produce durable documentation only when it helps the user understand, decide, delegate, verify, or remember.",
		"- Good reasons to document: strategic problem framing, current/intended system models, decision tradeoffs, reusable verification, execution handoff, or ownership memory.",
		"- Do not create docs that only restate the code, the diff, or temporary debugging notes.",
		"- Preferred destinations:",
		"  - docs/playbooks/ for reusable procedures and recurring gotchas",
		`  - docs/features/${input.slug}/strategy.md for problem framing, desired system behavior, constraints, and non-goals`,
		`  - docs/features/${input.slug}/system-model.md for current flow → intended flow, solution design, execution slices, concepts, invariants, and code anchors`,
		`  - docs/features/${input.slug}/decisions.md for strategic choices, rejected options, risks, and escalation points`,
		`  - docs/features/${input.slug}/proof.md for acceptance evidence, verification flows, and regression gates`,
		`  - docs/features/${input.slug}/work-orders/ for optional agent delegation briefs when work should be split`,
		`  - docs/features/${input.slug}/diagrams/ for System Diagram learning views: code flows, component communication, domain concepts, and system models`,
		`  - docs/features/${input.slug}/index.html as an optional generated learning view when the feature packet is substantial`,
		"- Do not create .features/ task state unless the user explicitly asks for the legacy task workflow.",
		"",
		"## Learning View Doctrine",
		"- Optimize artifacts for re-owning the mental model: why this matters, how the system works, what changed, and what proof exists.",
		"- Prefer diagrams, tables, traceability links, and short teach-back sections over long prose.",
		"- For diagrams, use the system-diagram skill when it would clarify code flow, component communication, domain concepts, boundaries, data flow, or code ownership.",
		"",
		"## Execution Rules",
		"1. Ask clarifying questions only if they materially affect strategy, scope, product/system behavior, or implementation risk.",
		"2. Do a short exploration pass before choosing the workflow path.",
		"3. If you create strategy/model/decision docs, summarize them and ask for approval before relying on them as execution authority.",
		"4. If docs are unnecessary, keep the strategy and plan in chat and proceed.",
		"5. Work orders are design-derived delegation contracts: include mission, strategic context, decisions to preserve, agent-owned execution choices, escalation triggers, proof required, and status frontmatter (draft | ready | blocked | done). Only ready work orders may be implemented.",
		"",
		"## Hard Gates",
		"- Get approval before schema, API contract, auth/financial, infra, or major dependency changes.",
		"- Keep outputs concise and actionable.",
		"",
		"Start now by briefly assessing the feature, then ask 1–3 strategic questions or propose the lightest workflow and first artifact to create.",
	]
		.filter(Boolean)
		.join("\n");
}
