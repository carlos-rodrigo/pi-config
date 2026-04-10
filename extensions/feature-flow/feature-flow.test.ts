import test from "node:test";
import assert from "node:assert/strict";

import { buildKickoffPrompt } from "./prompt.ts";

test("buildKickoffPrompt prefers the lightest workflow and on-demand docs", () => {
	const prompt = buildKickoffPrompt({
		brief: "Add review summaries to pull request mode",
		slug: "pr-review-summaries",
		branch: "feat/pr-review-summaries",
		workspacePath: "/tmp/pi-config-pr-review-summaries",
		fallbackUsed: false,
	});

	assert.match(prompt, /Do not force a strict artifact sequence\./i);
	assert.match(prompt, /Choose the lightest workflow that fits/i);
	assert.match(prompt, /Direct implementation for small, clear work\./i);
	assert.match(prompt, /Investigate \+ plan for bounded non-trivial work\./i);
	assert.match(prompt, /Full feature workflow for large, risky, or ambiguous work\./i);
	assert.match(prompt, /Produce useful documentation only when it materially helps future work\./i);
	assert.match(prompt, /docs\/features\/pr-review-summaries\/prd\.md/i);
	assert.match(prompt, /docs\/features\/pr-review-summaries\/design\.md/i);
	assert.match(prompt, /\.features\/pr-review-summaries\/tasks\//i);
	assert.doesNotMatch(prompt, /After PRD approval/i);
	assert.doesNotMatch(prompt, /After design approval/i);
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
