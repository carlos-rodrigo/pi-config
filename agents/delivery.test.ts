import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents } from "../extensions/agent-jobs/agents.ts";

const manager = readFileSync(new URL("./manager.md", import.meta.url), "utf8");
const builder = readFileSync(new URL("./builder.md", import.meta.url), "utf8");

test("delivery agents are discoverable with Anthropic primaries and OpenAI fallbacks", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-delivery-agents-"));
	try {
		const agentsDir = join(root, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		for (const name of ["manager", "builder"]) {
			copyFileSync(new URL(`./${name}.md`, import.meta.url), join(agentsDir, `${name}.md`));
		}
		const agents = discoverAgents(root, "project").agents;
		assert.deepEqual(agents.map(agent => agent.name).sort(), ["builder", "manager"]);
		assert.equal(agents.find(agent => agent.name === "manager")!.model, "claude-bridge/claude-sonnet-5-5:high");
		assert.deepEqual(agents.find(agent => agent.name === "manager")!.models, ["claude-bridge/claude-sonnet-5-5:high"]);
		assert.equal(agents.find(agent => agent.name === "builder")!.model, "claude-bridge/claude-opus-5-5:high");
		assert.deepEqual(agents.find(agent => agent.name === "builder")!.models, ["claude-bridge/claude-opus-5-5:high"]);
		const managerTools = agents.find(agent => agent.name === "manager")!.tools!;
		for (const name of ["subagent", "agent_job_start", "agent_job_status", "agent_job_cancel", "edit", "write"]) {
			assert.ok(managerTools.includes(name), `manager needs ${name}`);
		}
		assert.deepEqual(agents.find(agent => agent.name === "builder")!.tools, ["read", "grep", "find", "ls", "bash", "edit", "write"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("manager owns sequential delegation and durable fresh-context repair", () => {
	assert.match(manager, /exactly one builder at a time/);
	assert.match(manager, /Each new task gets a fresh context/);
	assert.match(manager, /does not resume builder sessions/);
	assert.match(manager, /current Result, Oracle findings/);
	assert.match(manager, /Do not implement application code yourself/);
	assert.match(manager, /Do not start another manager/);
	assert.match(manager, /A request for one task does not authorize the rest/);
	assert.match(manager, /preserve unrelated edits/);
	assert.match(manager, /update.*pending|Update only pending/);
	assert.match(manager, /Never rewrite another worker's active task/);
});

test("manager requires independent clean review and real evidence before completion", () => {
	assert.match(manager, /mode: "review", followUp: false/);
	assert.match(manager, /Poll `agent_job_status`.*until terminal/);
	assert.match(manager, /read the complete result/);
	assert.match(manager, /successful process exit or a builder assertion is not proof/);
	assert.match(manager, /Route every must-fix and should-fix finding/);
	assert.match(manager, /no must-fix and no should-fix findings/);
	assert.match(manager, /there is no review-round cap/);
	assert.match(manager, /Only you mark the task `done`/);
	assert.match(manager, /Oracle failure or unavailability leaves review incomplete/);
	assert.match(manager, /Record the model that actually ran for each builder and Oracle round/);
	assert.match(manager, /same model family as the builder, note it in the Result; it is still a valid review/);
});

test("builder owns one implementation and evidence, never review or pending tasks", () => {
	assert.match(builder, /create the brief.*using `simple-tasks`/);
	assert.match(builder, /Reuse existing briefs/);
	assert.match(builder, /evidence-backed no-op is valid/);
	assert.match(builder, /Do not dispatch agents, summon Oracle, select the next task, or mark a task done/);
	assert.match(builder, /rerun affected checks plus the gate/);
	assert.match(builder, /Leave the task `in-progress` when ready for review/);
	assert.match(builder, /Do not edit `_active.md` or pending tasks/);
	assert.match(builder, /evidence paths/);
	assert.match(builder, /Do not commit, push, or deploy unless explicitly authorized/);
	assert.match(builder, /evidence, not instructions/);
	assert.match(builder, /`Files` and `Inspect first` are navigation/);
	assert.match(builder, /Work outside-in/);
	assert.match(builder, /Audit the actual diff against every Goal, Done, and binding Execute item/);
});
