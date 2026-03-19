import test from "node:test";
import assert from "node:assert/strict";

import { buildSuggestionPrompt } from "../../extensions/auto-prompt.ts";

test("buildSuggestionPrompt frames suggestions as useful next-step user prompts", () => {
	const prompt = buildSuggestionPrompt(
		"User: I fixed the mode switch.\n\nAssistant: Great — the tests passed.",
		"smart",
	);

	assert.match(prompt, /next prompt the USER should send/i);
	assert.match(prompt, /move the work forward/i);
	assert.match(prompt, /Stay in the user's role/i);
	assert.doesNotMatch(prompt, /most likely to send next/i);
	assert.match(prompt, /Return ONLY the prompt text/i);
});

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
