import test from "node:test";
import assert from "node:assert/strict";

import {
	buildSuggestionPrompt,
	buildImprovementPrompt,
	extractFilePaths,
	extractCommands,
	extractBaselineGuidelines,
	extractAssistantOutput,
	normalizeComparablePromptText,
	hasMeaningfulPromptChange,
	normalizeConfiguredModel,
	extractAutoPromptErrorMessage,
	shouldRetryAutoPromptWithFallback,
	detectPhase,
	detectUnverifiedImplementation,
	extractFeaturePacketSuggestionState,
	type ConversationPhase,
} from "./index.ts";

// --- buildSuggestionPrompt: core framing ---

test("buildSuggestionPrompt frames suggestions as actionable next-step prompts", () => {
	const prompt = buildSuggestionPrompt(
		"User: I fixed the mode switch.\n\nAssistant: Great — the tests passed.",
	);

	assert.match(prompt, /next prompt the USER should send/i);
	assert.match(prompt, /move the work forward/i);
	assert.match(prompt, /directly in the user's voice/i);
	assert.match(prompt, /Return ONLY the prompt text/i);
});

test("buildSuggestionPrompt defines the outcome, evidence, constraints, and completion bar", () => {
	const prompt = buildSuggestionPrompt(
		"User: The login is broken.\n\nAssistant: I see the issue.",
	);

	assert.match(prompt, /user-visible outcome/i);
	assert.match(prompt, /available evidence/i);
	assert.match(prompt, /important constraint/i);
	assert.match(prompt, /completion bar/i);
	assert.match(prompt, /smallest missing fact/i);
});

test("buildSuggestionPrompt leaves the agent room to choose an efficient path", () => {
	const prompt = buildSuggestionPrompt(
		"User: Add the API endpoint.\n\nAssistant: Done, I created the endpoint.",
	);

	assert.match(prompt, /choose an efficient path/i);
	assert.match(prompt, /observable success check/i);
	assert.doesNotMatch(prompt, /detailed implementation sequence/i);
});

test("buildSuggestionPrompt includes only evidence and constraints that change the result", () => {
	const prompt = buildSuggestionPrompt(
		"User: Make the components consistent.\n\nAssistant: I'll update them.",
	);

	assert.match(prompt, /only when (?:it|they) can change the result/i);
	assert.match(prompt, /without inventing/i);
});

test("buildSuggestionPrompt preserves request type and autonomy boundaries", () => {
	const prompt = buildSuggestionPrompt(
		"User: Review the feature plan.\n\nAssistant: I'll inspect it.",
	);

	assert.match(prompt, /answer, explain, review, diagnose, or plan/i);
	assert.match(prompt, /do not turn it into implementation/i);
});

// --- Mode awareness ---

test("buildSuggestionPrompt is mode-aware for fast work", () => {
	const prompt = buildSuggestionPrompt(
		"User: Implement the focused fix.\n\nAssistant: Let's keep this narrow.",
		"fast",
	);

	assert.match(prompt, /Current agent mode: fast/i);
	assert.match(prompt, /tiny concrete action/i);
	assert.match(prompt, /cheap verification check/i);
});

test("buildSuggestionPrompt is mode-aware for deep work", () => {
	const prompt = buildSuggestionPrompt(
		"User: We need to find edge cases before shipping.\n\nAssistant: Let's inspect failure modes.",
		"deep",
	);

	assert.match(prompt, /Current agent mode: deep/i);
	assert.match(prompt, /clear outcome/i);
	assert.match(prompt, /observable success check/i);
});

test("buildSuggestionPrompt is mode-aware for deep3 work", () => {
	const prompt = buildSuggestionPrompt(
		"User: This session handoff bug is intermittent and risky.\n\nAssistant: We need to reason through failure modes.",
		"deep3",
	);

	assert.match(prompt, /Current agent mode: deep3/i);
	assert.match(prompt, /quality-first/i);
	assert.match(prompt, /reproduce or diagnose first/i);
});

test("buildSuggestionPrompt is mode-aware for smart work", () => {
	const prompt = buildSuggestionPrompt(
		"User: Let's build this properly.\n\nAssistant: Agreed, balanced approach.",
		"smart",
	);

	assert.match(prompt, /Current agent mode: smart/i);
	assert.match(prompt, /narrow next action/i);
	assert.match(prompt, /focused check/i);
});

test("buildSuggestionPrompt can include compact archive guidance", () => {
	const prompt = buildSuggestionPrompt(
		"User: Continue.\n\nAssistant: Done.",
		"smart",
		[],
		[],
		undefined,
		undefined,
		false,
		undefined,
		"2 recent verification failures; prefer verification-first next steps",
	);

	assert.match(prompt, /self_improvement_archive/);
	assert.match(prompt, /verification failures/i);
	assert.match(prompt, /verification-first/i);
});

test("extractFeaturePacketSuggestionState detects feature packets, slug, and ready task stage", () => {
	const state = extractFeaturePacketSuggestionState(
		"Assistant: Created .features/saved-search-filters/tasks/001-change-output.md with status: ready for WO-001.",
	);

	assert.equal(state?.active, true);
	assert.equal(state?.slug, "saved-search-filters");
	assert.equal(state?.packetDir, "docs/features/saved-search-filters");
	assert.equal(state?.workOrderId, "WO-001");
	assert.equal(state?.stage, "execute");
});

test("extractFeaturePacketSuggestionState detects solution-design stage", () => {
	const state = extractFeaturePacketSuggestionState(
		"Assistant: Next action: update docs/features/saved-search-filters/system-model.md with solution design and execution slices.",
	);

	assert.equal(state?.slug, "saved-search-filters");
	assert.equal(state?.stage, "design");
});

test("extractFeaturePacketSuggestionState ignores unrelated conversations", () => {
	const state = extractFeaturePacketSuggestionState("User: Fix the login bug.\n\nAssistant: I found auth.ts.");

	assert.equal(state, undefined);
});

test("buildSuggestionPrompt includes feature-packet next-action guidance", () => {
	const prompt = buildSuggestionPrompt(
		"User: Continue the feature.\n\nAssistant: docs/features/saved-search-filters has a done task missing a result section.",
		"deep",
		[".features/saved-search-filters/tasks/001-change-output.md"],
		[],
		"shipping",
		undefined,
		false,
		extractFeaturePacketSuggestionState("Assistant: WO-001 is done but missing result in .features/saved-search-filters/tasks/001-change-output.md."),
	);

	assert.match(prompt, /Feature packet active/i);
	assert.match(prompt, /docs\/features\/saved-search-filters/i);
	assert.match(prompt, /reading docs\/features\/saved-search-filters/i);
	assert.match(prompt, /## Result section for WO-001/i);
	assert.match(prompt, /changed files/i);
});

test("buildSuggestionPrompt can suggest the feature design bridge", () => {
	const featureState = extractFeaturePacketSuggestionState(
		"Assistant: strategy.md is approved. Next action is to model/design the solution before execution for docs/features/saved-search-filters.",
	);
	const prompt = buildSuggestionPrompt(
		"User: What's next?\n\nAssistant: strategy.md is approved; model/design the solution before execution.",
		"deep",
		["docs/features/saved-search-filters/strategy.md"],
		[],
		"planning",
		undefined,
		false,
		featureState,
	);

	assert.match(prompt, /Model\/Design → Slice → Execute → Result/i);
	assert.match(prompt, /co-designing system-model\.md/i);
	assert.match(prompt, /without implementing/i);
});

// --- File path extraction ---

test("extractFilePaths finds file paths in conversation text", () => {
	const text = "I updated `src/api/messages.ts` and also checked src/utils/helpers.ts for patterns.";
	const paths = extractFilePaths(text);

	assert.ok(paths.includes("src/api/messages.ts"));
	assert.ok(paths.includes("src/utils/helpers.ts"));
});

test("extractFilePaths ignores URLs", () => {
	const text = "Check https://example.com/page.html and www.site.com/path.js";
	const paths = extractFilePaths(text);

	assert.equal(paths.length, 0);
});

test("extractFilePaths deduplicates and limits results", () => {
	const text = "Look at src/a.ts and src/a.ts again, plus src/b.ts";
	const paths = extractFilePaths(text);

	const aCount = paths.filter((p) => p === "src/a.ts").length;
	assert.equal(aCount, 1, "should deduplicate paths");
	assert.ok(paths.length <= 8, "should limit to 8 paths");
});

// --- Command extraction ---

test("extractCommands finds npm/test commands", () => {
	const text = "Run `npm test` to check, then use `pnpm run build` for the bundle.";
	const cmds = extractCommands(text);

	assert.ok(cmds.some((c) => c.includes("npm test")));
});

test("extractCommands finds shell-prefixed commands", () => {
	const text = "$ node physics-cli.js --vx=-7.71 --vy=2.13\nOutput: Frame 1...";
	const cmds = extractCommands(text);

	assert.ok(cmds.some((c) => c.includes("node physics-cli.js")));
});

test("extractCommands limits results", () => {
	const cmds = extractCommands("npm a\nnpm b\nnpm c\nnpm d\nnpm e\nnpm f\nnpm g");
	assert.ok(cmds.length <= 5, "should limit to 5 commands");
});

test("extractAssistantOutput prefers text blocks", () => {
	const out = extractAssistantOutput([
		{ type: "thinking", thinking: "internal" },
		{ type: "text", text: "Rewrite this prompt" },
	]);
	assert.equal(out, "Rewrite this prompt");
});

test("extractAssistantOutput falls back to thinking when text is unavailable", () => {
	const out = extractAssistantOutput([{ type: "thinking", thinking: "Fallback response" }]);
	assert.equal(out, "Fallback response");
});

test("normalizeComparablePromptText collapses whitespace for no-op detection", () => {
	assert.equal(normalizeComparablePromptText("  Fix   login\n\nnow  "), "Fix login now");
});

test("hasMeaningfulPromptChange ignores whitespace-only rewrites", () => {
	assert.equal(hasMeaningfulPromptChange("Fix login now", "  Fix   login\nnow  "), false);
	assert.equal(hasMeaningfulPromptChange("Fix login now", "Fix login now and verify it"), true);
});

test("normalizeConfiguredModel migrates legacy unsupported codex mini model", () => {
	assert.deepEqual(normalizeConfiguredModel({ provider: "openai-codex", id: "gpt-5.1-codex-mini" }), {
		provider: "openai-codex",
		id: "gpt-5.6-terra",
	});
});

test("normalizeConfiguredModel preserves supported models", () => {
	assert.deepEqual(normalizeConfiguredModel({ provider: "anthropic", id: "claude-sonnet-4-6" }), {
		provider: "anthropic",
		id: "claude-sonnet-4-6",
	});
});

test("extractAutoPromptErrorMessage unwraps JSON detail payloads", () => {
	const err = new Error('{"detail":"The \'gpt-5.1-codex-mini\' model is not supported when using Codex with a ChatGPT account."}');
	assert.equal(
		extractAutoPromptErrorMessage(err),
		"The 'gpt-5.1-codex-mini' model is not supported when using Codex with a ChatGPT account.",
	);
});

test("shouldRetryAutoPromptWithFallback retries unsupported-model errors only", () => {
	assert.equal(
		shouldRetryAutoPromptWithFallback(
			new Error('{"detail":"The \'gpt-5.1-codex-mini\' model is not supported when using Codex with a ChatGPT account."}'),
		),
		true,
	);
	assert.equal(
		shouldRetryAutoPromptWithFallback(new Error("You have hit your ChatGPT usage limit.")),
		false,
	);
});

// --- Phase detection ---

test("detectPhase identifies debugging phase", () => {
	const ctx = "User: There's a bug in the login flow, it crashes on submit.\n\nAssistant: I see the error in the stack trace.";
	assert.equal(detectPhase(ctx), "debugging");
});

test("detectPhase identifies testing phase", () => {
	const ctx = "User: Run the unit tests.\n\nAssistant: 3 tests failing, 42 passing. The assert on line 15 expects null.";
	assert.equal(detectPhase(ctx), "testing");
});

test("detectPhase identifies building phase", () => {
	const ctx = "User: Implement the notification component.\n\nAssistant: I created the component in src/Notification.tsx.";
	assert.equal(detectPhase(ctx), "building");
});

test("detectPhase identifies shipping phase", () => {
	const ctx = "User: Create a PR for these changes.\n\nAssistant: I'll commit and push, then open the pull request.";
	assert.equal(detectPhase(ctx), "shipping");
});

test("detectPhase identifies planning phase", () => {
	const ctx = "User: How should we approach the architecture for this?\n\nAssistant: Let me outline the design trade-offs.";
	assert.equal(detectPhase(ctx), "planning");
});

test("detectPhase defaults to building when no signals", () => {
	const ctx = "User: Hello.\n\nAssistant: Hi there.";
	assert.equal(detectPhase(ctx), "building");
});

// --- File/command context inclusion in prompt ---

test("buildSuggestionPrompt includes file paths when provided", () => {
	const prompt = buildSuggestionPrompt(
		"User: Update the API.\n\nAssistant: Done.",
		undefined,
		["src/api/messages.ts", "src/api/routes.ts"],
	);

	assert.match(prompt, /files_in_conversation/i);
	assert.match(prompt, /src\/api\/messages\.ts/);
	assert.match(prompt, /src\/api\/routes\.ts/);
});

test("buildSuggestionPrompt includes commands when provided", () => {
	const prompt = buildSuggestionPrompt(
		"User: Run the tests.\n\nAssistant: All passing.",
		undefined,
		undefined,
		["npm test", "pnpm run build"],
	);

	assert.match(prompt, /commands_in_conversation/i);
	assert.match(prompt, /npm test/);
	assert.match(prompt, /pnpm run build/);
});

test("buildSuggestionPrompt omits file/command sections when empty", () => {
	const prompt = buildSuggestionPrompt(
		"User: Hello.\n\nAssistant: Hi.",
		undefined,
		[],
		[],
	);

	assert.doesNotMatch(prompt, /files_in_conversation/i);
	assert.doesNotMatch(prompt, /commands_in_conversation/i);
});

// --- Phase guidance in prompt ---

test("buildSuggestionPrompt includes debugging phase guidance", () => {
	const prompt = buildSuggestionPrompt(
		"User: Fix the crash.\n\nAssistant: Found the issue.",
		undefined,
		undefined,
		undefined,
		"debugging",
	);

	assert.match(prompt, /phase_guidance.*debugging/i);
	assert.match(prompt, /failing behavior/i);
});

test("buildSuggestionPrompt includes testing phase guidance", () => {
	const prompt = buildSuggestionPrompt(
		"User: Run tests.\n\nAssistant: Done.",
		undefined,
		undefined,
		undefined,
		"testing",
	);

	assert.match(prompt, /phase_guidance.*testing/i);
	assert.match(prompt, /real boundary/i);
});

test("buildSuggestionPrompt includes building phase guidance", () => {
	const prompt = buildSuggestionPrompt(
		"User: Build the feature.\n\nAssistant: Done.",
		undefined,
		undefined,
		undefined,
		"building",
	);

	assert.match(prompt, /phase_guidance.*building/i);
	assert.match(prompt, /system-visible result/i);
});

test("buildSuggestionPrompt includes shipping phase guidance", () => {
	const prompt = buildSuggestionPrompt(
		"User: Ship it.\n\nAssistant: Ready.",
		undefined,
		undefined,
		undefined,
		"shipping",
	);

	assert.match(prompt, /phase_guidance.*shipping/i);
	assert.match(prompt, /confidence gap/i);
});

test("buildSuggestionPrompt includes planning phase guidance", () => {
	const prompt = buildSuggestionPrompt(
		"User: Plan the feature.\n\nAssistant: Let's scope.",
		undefined,
		undefined,
		undefined,
		"planning",
	);

	assert.match(prompt, /phase_guidance.*planning/i);
	assert.match(prompt, /desired result/i);
});

// --- Word limit updated ---

test("buildSuggestionPrompt states the 240-character output limit once", () => {
	const prompt = buildSuggestionPrompt(
		"User: Done.\n\nAssistant: Great.",
	);

	assert.match(prompt, /10-45 words/);
	assert.match(prompt, /one or two sentences/i);
	assert.equal(prompt.match(/240 characters/gi)?.length, 1);
});

test("extractBaselineGuidelines captures AGENTS constraints", () => {
	const systemPrompt = `
## Non-Negotiables
- Never ship behavior change without test update
- Do not guess requirements

## Workflow
- Clarify if needed → Implement → Verify → Ship
- Explore → Plan → Implement → Verify → Ship
`;

	const rules = extractBaselineGuidelines(systemPrompt, 5);
	assert.ok(rules.some((r) => /never ship behavior change without test update/i.test(r)));
	assert.ok(rules.some((r) => /do not guess requirements/i.test(r)));
});

test("buildSuggestionPrompt includes baseline-guideline context and avoids restating defaults", () => {
	const prompt = buildSuggestionPrompt(
		"User: fix auth bug\n\nAssistant: done",
		undefined,
		undefined,
		undefined,
		"debugging",
		["Never ship behavior change without test update", "Do not guess requirements"],
	);

	assert.match(prompt, /baseline_agent_guidelines/i);
	assert.match(prompt, /Assume baseline AGENTS\/system guidelines are enforced/i);
	assert.match(prompt, /do not restate generic process defaults/i);
});

// --- buildImprovementPrompt ---

test("buildImprovementPrompt frames rewrite task and preserves the request contract", () => {
	const prompt = buildImprovementPrompt(
		"why is login broken?",
		"User: login fails\n\nAssistant: investigate auth",
	);

	assert.match(prompt, /rewrite the user's draft/i);
	assert.match(prompt, /requested artifact/i);
	assert.match(prompt, /explicit values/i);
	assert.match(prompt, /factual claims/i);
	assert.match(prompt, /Return only the improved prompt text/i);
	assert.match(prompt, /user-visible outcome/i);
	assert.match(prompt, /already satisfies this contract, return it as-is/i);
	assert.match(prompt, /smallest missing fact/i);
});

test("buildImprovementPrompt adds a completion bar without prescribing internal process", () => {
	const prompt = buildImprovementPrompt(
		"implement the verify planner",
		"User: improve verify extension\n\nAssistant: use extensions/verify/index.ts",
		["extensions/verify/index.ts"],
		["npm run test:verify"],
		"building",
	);

	assert.match(prompt, /completion bar/i);
	assert.match(prompt, /choose an efficient path/i);
	assert.doesNotMatch(prompt, /include verification_plan before coding/i);
});

test("buildImprovementPrompt includes baseline context and implied-guidelines rule", () => {
	const prompt = buildImprovementPrompt(
		"feed that loop",
		"User: fixed API tests\n\nAssistant: all green",
		undefined,
		undefined,
		"shipping",
		["Never ship behavior change without test update", "Do not guess requirements"],
	);

	assert.match(prompt, /baseline_agent_guidelines/i);
	assert.match(prompt, /Treat baseline AGENTS\/system guidance as implied/i);
});

test("buildImprovementPrompt includes file and command context when provided", () => {
	const prompt = buildImprovementPrompt(
		"fix notifications",
		"User: endpoint failing",
		["src/api/notifications.ts", "src/api/messages.ts"],
		["npm test", "pnpm run build"],
		"debugging",
	);

	assert.match(prompt, /files_in_conversation/i);
	assert.match(prompt, /src\/api\/notifications\.ts/);
	assert.match(prompt, /commands_in_conversation/i);
	assert.match(prompt, /npm test/i);
	assert.match(prompt, /DEBUGGING phase/i);
});

test("buildImprovementPrompt omits file and command sections when not provided", () => {
	const prompt = buildImprovementPrompt(
		"fix notifications",
		"User: endpoint failing",
		[],
		[],
	);

	assert.doesNotMatch(prompt, /files_in_conversation/i);
	assert.doesNotMatch(prompt, /commands_in_conversation/i);
});

// --- detectUnverifiedImplementation ---

test("detectUnverifiedImplementation returns true when assistant implemented but didn't verify", () => {
	const ctx = "User: Add the webhook handler.\n\nAssistant: I've created the webhook handler in src/webhooks/bitfreighter.ts. The endpoint accepts POST requests and parses the payload.";
	assert.equal(detectUnverifiedImplementation(ctx), true);
});

test("detectUnverifiedImplementation returns false when assistant mentions verification", () => {
	const ctx = "User: Add the webhook handler.\n\nAssistant: I've created the webhook handler. I tested it by curling the endpoint and it returns 200.";
	assert.equal(detectUnverifiedImplementation(ctx), false);
});

test("detectUnverifiedImplementation returns false when assistant mentions tests passing", () => {
	const ctx = "User: Fix the bug.\n\nAssistant: Fixed the null check in auth.ts. All tests are passing now.";
	assert.equal(detectUnverifiedImplementation(ctx), false);
});

test("detectUnverifiedImplementation returns false for non-implementation responses", () => {
	const ctx = "User: How should we approach this?\n\nAssistant: I think we should start by defining the API contract.";
	assert.equal(detectUnverifiedImplementation(ctx), false);
});

test("detectUnverifiedImplementation detects done/completed without verification", () => {
	const ctx = "User: Refactor the auth module.\n\nAssistant: Done! I've refactored the auth module to use the new pattern.";
	assert.equal(detectUnverifiedImplementation(ctx), true);
});

// --- buildSuggestionPrompt with unverifiedImplementation ---

test("buildSuggestionPrompt includes concise verification-gap guidance when implementation is unverified", () => {
	const prompt = buildSuggestionPrompt(
		"User: Add endpoint.\n\nAssistant: Done, created the endpoint.",
		undefined,
		undefined,
		undefined,
		"building",
		undefined,
		true,
	);

	assert.match(prompt, /verification_gap/i);
	assert.match(prompt, /must request the smallest useful external check/i);
	assert.match(prompt, /real boundary/i);
	assert.doesNotMatch(prompt, /Examples:/i);
});

test("buildSuggestionPrompt omits verification_gap when unverifiedImplementation is false", () => {
	const prompt = buildSuggestionPrompt(
		"User: Add endpoint.\n\nAssistant: Done, all tests passing.",
		undefined,
		undefined,
		undefined,
		"building",
		undefined,
		false,
	);

	assert.doesNotMatch(prompt, /verification_gap/i);
});

