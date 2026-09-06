import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import archive, { readArchiveRecords } from "../self-improvement-archive/index.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import router from "./index.ts";
import modes from "../workflow-modes/index.ts";
import { baselineRoute, classifyTask, conversationContext, parseClassification, type Classification } from "./classifier.ts";

function harness(options: { missing?: boolean; denied?: boolean; flags?: Record<string, unknown>; reverse?: boolean; tokens?: number | null; scoped?: string[]; initialWindow?: number; imageSupport?: boolean; clamp?: string; cwd?: string; archive?: boolean; classify?: typeof classifyTask } = {}) {
  type Handler = (event: never, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: Handler }>();
  const shortcuts = new Map<string, { handler: (ctx: ExtensionContext) => unknown }>();
  type ClassifierTool = { execute: (id: string, params: { request: string }, signal: AbortSignal, onUpdate: undefined, ctx: ExtensionContext) => Promise<unknown> };
  type EntryRenderer = (entry: { data?: unknown }, options: { expanded: boolean }, theme: { fg: (color: string, text: string) => string; bold: (text: string) => string }) => { render: (width: number) => string[] } | undefined;
  const tools = new Map<string, ClassifierTool>();
  const entryRenderers = new Map<string, EntryRenderer>();
  const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  const bus = new EventEmitter();
  const selected: string[] = [];
  const notifications: string[] = [];
  const statuses = new Map<string, string>();
  let model = { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", contextWindow: options.initialWindow ?? 272000, input: ["text", "image"] };
  let thinking = "medium";
  let idle = true;
  let switchPause: Promise<void> | undefined;
  let switchStarted: (() => void) | undefined;
  let activeTools = ["read", "symbol_search", "task_context_graph", "code_find", "verification_plan"];
  const ctx = {
    cwd: options.cwd ?? process.cwd(), hasUI: true,
    get model() { return model; },
    isIdle: () => idle,
    getContextUsage: () => ({ tokens: options.tokens === undefined ? 1000 : options.tokens }),
    scopedModels: options.scoped?.map(id => ({ model: { provider: "openai-codex", id } })),
    sessionManager: { getBranch: () => entries, getEntries: () => entries, getSessionId: () => "router-test" },
    modelRegistry: { find: (provider: string, id: string) => options.missing ? undefined : { provider, id, name: id === "gpt-6-astra" ? "GPT-6 Astra" : id === "gpt-5.6-luna" ? "GPT-5.6 Luna" : "GPT-5.6 Sol", contextWindow: 272000, input: options.imageSupport === false ? ["text"] : ["text", "image"] } },
    ui: { setStatus: (key: string, value: string) => statuses.set(key, value), notify: (text: string) => notifications.push(text), theme: { fg: (_: string, text: string) => text } },
  } as unknown as ExtensionContext;
  const pi = {
    on: (name: string, fn: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    events: bus,
    registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command),
    registerTool: (tool: ClassifierTool & { name: string }) => tools.set(tool.name, tool),
    registerEntryRenderer: (customType: string, renderer: EntryRenderer) => entryRenderers.set(customType, renderer),
    registerFlag() {},
    registerShortcut: (name: string, definition: { handler: (ctx: ExtensionContext) => unknown }) => shortcuts.set(name, definition),
    getCommands: () => [...commands.keys()].map(name => ({ name })),
    getFlag: (name: string) => options.flags?.[name],
    getAllTools: () => activeTools.map(name => ({ name })),
    getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => { activeTools = tools; },
    getThinkingLevel: () => thinking,
    setThinkingLevel: (value: string) => {
      const previousLevel = thinking;
      thinking = options.clamp ?? value;
      if (thinking !== previousLevel) void emit("thinking_level_select", { level: thinking, previousLevel });
    },
    setModel: async (value: typeof model) => {
      if (options.denied) return false;
      const previousModel = model;
      model = value; selected.push(value.id);
      const pause = switchPause; switchPause = undefined;
      await emit("model_select", { model, previousModel, source: "set" });
      switchStarted?.(); switchStarted = undefined;
      if (pause) await pause;
      return true;
    },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
  } as unknown as ExtensionAPI;
  const classifierCalls: Array<{ request: string; images?: boolean }> = [];
  // Fixed provider responses: these tests exercise routing lifecycle, not model intelligence.
  const lookupRequests = new Set(["Find the symbol parseBranchList", "Find the symbol foo", "Find the symbol logo"]);
  const classify: typeof classifyTask = options.classify ?? (async (request, _context, classifierOptions) => {
    classifierOptions?.signal?.throwIfAborted();
    classifierCalls.push({ request, images: classifierOptions?.images });
    const route = lookupRequests.has(request) && !classifierOptions?.images
      ? parseClassification(JSON.stringify({ profile: "luna-medium", task: "locate", strategy: ["symbol_search"], reason: "simple" }))!
      : baselineRoute();
    return { route, classifier: { model: "openai-codex/gpt-5.6-luna", thinking: "low", status: "classified", durationMs: 1 } };
  });
  if (options.archive) archive(pi);
  if (options.reverse) { router(pi, { classify }); modes(pi); } else { modes(pi); router(pi, { classify }); }
  async function emit(name: string, event: unknown = {}) {
    const results = [];
    for (const fn of handlers.get(name) ?? []) results.push(await fn(event as never, ctx));
    if (name === "input" && idle && !(event as { streamingBehavior?: string }).streamingBehavior) {
      results.push(...await emit("before_agent_start", { prompt: (event as { text: string }).text, systemPrompt: "BASE" }));
    }
    return results;
  }
  return { ctx, entries, selected, notifications, statuses, emit, tools, entryRenderers, classifierCalls, active: () => activeTools,
    cycle: () => shortcuts.get("ctrl+shift+m")!.handler(ctx),
    pauseNextSwitch: (pause: Promise<void>, began: () => void) => { switchPause = pause; switchStarted = began; },
    thinking: () => thinking, idle: (value: boolean) => { idle = value; },
    command: (name: string, text = "") => commands.get(name)!.handler(text as never, ctx) };
}

for (const reverse of [false, true]) test(`router owns startup in either extension order (${reverse})`, async () => {
  const h = harness({ reverse });
  await h.emit("session_start");
  assert.deepEqual(h.selected, ["gpt-6-astra"]);
  assert.equal(h.thinking(), "medium");
  assert.equal(h.classifierCalls.length, 0);
  const tools = [...h.active()];
  const replies = await h.emit("input", { text: "Find the symbol parseBranchList", source: "interactive" });
  assert.equal(h.selected.at(-1), "gpt-5.6-luna");
  assert.deepEqual(h.active(), tools);
  assert.ok(JSON.stringify(replies).includes("symbol_search"));
});
test("timeline legend appears after the user message and before the provider call", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.emit("input", { text: "Find the symbol foo", source: "interactive" });
  assert.equal(h.entries.some(entry => entry.customType === "workflow-route-legend"), false);
  await h.emit("message_end", { message: { role: "user" } });
  assert.equal(h.entries.some(entry => entry.customType === "workflow-route-legend"), false);
  await h.emit("context", { messages: [] });
  const legend = h.entries.find(entry => entry.customType === "workflow-route-legend")?.data as Record<string, unknown>;
  assert.deepEqual(legend, {
    version: 1,
    state: "auto",
    model: "GPT-5.6 Luna",
    modelId: "openai-codex/gpt-5.6-luna",
    effort: "medium",
    reason: "Explicit, narrowly bounded work.",
    showExpandHint: true,
  });
});

test("timeline legend records fallback and manual routing using actual settings", async () => {
  const fallback = harness({ classify: (request, context, options) => classifyTask(request, context, { ...options, call: async () => ({ text: "INVALID", stopReason: "stop" }) }) });
  await fallback.emit("session_start");
  await fallback.emit("input", { text: "Do this", source: "interactive" });
  await fallback.emit("message_end", { message: { role: "user" } });
  await fallback.emit("context", { messages: [] });
  const fallbackData = fallback.entries.find(entry => entry.customType === "workflow-route-legend")?.data as Record<string, unknown>;
  assert.equal(fallbackData.state, "fallback");
  assert.equal(fallbackData.model, "GPT-6 Astra");
  assert.equal(fallbackData.effort, "medium");
  assert.match(String(fallbackData.reason), /invalid-output/);

  const manual = harness();
  await manual.emit("session_start");
  await manual.command("route", "lock");
  await manual.emit("input", { text: "Do this", source: "interactive" });
  await manual.emit("message_end", { message: { role: "user" } });
  await manual.emit("context", { messages: [] });
  const manualData = manual.entries.find(entry => entry.customType === "workflow-route-legend")?.data as Record<string, unknown>;
  assert.equal(manualData.state, "manual");
  assert.equal(manualData.model, "GPT-6 Astra");
  assert.equal(manualData.effort, "medium");
  assert.match(String(manualData.reason), /locked/i);
});

test("timeline legend marks unavailable or clamped automatic routes as fallback", async () => {
  const unavailable = harness({ missing: true });
  await unavailable.emit("session_start");
  await unavailable.emit("input", { text: "Find the symbol foo", source: "interactive" });
  await unavailable.emit("message_end", { message: { role: "user" } });
  await unavailable.emit("context", { messages: [] });
  const unavailableData = unavailable.entries.find(entry => entry.customType === "workflow-route-legend")?.data as Record<string, unknown>;
  assert.equal(unavailableData.state, "fallback");
  assert.equal(unavailableData.model, "GPT-5.6 Sol");
  assert.equal(unavailableData.effort, "medium");
  assert.match(String(unavailableData.reason), /unavailable/);

  const clamped = harness({ clamp: "medium", classify: (request, context, options) => classifyTask(request, context, { ...options, call: async () => ({
    text: JSON.stringify({ profile: "astra-high", task: "debug", strategy: [], reason: "complex" }), stopReason: "stop",
  }) }) });
  await clamped.emit("session_start");
  await clamped.emit("input", { text: "Debug a cross-module race condition", source: "interactive" });
  await clamped.emit("message_end", { message: { role: "user" } });
  await clamped.emit("context", { messages: [] });
  const clampedData = clamped.entries.find(entry => entry.customType === "workflow-route-legend")?.data as Record<string, unknown>;
  assert.equal(clampedData.state, "fallback");
  assert.equal(clampedData.model, "GPT-6 Astra");
  assert.equal(clampedData.effort, "medium");
  assert.match(String(clampedData.reason), /instead of high/);
});

test("each provider call in a tool-using response gets the same route legend", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.emit("input", { text: "Find the symbol foo", source: "interactive" });
  await h.emit("message_end", { message: { role: "user" } });
  await h.emit("context", { messages: [] });
  await h.emit("message_end", { message: { role: "assistant", stopReason: "toolUse" } });
  await h.emit("message_end", { message: { role: "toolResult" } });
  await h.emit("context", { messages: [] });
  const legends = h.entries.filter(entry => entry.customType === "workflow-route-legend").map(entry => entry.data as Record<string, unknown>);
  assert.equal(legends.length, 2);
  assert.deepEqual(legends.map(legend => legend.state), ["auto", "auto"]);
  assert.deepEqual(legends.map(legend => legend.model), ["GPT-5.6 Luna", "GPT-5.6 Luna"]);
  assert.deepEqual(legends.map(legend => legend.reason), ["Explicit, narrowly bounded work.", "Explicit, narrowly bounded work."]);
  await h.emit("agent_settled");
  await h.emit("context", { messages: [] });
  assert.equal(h.entries.filter(entry => entry.customType === "workflow-route-legend").length, 2);
});

test("extension-triggered responses get a retained-route legend", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.emit("message_end", { message: { role: "custom" } });
  await h.emit("context", { messages: [] });
  const legend = h.entries.find(entry => entry.customType === "workflow-route-legend")?.data as Record<string, unknown>;
  assert.equal(legend.state, "auto");
  assert.equal(legend.model, "GPT-6 Astra");
  assert.equal(legend.effort, "medium");
  assert.match(String(legend.reason), /retained/);
});

test("queued continuations get a retained-route legend without repeating the expand hint", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.emit("input", { text: "Find the symbol foo", source: "interactive" });
  await h.emit("message_end", { message: { role: "user" } });
  await h.emit("context", { messages: [] });
  await h.emit("message_end", { message: { role: "user" } });
  await h.emit("context", { messages: [] });
  const legends = h.entries.filter(entry => entry.customType === "workflow-route-legend").map(entry => entry.data as Record<string, unknown>);
  assert.equal(legends.length, 2);
  assert.equal(legends[0].showExpandHint, true);
  assert.equal(legends[1].showExpandHint, false);
  assert.equal(legends[1].state, "auto");
  assert.match(String(legends[1].reason), /retained/);
});

test("reload keeps prior legends and does not repeat the expansion shortcut hint", async () => {
  const h = harness();
  h.entries.push({ type: "custom", customType: "workflow-route-legend", data: {
    version: 1, state: "auto", model: "GPT-6 Astra", modelId: "openai-codex/gpt-6-astra",
    effort: "xhigh", reason: "Interacting constraints or difficult reasoning.", showExpandHint: true,
  } });
  await h.emit("session_start", { reason: "reload" });
  await h.emit("input", { text: "Find the symbol foo", source: "interactive" });
  await h.emit("message_end", { message: { role: "user" } });
  await h.emit("context", { messages: [] });
  const legends = h.entries.filter(entry => entry.customType === "workflow-route-legend").map(entry => entry.data as Record<string, unknown>);
  assert.equal(legends.length, 2);
  assert.equal(legends[1].showExpandHint, false);
});

test("timeline legend reveals only its bounded reason in expanded transcript mode", () => {
  const h = harness();
  const renderer = h.entryRenderers.get("workflow-route-legend")!;
  const entry = { data: {
    version: 1, state: "auto", model: "GPT-6 Astra", modelId: "openai-codex/gpt-6-astra",
    effort: "xhigh", reason: "Interacting constraints or difficult reasoning.", showExpandHint: true,
  } };
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const collapsed = renderer(entry, { expanded: false }, theme)!.render(80).join("\n");
  assert.match(collapsed, /GPT-6 Astra · xhigh · Auto/);
  assert.match(collapsed, /reason/);
  assert.doesNotMatch(collapsed, /Interacting constraints/);
  const expanded = renderer(entry, { expanded: true }, theme)!.render(32);
  assert.match(expanded.join(" ").replace(/\s+/g, " "), /Reason: Interacting constraints or difficult reasoning\./);
  assert.ok(expanded.every(line => line.length <= 32));
  assert.equal(renderer({ data: { state: "auto" } }, { expanded: false }, theme), undefined);
});

test("preview does not switch, legacy command locks, auto resumes routing", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.command("classify", "Find the symbol foo");
  assert.equal(h.selected.length, 1);
  await h.command("deep");
  await h.emit("input", { text: "Find the symbol foo", source: "interactive" });
  assert.equal(h.selected.at(-1), "gpt-6-astra");
  assert.equal(h.thinking(), "xhigh");
  await h.command("route", "auto");
  assert.equal(h.selected.at(-1), "gpt-6-astra");
  assert.equal(h.thinking(), "medium");
  await h.emit("input", { text: "Find the symbol foo", source: "interactive" });
  assert.equal(h.selected.at(-1), "gpt-5.6-luna");
});
for (const [profile, effort, reason] of [["astra-high", "high", "complex"], ["astra-xhigh", "xhigh", "lower-effort-insufficient"]]) {
  test(`${profile} applies and an independent routine request returns to medium`, async () => {
    const responses = [
      { profile, task: "debug", strategy: [], reason },
      { profile: "astra-medium", task: "implement", strategy: [], reason: "bounded" },
    ];
    const h = harness({ classify: (request, context, options) => classifyTask(request, context, { ...options, call: async () => ({
      text: JSON.stringify(responses.shift()), stopReason: "stop",
    }) }) });
    await h.emit("session_start");
    await h.emit("input", { text: "Investigate the unresolved concurrency failure", source: "interactive" });
    assert.equal(h.thinking(), effort);
    await h.emit("message_end", { message: { role: "user" } });
    await h.emit("context", { messages: [] });
    const legend = h.entries.findLast(e => e.customType === "workflow-route-legend")?.data as Record<string, unknown>;
    assert.equal(legend.effort, effort);
    assert.equal(legend.state, "auto");
    await h.emit("agent_settled");
    await h.emit("input", { text: "Now add a blank-input guard to the parser", source: "interactive" });
    assert.equal(h.ctx.model?.id, "gpt-6-astra");
    assert.equal(h.thinking(), "medium");
  });
}

test("lock restores from branch, but a new session does not inherit it", async () => {
  const h = harness();
  await h.emit("session_start"); await h.command("route", "lock");
  await h.emit("session_start", { reason: "reload" });
  const n = h.selected.length;
  await h.emit("input", { text: "Find the symbol foo", source: "interactive" });
  assert.equal(h.selected.length, n);
  h.entries.length = 0;
  await h.emit("session_start", { reason: "new" });
  await h.emit("input", { text: "Find the symbol foo", source: "rpc" });
  assert.equal(h.selected.at(-1), "gpt-5.6-luna");
});
test("extension, steering, and queued inputs cannot change a running model", async () => {
  const h = harness(); await h.emit("session_start");
  for (const event of [
    { source: "extension" }, { source: "interactive", streamingBehavior: "steer" },
    { source: "interactive", streamingBehavior: "followUp" },
  ]) await h.emit("input", { text: "Find the symbol foo", ...event });
  h.idle(false);
  await h.emit("input", { text: "Find the symbol foo", source: "rpc" });
  assert.equal(h.selected.length, 1);
});
for (const problem of ["missing", "denied"] as const) test(`${problem} target preserves model and effort without claiming a switch`, async () => {
  const h = harness({ [problem]: true });
  await h.emit("session_start");
  await h.emit("input", { text: "Debug a race condition", source: "interactive" });
  assert.equal(h.selected.length, 0);
  assert.equal(h.thinking(), "medium");
  assert.ok(h.notifications.some(n => /keeping current/i.test(n)));
});
test("queued requests do not leave stale routing state for a later agent start", async () => {
  const h = harness(); await h.emit("session_start");
  h.idle(false);
  await h.emit("input", { text: "Find the symbol foo", source: "interactive", streamingBehavior: "followUp" });
  assert.equal(h.selected.length, 1);
  await h.emit("before_agent_start", { prompt: "Find the symbol foo", systemPrompt: "BASE" });
  assert.equal(h.selected.length, 1);
});
test("CLI model overrides pin jobs unless routing is explicitly enabled", async () => {
  const argv = process.argv;
  process.argv = [...argv.slice(0, 2), "--model=openai-codex/gpt-6-astra", "--thinking=medium"];
  try {
    const pinned = harness(); await pinned.emit("session_start");
    await pinned.emit("input", { text: "Find the symbol foo", source: "interactive" });
    assert.equal(pinned.selected.length, 0);
    const auto = harness({ flags: { routing: "auto" } }); await auto.emit("session_start");
    await auto.emit("input", { text: "Find the symbol foo", source: "interactive" });
    assert.equal(auto.selected.at(-1), "gpt-5.6-luna");
  } finally { process.argv = argv; }
});
for (const options of [{ tokens: 300000 }, { scoped: ["gpt-6-astra"] }]) test(`incompatible route preserves active model: ${JSON.stringify(options)}`, async () => {
  const h = harness(options); await h.emit("session_start");
  const n = h.selected.length;
  await h.emit("input", { text: "Find the symbol foo", source: "interactive" });
  assert.equal(h.selected.length, n);
  assert.equal(h.thinking(), "medium");
});
test("attachments reach the classifier, and receipts do not persist request text", async () => {
  const h = harness(); await h.emit("session_start");
  await h.emit("input", { text: "Find the symbol privateCustomerIdentifier", images: [{}], source: "interactive" });
  assert.equal(h.selected.at(-1), "gpt-6-astra");
  assert.equal(h.classifierCalls.at(-1)?.images, true);
  assert.doesNotMatch(JSON.stringify(h.entries), /privateCustomerIdentifier/);
});
test("legacy mode flag stays locked and cycles Max to Fast", async () => {
  const h = harness({ flags: { mode: "max" } }); await h.emit("session_start");
  assert.equal(h.thinking(), "max");
  await h.emit("input", { text: "Find the symbol foo", source: "interactive" });
  assert.equal(h.thinking(), "max");
  await h.cycle();
  assert.equal(h.selected.at(-1), "gpt-5.6-luna");
});
test("legacy workflow flag aliases retain explicit effort", async () => {
  const h = harness({ flags: { "workflow-mode": "maximum" } }); await h.emit("session_start");
  assert.equal(h.thinking(), "max");
  await h.emit("input", { text: "Find the symbol foo", source: "interactive" });
  assert.equal(h.thinking(), "max");
});
test("reload supplies branch conversation instead of blindly inheriting a stored route", async () => {
  let recent: unknown;
  const h = harness({ classify: async (_request, ctx) => {
    recent = conversationContext(ctx).recent;
    return { route: baselineRoute(), classifier: { model: "test", thinking: "low", status: "classified", durationMs: 1 } };
  } });
  await h.emit("session_start");
  h.entries.push(Object.assign({ type: "message", customType: "", data: undefined }, { message: { role: "user", content: "Investigate a race condition" } }));
  h.entries.push({ type: "custom", customType: "workflow-route", data: { route: { model: null, tools: "bad" } } });
  await h.emit("session_start", { reason: "reload" });
  await h.emit("input", { text: "Implement this", source: "interactive" });
  assert.match(JSON.stringify(recent), /race condition/);
  assert.equal(h.thinking(), "medium");
});
test("explicit auto startup does not erase a later manual lock on reload", async () => {
  const h = harness({ flags: { routing: "auto" } }); await h.emit("session_start");
  await h.command("route", "lock");
  await h.emit("session_start", { reason: "reload" });
  const n = h.selected.length;
  await h.emit("input", { text: "Find the symbol foo", source: "interactive" });
  assert.equal(h.selected.length, n);
});
test("unavailable legacy preset does not change effort or lock routing", async () => {
  const h = harness({ denied: true }); await h.emit("session_start");
  await h.command("deep");
  assert.equal(h.thinking(), "medium");
  assert.equal(h.entries.some(e => e.customType === "workflow-mode"), false);
});
test("same-profile requests do not append redundant model selections", async () => {
  const h = harness(); await h.emit("session_start");
  await h.emit("input", { text: "Help me think through our product direction", source: "interactive" });
  await h.emit("input", { text: "Explain the trade-offs", source: "interactive" });
  assert.deepEqual(h.selected, ["gpt-6-astra"]);
});
for (const reason of ["startup", "reload", "resume"]) test(`legacy Max cycle restores on ${reason}`, async () => {
  const h = harness();
  h.entries.push({ type: "custom", customType: "workflow-mode", data: { mode: "max" } });
  await h.emit("session_start", { reason });
  await h.cycle();
  assert.equal(h.selected.at(-1), "gpt-5.6-luna");
});
test("legacy cycle restores on tree navigation and from a CLI preset", async () => {
  const h = harness({ flags: { "workflow-mode": "max" } });
  await h.emit("session_start", { reason: "startup" }); await h.cycle();
  assert.equal(h.selected.at(-1), "gpt-5.6-luna");
  h.entries.push({ type: "custom", customType: "workflow-mode", data: { mode: "max" } });
  await h.emit("session_tree"); await h.cycle();
  assert.equal(h.selected.at(-1), "gpt-5.6-luna");
});
test("unknown post-compaction usage never shrinks the context window", async () => {
  const h = harness({ tokens: null, initialWindow: 1050000 });
  h.entries.push({ type: "compaction", customType: "", data: {} });
  await h.emit("session_start");
  await h.emit("input", { text: "Find the symbol foo", source: "interactive" });
  assert.equal(h.selected.length, 0);
  assert.equal(h.ctx.model?.contextWindow, 1050000);
});
test("pending prompt size is included in the context guard", async () => {
  const h = harness({ tokens: 270000 }); await h.emit("session_start");
  await h.emit("input", { text: "Explain " + "x".repeat(3000), source: "interactive" });
  const receipt = h.entries.findLast(e => e.customType === "workflow-route")?.data as { modelApplied: boolean };
  assert.equal(receipt.modelApplied, false);
});
test("image requests cannot switch to a text-only catalogue entry", async () => {
  const h = harness({ imageSupport: false }); await h.emit("session_start");
  Object.assign(h.ctx.model!, { id: "gpt-5.6-sol", input: ["text", "image"] });
  const n = h.selected.length;
  await h.emit("input", { text: "Describe this screenshot", images: [{}], source: "interactive" });
  assert.equal(h.selected.length, n);
  assert.equal(h.ctx.model?.id, "gpt-5.6-sol");
});
for (const lock of ["manual", "cli"]) test(`archive reports ${lock} locking and effective clamped effort`, async t => {
  const cwd = mkdtempSync(join(tmpdir(), "router-archive-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const h = harness({ cwd, archive: true, clamp: "high", flags: lock === "cli" ? { routing: "lock" } : {},
    classify: (request, context, options) => classifyTask(request, context, { ...options, call: async () => ({
      text: JSON.stringify({ profile: "astra-xhigh", task: "debug", strategy: [], reason: "lower-effort-insufficient" }), stopReason: "stop",
    }) }),
  });
  await h.emit("session_start");
  if (lock === "manual") await h.command("deep");
  await h.emit("agent_start"); await h.emit("agent_settled");
  assert.equal(readArchiveRecords(cwd).records.find(r => r.kind === "run")?.workflowMode, "locked");
  await h.command("route", "auto");
  await h.emit("input", { text: "High effort did not resolve this race condition; investigate further", source: "interactive" });
  const receipt = h.entries.findLast(e => e.customType === "workflow-route")?.data as { modelApplied: boolean; thinkingClamped: boolean; thinking: string };
  assert.equal(receipt.modelApplied, true);
  assert.equal(receipt.thinkingClamped, true);
  assert.equal(receipt.thinking, "high");
  assert.ok(readArchiveRecords(cwd).records.some(r => r.kind === "note" && /Effective reasoning: high \(clamped\)/.test(r.note ?? "")));
});
test("classifier tool is read-only and rejects blank or cancelled requests", async () => {
  const h = harness(); await h.emit("session_start");
  const tool = h.tools.get("classify_task")!;
  const response = await tool.execute("id", { request: "Find the symbol foo" }, new AbortController().signal, undefined, h.ctx);
  assert.match(JSON.stringify(response), /gpt-5.6-luna/);
  assert.equal(h.selected.length, 1);
  await assert.rejects(tool.execute("id", { request: " " }, new AbortController().signal, undefined, h.ctx), /Provide a request/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(tool.execute("id", { request: "hello" }, abort.signal, undefined, h.ctx), /abort/i);
});
test("async classification cannot override a subsequent lock or session shutdown", async () => {
  for (const interrupt of ["lock", "shutdown"] as const) {
    let release!: (result: Classification) => void;
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const h = harness({ classify: async () => { began(); return new Promise(resolve => { release = resolve; }); } });
    await h.emit("session_start");
    const pending = h.emit("input", { text: "Find the symbol foo", source: "interactive" });
    await started;
    if (interrupt === "lock") await h.command("route", "lock");
    else await h.emit("session_shutdown");
    release({ route: parseClassification(JSON.stringify({ profile: "luna-medium", task: "locate", strategy: [], reason: "simple" }))!, classifier: { model: "test", thinking: "low", status: "classified", durationMs: 1 } });
    await pending;
    assert.deepEqual(h.selected, ["gpt-6-astra"]);
    if (interrupt === "lock") {
      await h.emit("message_end", { message: { role: "user" } });
      await h.emit("context", { messages: [] });
      const legend = h.entries.find(entry => entry.customType === "workflow-route-legend")?.data as Record<string, unknown>;
      assert.equal(legend.state, "manual");
      assert.equal(legend.model, "GPT-6 Astra");
      assert.equal(legend.effort, "medium");
    }
  }
});
test("a pending model switch cannot apply stale effort, receipts, or tool hints", async () => {
  for (const interrupt of ["lock", "shutdown", "manual-model"] as const) {
    const h = harness(); await h.emit("session_start");
    let release!: () => void; let began!: () => void;
    const pause = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { began = resolve; });
    h.pauseNextSwitch(pause, began);
    const request = h.emit("input", { text: "Find the symbol foo", source: "interactive" });
    await started;
    if (interrupt === "lock") await h.command("route", "lock");
    else if (interrupt === "shutdown") await h.emit("session_shutdown");
    else await h.command("deep");
    const thinking = h.thinking();
    const receipts = h.entries.filter(e => e.customType === "workflow-route").length;
    release(); const results = await request;
    assert.equal(h.thinking(), thinking);
    assert.equal(h.entries.filter(e => e.customType === "workflow-route").length, receipts);
    assert.doesNotMatch(JSON.stringify(results), /Task routing hint/);
    if (interrupt === "manual-model") assert.equal(h.ctx.model?.id, "gpt-6-astra");
  }
});
test("a failed classifier selects Astra medium after a previous cheap route", async () => {
  let calls = 0;
  const h = harness({ classify: (request, context, options) => classifyTask(request, context, { ...options, call: async () => ({
    text: calls++ === 0 ? JSON.stringify({ profile: "luna-medium", task: "locate", strategy: [], reason: "simple" }) : "INVALID", stopReason: "stop",
  }) }) });
  await h.emit("session_start");
  await h.emit("input", { text: "Find the symbol foo", source: "interactive" });
  assert.equal(h.selected.at(-1), "gpt-5.6-luna");
  await h.emit("input", { text: "Implement this", source: "interactive" });
  assert.equal(h.selected.at(-1), "gpt-6-astra"); assert.equal(h.thinking(), "medium");
  assert.match(JSON.stringify(h.entries), /invalid-output/);
});
test("retained image context prevents a text-only downgrade", async () => {
  const h = harness({ imageSupport: false }); await h.emit("session_start");
  Object.assign(h.ctx.model!, { input: ["text", "image"] });
  h.entries.push(Object.assign({ type: "message", customType: "", data: undefined }, { message: { role: "user", content: [{ type: "image", data: "fixture" }] } }));
  await h.emit("input", { text: "Find the symbol foo", source: "interactive" });
  assert.equal(h.selected.at(-1), "gpt-6-astra");
});
test("classifier tool returns nested usage and automatic receipts record overhead", async () => {
  const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0001 } };
  const h = harness({ classify: async () => ({ route: baselineRoute(), classifier: { model: "test", thinking: "low", status: "classified", durationMs: 12, usage } }) });
  await h.emit("session_start");
  const result = await h.tools.get("classify_task")!.execute("id", { request: "hello" }, new AbortController().signal, undefined, h.ctx) as { usage: unknown };
  assert.deepEqual(result.usage, usage);
  await h.emit("input", { text: "hello", source: "interactive" });
  assert.match(JSON.stringify(h.entries), /durationMs.*12/);
  await h.command("route");
  assert.match(h.notifications.at(-1) ?? "", /30 tokens.*0.000100/);
});
test("locked routing does not call the classifier", async () => {
  const h = harness({ flags: { routing: "lock" } }); await h.emit("session_start");
  await h.emit("input", { text: "Find the symbol foo", source: "interactive" });
  assert.equal(h.classifierCalls.length, 0);
});
test("Astra selection does not implicitly lock automatic routing", async () => {
  const h = harness(); await h.emit("session_start");
  await h.emit("model_select", { model: h.ctx.model, source: "set" });
  await h.emit("input", { text: "Find the symbol foo", source: "interactive" });
  assert.equal(h.selected.at(-1), "gpt-5.6-luna");
});
