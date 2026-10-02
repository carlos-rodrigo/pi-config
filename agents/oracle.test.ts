import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const oracleAgent = readFileSync(new URL("./oracle.md", import.meta.url), "utf8");
const researcherAgent = readFileSync(new URL("./researcher.md", import.meta.url), "utf8");
const librarianAgent = readFileSync(new URL("./librarian.md", import.meta.url), "utf8");
const oraclePrompt = readFileSync(new URL("../prompts/oracle.md", import.meta.url), "utf8");
const deepReviewPrompt = readFileSync(new URL("../prompts/deep-review.md", import.meta.url), "utf8");
const researchPrompt = readFileSync(new URL("../prompts/research.md", import.meta.url), "utf8");
const researchAndPlanPrompt = readFileSync(new URL("../prompts/research-and-plan.md", import.meta.url), "utf8");

test("oracle agent emphasizes concise, evidence-first, high-signal feedback", () => {
	assert.match(oracleAgent, /model: openai\/gpt-6-astra:xhigh/);
	assert.match(oracleAgent, /tools: read, grep, find, ls, agent_job_start, agent_job_status/);
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

test("oracle runs Are You Proud validation for every review with five focused child jobs", () => {
	assert.match(oracleAgent, /Are You Proud review mode:/);
	assert.match(oracleAgent, /every code\/change review/i);
	assert.match(oracleAgent, /At the start of every review/i);
	assert.match(oracleAgent, /\/Users\/carlosrodrigo\/agents\/skills\/are-you-proud\/SKILL\.md/);
	assert.match(oracleAgent, /Correctness and intent/);
	assert.match(oracleAgent, /Simplicity \/ YAGNI \/ overengineering/);
	assert.match(oracleAgent, /Naming and self-explanatory code/);
	assert.match(oracleAgent, /SOLID and design fit/);
	assert.match(oracleAgent, /Tests and verification/);
	assert.match(oracleAgent, /Start exactly five child agent jobs/);
	assert.match(oracleAgent, /followUp: false/);
	assert.match(oracleAgent, /Do not spawn subagents/);
	assert.match(oracleAgent, /child review must not spawn/i);
	assert.match(oracleAgent, /agent_job_status/);
	assert.match(oracleAgent, /Proud[\s\S]*Mostly proud[\s\S]*Not proud yet[\s\S]*Would not ship/);
});

test("prompt inventory exposes four distinct workflows", () => {
	assert.deepEqual(readdirSync(new URL("../prompts/", import.meta.url)).filter(name => name.endsWith(".md")).sort(), [
		"deep-review.md", "oracle.md", "research-and-plan.md", "research.md",
	]);
});

test("deep review uses the agent review contract with focused scope and limits", () => {
	assert.match(deepReviewPrompt, /review-context\.md first/);
	assert.match(deepReviewPrompt, /Are You Proud output contract/);
	assert.match(deepReviewPrompt, /changed files.*diff.*directly related code/);
	assert.match(deepReviewPrompt, /at most 5 findings/i);
	assert.match(deepReviewPrompt, /Maximum 800 words/);
	assert.match(deepReviewPrompt, /no must-fix issues/i);
	assert.doesNotMatch(deepReviewPrompt, /Documentation Destination|1\. Decision/);
});

test("researcher agent follows oracle-style model, tool, and context-budget discipline", () => {
	assert.match(researcherAgent, /model: claude-bridge\/claude-sonnet-5-5/);
	assert.match(researcherAgent, /tools: read, grep, find, ls, websearch, webfetch/);
	assert.doesNotMatch(researcherAgent, /tools:.*bash/);
	assert.match(researcherAgent, /Lead with the conclusion/);
	assert.match(researcherAgent, /evidence-first/i);
	assert.match(researcherAgent, /Context budget:/);
	assert.match(researcherAgent, /at most 8 tool calls/);
	assert.match(researcherAgent, /webfetch\.maxChars.*12,000/i);
	assert.match(researcherAgent, /Maximum 900 words/);
});

test("librarian agent uses only bash and constrains gh CLI research", () => {
	assert.match(librarianAgent, /model: claude-bridge\/claude-sonnet-5-5/);
	assert.match(librarianAgent, /tools: bash/);
	assert.match(librarianAgent, /GitHub CLI \(`gh`\)/);
	assert.match(librarianAgent, /Use only the `bash` tool/);
	assert.match(librarianAgent, /use `gh` for GitHub access/);
	assert.match(librarianAgent, /Do not run mutating `gh` commands/);
	assert.match(librarianAgent, /gh search code/);
	assert.match(librarianAgent, /gh api repos\/OWNER\/REPO\/contents\/PATH/);
	assert.match(librarianAgent, /Maximum 900 words/);
});

test("research-and-plan sequences the evidence handoff before the recommendation", () => {
	assert.match(researchAndPlanPrompt, /Step 1[\s\S]*"researcher"[\s\S]*After starting[\s\S]*stop/);
	assert.match(researchAndPlanPrompt, /When the researcher completion follow-up arrives[\s\S]*"oracle"/);
	assert.match(researchAndPlanPrompt, /Pass the researcher output/);
	assert.match(researchAndPlanPrompt, /implementation recommendation/);
});

test("prompts inherit shared policy from agent definitions", () => {
	for (const prompt of [oraclePrompt, deepReviewPrompt, researchPrompt, researchAndPlanPrompt]) {
		assert.match(prompt, /agent.*defaults/i);
		assert.match(prompt, /\$@/);
		assert.doesNotMatch(prompt, /selection visibility|Maximum 900 words|at most 8 sources/);
	}
	assert.match(researcherAgent, /Maximum 8 sources/);
});

test("oracle and researcher prompt templates use non-blocking agent jobs", () => {
	for (const prompt of [oraclePrompt, deepReviewPrompt, researchPrompt, researchAndPlanPrompt]) {
		assert.match(prompt, /agent_job_start/);
		assert.match(prompt, /background|detached tmux/i);
		assert.match(prompt, /followUp=true/);
		assert.match(prompt, /stop/i);
		assert.doesNotMatch(prompt, /Use the subagent tool/i);
	}
	assert.match(deepReviewPrompt, /mode="review"/);
	for (const prompt of [oraclePrompt, researchPrompt, researchAndPlanPrompt]) {
		assert.match(prompt, /mode="standard"/);
	}
});
