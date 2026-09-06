// Opt-in, paid Luna calls: node --test extensions/workflow-router/live.eval.ts
// No execution-model calls or user-session changes. Synthetic conversation only.
import test from "node:test";
import assert from "node:assert/strict";
import { AuthStorage, ModelRegistry, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifyTask, type TaskRoute } from "./classifier.ts";

const cases: Array<{
  name: string;
  request: string;
  effort: TaskRoute["thinking"];
  recent?: Array<["user" | "assistant", string]>;
}> = [
  { name: "symbol lookup", request: "Find the symbol parseBranchList", effort: "medium" },
  { name: "documentation edit", request: "Fix the typo in the README install command", effort: "medium" },
  { name: "bounded feature", request: "Add a command to list local branches, following the existing command pattern", effort: "medium" },
  { name: "unit test", request: "Add a regression test for parseBranchList with empty input", effort: "medium" },
  { name: "routine bug", request: "Fix the off-by-one error in the pagination helper and add a regression test", effort: "medium" },
  { name: "routine review", request: "Review this small helper refactor for readability and behavior preservation", effort: "medium" },
  { name: "unknown scope", request: "Help improve this codebase; I am not sure where to start", effort: "medium" },
  { name: "ambiguous follow-up", request: "Implement this", effort: "medium" },
  { name: "context-dependent implementation", request: "Implement this", effort: "medium", recent: [
    ["user", "Find the branch parser"],
    ["assistant", "Found parseBranchList. It should return an empty array for blank input; add that guard and a test."],
  ] },
  { name: "routine follow-up after deep work", request: "Now fix the typo in the README command example", effort: "medium", recent: [
    ["user", "Perform a deep adversarial security review of the authentication flow"],
    ["assistant", "The review is complete. Findings and remediation notes are recorded."],
  ] },
  { name: "migration explanation", request: "Explain how database migrations work; do not implement anything", effort: "medium" },
  { name: "security explanation", request: "Explain what an authorization middleware does in plain language", effort: "medium" },
  { name: "production label, small change", request: "Fix the misspelled label on our production dashboard button; no behavior change", effort: "medium" },
  { name: "complex debugging", request: "Diagnose a cross-module race between cancellation, model switching, and delayed notifications; reason through their interleavings", effort: "high" },
  { name: "architecture explanation", request: "Compare event-driven and request-response designs for cross-service coordination, accounting for retries and consistency", effort: "medium" },
  { name: "constrained architecture design", request: "Design the cross-service coordination protocol for our order, inventory, and payment services. Resolve duplicate delivery, out-of-order events, partial failure, concurrent cancellation, and inventory consistency without distributed transactions; choose and justify the recovery design", effort: "high" },
  { name: "explicit deep scope", request: "Perform a prolonged adversarial security review of the authentication system, tracing multi-step exploit paths across trust boundaries", effort: "xhigh" },
  { name: "demonstrated lower-effort failure", request: "Investigate further; the concurrency bug is still unresolved", effort: "xhigh", recent: [
    ["user", "Use high effort to reproduce the intermittent deadlock"],
    ["assistant", "The high-effort attempt reproduced it but could not explain the cycle; multiple interacting races remain unresolved."],
  ] },
  { name: "explicit maximum effort", request: "Use maximum reasoning effort for an exhaustive production database migration and recovery plan", effort: "max" },
];

const modelRegistry = ModelRegistry.create(AuthStorage.create());
for (const sample of cases) test(sample.name, async t => {
  const entries = (sample.recent ?? []).map(([role, content]) => ({ type: "message", message: { role, content } }));
  const context = {
    modelRegistry,
    sessionManager: { getBranch: () => entries, buildContextEntries: () => entries },
  } as unknown as ExtensionContext;
  const result = await classifyTask(sample.request, context);
  t.diagnostic(JSON.stringify({ route: result.route, classifier: result.classifier }));
  // A medium fallback must not masquerade as a successful policy classification.
  assert.equal(result.classifier.status, "classified");
  assert.equal(result.route.thinking, sample.effort);
});
