import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const oracleAgent = readFileSync(new URL("./oracle.md", import.meta.url), "utf8");
const researcherAgent = readFileSync(new URL("./researcher.md", import.meta.url), "utf8");
const askOraclePrompt = readFileSync(new URL("../prompts/ask-oracle.md", import.meta.url), "utf8");
const deepReviewPrompt = readFileSync(new URL("../prompts/deep-review.md", import.meta.url), "utf8");
const oracleCheckpointPrompt = readFileSync(new URL("../prompts/oracle-checkpoint.md", import.meta.url), "utf8");
const researchPrompt = readFileSync(new URL("../prompts/research.md", import.meta.url), "utf8");
const researchAndPlanPrompt = readFileSync(new URL("../prompts/research-and-plan.md", import.meta.url), "utf8");

test("oracle agent emphasizes concise, evidence-first, high-signal feedback", () => {
	assert.match(oracleAgent, /model: openai-codex\/gpt-5\.5/);
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

test("researcher agent follows oracle-style model, tool, and context-budget discipline", () => {
	assert.match(researcherAgent, /model: openai-codex\/gpt-5\.5/);
	assert.match(researcherAgent, /tools: read, grep, find, ls, websearch, webfetch/);
	assert.doesNotMatch(researcherAgent, /tools:.*bash/);
	assert.match(researcherAgent, /Lead with the conclusion/);
	assert.match(researcherAgent, /evidence-first/i);
	assert.match(researcherAgent, /Context budget:/);
	assert.match(researcherAgent, /at most 8 tool calls/);
	assert.match(researcherAgent, /webfetch\.maxChars.*12,000/i);
	assert.match(researcherAgent, /Maximum 900 words/);
});

test("research prompt templates keep researcher output bounded", () => {
	for (const prompt of [researchPrompt, researchAndPlanPrompt, oracleCheckpointPrompt]) {
		assert.match(prompt, /evidence-first/i);
		assert.match(prompt, /at most 8 sources/i);
		assert.match(prompt, /maximum of 900 words|cap normal output at 900 words/i);
		assert.match(prompt, /no long code blocks|avoid pasted code blocks/i);
	}
});
