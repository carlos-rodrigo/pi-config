export function buildKickoffPrompt(input: {
	brief: string;
	slug: string;
	branch: string;
	workspacePath: string;
	fallbackUsed: boolean;
	fallbackReason?: string;
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

	return [
		"You are starting a new feature workflow.",
		"",
		"## Feature Context",
		`- Brief: ${input.brief}`,
		`- Slug: ${input.slug}`,
		`- Branch: ${input.branch}`,
		`- Workspace: ${input.workspacePath}`,
		fallbackSection,
		"",
		"## Workflow Doctrine",
		"- Do not force a strict artifact sequence.",
		"- Choose the lightest workflow that fits after a brief exploration pass.",
		"- Workflow options:",
		"  1. Direct implementation for small, clear work.",
		"  2. Investigate + plan for bounded non-trivial work.",
		"  3. Full feature workflow for large, risky, or ambiguous work.",
		"- Explain which path you chose and why.",
		"",
		"## Documentation Doctrine",
		"- Produce useful documentation only when it materially helps future work.",
		"- Good reasons to document: stabilize scope, preserve durable technical decisions, capture reusable verification, or prevent repeated rediscovery.",
		"- Do not create docs that only restate the code, the diff, or temporary debugging notes.",
		"- Preferred destinations:",
		"  - docs/playbooks/ for reusable procedures and recurring gotchas",
		`  - docs/features/${input.slug}/prd.md for concise scope/requirements when needed`,
		`  - docs/features/${input.slug}/design.md for durable technical decisions when needed`,
		`  - docs/features/${input.slug}/workflows/ for reusable verification flows`,
		`  - .features/${input.slug}/tasks/ for execution state when work benefits from splitting`,
		"",
		"## Execution Rules",
		"1. Ask clarifying questions only if they materially affect scope or implementation.",
		"2. Do a short exploration pass before choosing the workflow.",
		"3. If you create PRD/design docs, open them with open_file, summarize them, and ask for approval before relying on them as execution artifacts.",
		"4. If docs are unnecessary, keep the plan in chat and proceed.",
		`5. Only create tasks under .features/${input.slug}/tasks/ when the work should be split across multiple steps or sessions. Tasks must be implementation-ready with repo research, prior art, and verification.`,
		"",
		"## Hard Gates",
		"- Get approval before schema, API contract, auth/financial, infra, or major dependency changes.",
		"- Keep outputs concise and actionable.",
		"",
		"Start now by briefly assessing the feature, then either ask the few clarifying questions you need or propose the lightest workflow.",
	]
		.filter(Boolean)
		.join("\n");
}
