import test from "node:test";
import assert from "node:assert/strict";

import {
	buildSuggestionPrompt,
	buildImprovementPrompt,
	extractFilePaths,
	extractCommands,
	extractBaselineGuidelines,
	extractAssistantOutput,
	detectPhase,
	detectUnverifiedImplementation,
	type ConversationPhase,
} from "./index.ts";

// --- buildSuggestionPrompt: core framing ---

test("buildSuggestionPrompt frames suggestions as directive next-step prompts", () => {
	const prompt = buildSuggestionPrompt(
		"User: I fixed the mode switch.\n\nAssistant: Great — the tests passed.",
	);

	assert.match(prompt, /next prompt the USER should send/i);
	assert.match(prompt, /move the work forward/i);
	assert.match(prompt, /Stay in the user's voice/i);
	assert.match(prompt, /Return ONLY the prompt text/i);
});

test("buildSuggestionPrompt includes directive prompting principle", () => {
	const prompt = buildSuggestionPrompt(
		"User: The login is broken.\n\nAssistant: I see the issue.",
	);

	assert.match(prompt, /DIRECTIVE/i);
	assert.match(prompt, /Give direction, not questions/i);
});

test("buildSuggestionPrompt includes feedback-loop principle", () => {
	const prompt = buildSuggestionPrompt(
		"User: Add the API endpoint.\n\nAssistant: Done, I created the endpoint.",
	);

	assert.match(prompt, /FEEDBACK-LOOPABLE/i);
	assert.match(prompt, /verify/i);
});

test("buildSuggestionPrompt includes specificity principle", () => {
	const prompt = buildSuggestionPrompt(
		"User: Make the components consistent.\n\nAssistant: I'll update them.",
	);

	assert.match(prompt, /SPECIFIC/i);
	assert.match(prompt, /Reference exact files/i);
});

test("buildSuggestionPrompt describes the 3-part structure: what, verify, reference", () => {
	const prompt = buildSuggestionPrompt(
		"User: Build the feature.\n\nAssistant: Working on it.",
	);

	assert.match(prompt, /WHAT to do/i);
	assert.match(prompt, /HOW to verify/i);
	assert.match(prompt, /WHAT to reference/i);
});

// --- Mode awareness ---

test("buildSuggestionPrompt is mode-aware for deep work", () => {
	const prompt = buildSuggestionPrompt(
		"User: We need to find edge cases before shipping.\n\nAssistant: Let's inspect failure modes.",
		"deep",
	);

	assert.match(prompt, /Current agent mode: deep/i);
	assert.match(prompt, /prefer prompts that drive deeper analysis, edge-case checks, and thorough validation/i);
});

test("buildSuggestionPrompt is mode-aware for fast work", () => {
	const prompt = buildSuggestionPrompt(
		"User: We only need a tiny tweak.\n\nAssistant: Let's keep this scoped.",
		"fast",
	);

	assert.match(prompt, /Current agent mode: fast/i);
	assert.match(prompt, /prefer narrow, concrete next actions with minimal scope/i);
});

test("buildSuggestionPrompt is mode-aware for smart work", () => {
	const prompt = buildSuggestionPrompt(
		"User: Let's build this properly.\n\nAssistant: Agreed, balanced approach.",
		"smart",
	);

	assert.match(prompt, /Current agent mode: smart/i);
	assert.match(prompt, /prefer balanced prompts/i);
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
	assert.match(prompt, /reproducible test case/i);
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
	assert.match(prompt, /edge case/i);
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
	assert.match(prompt, /next implementation step/i);
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
	assert.match(prompt, /pre-ship checks/i);
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
	assert.match(prompt, /clarifying requirements/i);
});

// --- Word limit updated ---

test("buildSuggestionPrompt allows 10-40 words for richer prompts", () => {
	const prompt = buildSuggestionPrompt(
		"User: Done.\n\nAssistant: Great.",
	);

	assert.match(prompt, /10-40 words/);
	assert.match(prompt, /One or two sentences max/);
});

test("extractBaselineGuidelines captures AGENTS constraints", () => {
	const systemPrompt = `
## Non-Negotiables
- Never ship behavior change without test update
- Do not guess requirements

## Development Workflow
- Plan → Design → Create Tasks → Implement → Ship
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
	assert.match(prompt, /Assume baseline AGENTS\/system guidelines are already enforced/i);
	assert.match(prompt, /Do NOT restate generic process defaults/i);
});

// --- buildImprovementPrompt ---

test("buildImprovementPrompt frames rewrite task and preserves intent", () => {
	const prompt = buildImprovementPrompt(
		"why is login broken?",
		"User: login fails\n\nAssistant: investigate auth",
	);

	assert.match(prompt, /improve prompts/i);
	assert.match(prompt, /preserving their original intent exactly/i);
	assert.match(prompt, /Return ONLY the improved prompt text/i);
	assert.match(prompt, /Rewrite questions as instructions/i);
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
	assert.match(prompt, /Treat baseline AGENTS\/system guidance as already implied/i);
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

test("buildSuggestionPrompt includes verification_gap guidance when unverifiedImplementation is true", () => {
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
	assert.match(prompt, /MUST be a verification prompt/i);
	assert.match(prompt, /blind spot problem/i);
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

