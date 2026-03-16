import test from "node:test";
import assert from "node:assert/strict";

import { buildSuggestionPrompt } from "../../extensions/autoprom.ts";

test("buildSuggestionPrompt frames suggestions as useful next-step user prompts", () => {
	const prompt = buildSuggestionPrompt(
		"User: I fixed the mode switch.\n\nAssistant: Great — the tests passed.",
		"implement",
	);

	assert.match(prompt, /next prompt the USER should send/i);
	assert.match(prompt, /move the work forward/i);
	assert.match(prompt, /Stay in the user's role/i);
	assert.doesNotMatch(prompt, /most likely to send next/i);
	assert.match(prompt, /Return ONLY the prompt text/i);
});

test("buildSuggestionPrompt is mode-aware for design work", () => {
	const prompt = buildSuggestionPrompt(
		"User: Help me think through the architecture.\n\nAssistant: Here are three options.",
		"design",
	);

	assert.match(prompt, /Current workflow mode: design/i);
	assert.match(prompt, /prefer prompts that help clarify requirements, compare options, produce research, write PRDs\/design docs, or break work into tasks/i);
	assert.match(prompt, /Do NOT push toward implementation unless the user explicitly asked for it/i);
});

test("buildSuggestionPrompt is mode-aware for implementation work", () => {
	const prompt = buildSuggestionPrompt(
		"User: We agreed on the fix.\n\nAssistant: Ready to implement.",
		"implement",
	);

	assert.match(prompt, /Current workflow mode: implement/i);
	assert.match(prompt, /prefer prompts that help make the next concrete code\/testing\/verification step/i);
	assert.match(prompt, /Favor prompts that move from plan to execution, or from changes to validation/i);
});
