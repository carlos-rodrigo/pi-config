import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const oracleAgent = readFileSync(new URL("./oracle.md", import.meta.url), "utf8");
const askOraclePrompt = readFileSync(new URL("../prompts/ask-oracle.md", import.meta.url), "utf8");
const deepReviewPrompt = readFileSync(new URL("../prompts/deep-review.md", import.meta.url), "utf8");
const oracleCheckpointPrompt = readFileSync(new URL("../prompts/oracle-checkpoint.md", import.meta.url), "utf8");

test("oracle agent emphasizes concise, evidence-first, high-signal feedback", () => {
	assert.match(oracleAgent, /Feedback style:/);
	assert.match(oracleAgent, /Lead with the conclusion/);
	assert.match(oracleAgent, /Default to short, sharp feedback/);
	assert.match(oracleAgent, /evidence-first and repo-specific/);
	assert.match(oracleAgent, /Separate confirmed issues from hypotheses/);
	assert.match(oracleAgent, /3 or fewer must-fix items/);
	assert.match(oracleAgent, /selection visibility/);
	assert.match(oracleAgent, /perceived latency/);
	assert.match(oracleAgent, /Documentation Destination[\s\S]*none/);
});

test("oracle prompt templates require repo-specific evidence and interactive-flow feedback", () => {
	for (const prompt of [askOraclePrompt, deepReviewPrompt, oracleCheckpointPrompt]) {
		assert.match(prompt, /repo-specific/i);
		assert.match(prompt, /concise by default/i);
		assert.match(prompt, /selection visibility/i);
		assert.match(prompt, /perceived latency/i);
		assert.match(prompt, /terminal key reliability/i);
		assert.match(prompt, /Documentation Destination \(architecture \/ operations \/ engineering standards \/ domain \/ none\)/);
	}
});
