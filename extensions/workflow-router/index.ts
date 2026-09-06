import { keyText, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { hasExplicitStartupOverrides, MODEL_PROFILES } from "../lib/model-profiles.ts";
import { baselineRoute, classifyTask, conversationContext, formatRoute, type Classification, type TaskRoute } from "./classifier.ts";
import { normalizeMode } from "../workflow-modes/index.ts";

const LEGEND_ENTRY_TYPE = "workflow-route-legend";
const ROUTING_STATES = ["auto", "manual", "fallback"] as const;
const EFFORT_COLORS = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
  max: "thinkingMax",
} as const;
type RoutingState = typeof ROUTING_STATES[number];
type LegendPlan = { state: RoutingState; reason: string };
export type RoutingLegendData = LegendPlan & {
  version: 1;
  model: string;
  modelId: string;
  effort: keyof typeof EFFORT_COLORS;
  showExpandHint: boolean;
};

function parseLegendData(value: unknown): RoutingLegendData | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const data = value as Record<string, unknown>;
  if (data.version !== 1 || !ROUTING_STATES.some(state => state === data.state)) return;
  if (typeof data.model !== "string" || !data.model || data.model.length > 100) return;
  if (typeof data.modelId !== "string" || !data.modelId || data.modelId.length > 200) return;
  if (typeof data.effort !== "string" || !Object.hasOwn(EFFORT_COLORS, data.effort)) return;
  if (typeof data.reason !== "string" || !data.reason || data.reason.length > 500) return;
  if (typeof data.showExpandHint !== "boolean") return;
  return data as RoutingLegendData;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default function workflowRouter(pi: ExtensionAPI, options: { classify?: typeof classifyTask } = {}) {
  let ctx: ExtensionContext | undefined;
  let locked = false;
  let revision = 0;
  let nextUserLegend: LegendPlan | undefined;
  let activeResponseLegend: LegendPlan | undefined;
  let legendHintShown = false;
  const expectedModels: Array<{ provider: string; id: string; previousProvider?: string; previousId?: string }> = [];
  const expectedThinking: Array<{ previousLevel: string; level?: string }> = [];
  function ownThinkingChange<T>(change: () => T): T {
    const expected: { previousLevel: string; level?: string } = { previousLevel: pi.getThinkingLevel() };
    expectedThinking.push(expected);
    try { return change(); }
    finally {
      expected.level = pi.getThinkingLevel();
      if (expected.level === expected.previousLevel) {
        const index = expectedThinking.indexOf(expected);
        if (index >= 0) expectedThinking.splice(index, 1);
      }
    }
  }
  const pendingClassifications = new Set<AbortController>();
  const classify = options.classify ?? classifyTask;

  function cancelClassifications() {
    revision++;
    for (const controller of pendingClassifications) controller.abort();
    pendingClassifications.clear();
  }

  async function classifyRequest(text: string, context: ExtensionContext, signal?: AbortSignal, images = false) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    pendingClassifications.add(controller);
    try {
      const result = await classify(text, context, { signal: controller.signal, images });
      controller.signal.throwIfAborted();
      return result;
    } finally {
      signal?.removeEventListener("abort", abort);
      pendingClassifications.delete(controller);
    }
  }
  let pending: { text: string; images: boolean } | undefined;
  let lastReport = "No task classified yet.";

  pi.registerEntryRenderer<RoutingLegendData>(LEGEND_ENTRY_TYPE, (entry, { expanded }, theme) => {
    const data = parseLegendData(entry.data);
    if (!data) return;
    const stateColor = data.state === "fallback" ? "warning" : data.state === "manual" ? "muted" : "accent";
    let text = theme.fg("text", theme.bold(data.model));
    text += theme.fg("dim", " · ") + theme.fg(EFFORT_COLORS[data.effort], data.effort);
    text += theme.fg("dim", " · ") + theme.fg(stateColor, titleCase(data.state));
    const expandKey = keyText("app.tools.expand") || "ctrl+o";
    const disclosure = data.showExpandHint ? `${expandKey} reason` : "reason";
    text += theme.fg("dim", expanded ? "  ▾" : `  ▸ ${disclosure}`);
    if (expanded) text += `\n${theme.fg("dim", "Reason: ")}${theme.fg("muted", data.reason)}`;
    return new Text(text, 1, 0);
  });

  function appendLegend(context: ExtensionContext, plan: LegendPlan) {
    const model = context.model;
    if (!model) return;
    pi.appendEntry<RoutingLegendData>(LEGEND_ENTRY_TYPE, {
      version: 1,
      state: plan.state,
      model: model.name || model.id,
      modelId: `${model.provider}/${model.id}`,
      effort: pi.getThinkingLevel(),
      reason: plan.reason.slice(0, 500),
      showExpandHint: !legendHintShown,
    });
    legendHintShown = true;
  }

  const manualLegend = (): LegendPlan => ({ state: "manual", reason: "Automatic routing is locked; current model and effort retained." });
  const retainedLegend = (): LegendPlan => locked
    ? manualLegend()
    : { state: "auto", reason: "This continuation retained the active model and effort." };

  function status(context: ExtensionContext) {
    if (context.hasUI) context.ui.setStatus("workflow-mode", `route: ${locked ? "locked" : "auto"} · ${context.model?.id ?? "no model"} · ${pi.getThinkingLevel()}`);
    pi.events.emit("workflow:mode", { mode: locked ? "locked" : "auto", label: locked ? "Locked" : "Auto" });
  }

  function restore(context: ExtensionContext) {
    let hasControl = false;
    locked = false;
    cancelClassifications();
    pending = undefined;
    nextUserLegend = undefined;
    activeResponseLegend = undefined;
    legendHintShown = false;
    lastReport = "No task classified yet.";
    for (const entry of context.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === "workflow-mode") { locked = true; hasControl = true; }
      if (entry.customType === "workflow-route") hasControl = true;
      if (entry.customType === LEGEND_ENTRY_TYPE && parseLegendData(entry.data)?.showExpandHint) legendHintShown = true;
      if (entry.customType === "workflow-router-control") {
        const value = entry.data as { locked?: unknown } | undefined;
        if (typeof value?.locked === "boolean") { locked = value.locked; hasControl = true; }
      }
    }
    return hasControl;
  }

  async function apply(route: TaskRoute, context: ExtensionContext, record = true, request?: { text: string; images: boolean }, classifier?: Classification["classifier"], expectedRevision = revision, signal?: AbortSignal) {
    const stale = () => revision !== expectedRevision || Boolean(signal?.aborted);
    if (stale()) return false;
    const target = context.modelRegistry.find(route.model.provider, route.model.model);
    let modelApplied = false;
    try {
      const tokens = context.getContextUsage()?.tokens;
      const hasConversation = context.sessionManager.getBranch().some(entry => ["message", "compaction", "branch_summary", "custom_message"].includes(entry.type));
      const shrinking = !context.model || (target?.contextWindow ?? 0) < context.model.contextWindow;
      // UTF-8 bytes are a conservative text-token upper bound; reserve framing headroom.
      const pendingTokens = Buffer.byteLength(request?.text ?? "", "utf8") + 1024;
      const capacity = target?.contextWindow ?? 0;
      const textFits = pendingTokens < capacity && (tokens == null ? !hasConversation || !shrinking : tokens + pendingTokens < capacity);
      const hasImages = request?.images || conversationContext(context).hasImages;
      const imagesFit = !hasImages || Boolean(target?.input.includes("image") && !shrinking);
      const fits = target && textFits && imagesFit;
      // Older installed SDKs do not expose the optional scoped-model catalogue.
      const scoped = (context as ExtensionContext & { scopedModels?: Array<{ model: { provider: string; id: string } }> }).scopedModels ?? [];
      const allowed = !scoped.length || scoped.some(item => item.model.provider === target?.provider && item.model.id === target?.id);
      if (fits && allowed) {
        const sameModel = context.model?.provider === target.provider && context.model.id === target.id;
        if (sameModel) modelApplied = true;
        else {
          const expected = { provider: target.provider, id: target.id, previousProvider: context.model?.provider, previousId: context.model?.id };
          expectedModels.push(expected);
          try { modelApplied = await ownThinkingChange(() => pi.setModel(target)); }
          finally {
            const index = expectedModels.indexOf(expected);
            if (index >= 0) expectedModels.splice(index, 1);
          }
        }
      }
      if (stale()) return false;
      if (modelApplied && pi.getThinkingLevel() !== route.thinking) ownThinkingChange(() => pi.setThinkingLevel(route.thinking));
    } catch {
      // Registry/auth failures must not prevent the user's request from running.
      modelApplied = false;
    }
    if (stale()) return false;
    const effectiveThinking = pi.getThinkingLevel();
    const thinkingClamped = modelApplied && effectiveThinking !== route.thinking;
    if (!modelApplied && context.hasUI) context.ui.notify(`Route to ${route.model.model} unavailable; keeping current model and effort.`, "warning");
    if (thinkingClamped && context.hasUI) context.ui.notify(`Requested ${route.thinking} reasoning; Pi applied ${effectiveThinking}.`, "warning");
    lastReport = `${formatRoute(route)}\nModel applied: ${modelApplied ? "yes" : "no"}\nEffective reasoning: ${effectiveThinking}${thinkingClamped ? " (clamped)" : ""}\nActive: ${context.model?.provider ?? "none"}/${context.model?.id ?? "none"}`;
    if (classifier) {
      const usage = classifier.usage;
      lastReport += `\nClassifier: ${classifier.status} · ${classifier.durationMs}ms`;
      lastReport += usage ? ` · ${usage.totalTokens} tokens · $${usage.cost.total.toFixed(6)}` : " · usage unavailable";
    }
    if (record) {
      const receipt = { route, modelApplied, thinkingClamped, activeModel: context.model?.id, thinking: effectiveThinking, classifier };
      try {
        pi.appendEntry("workflow-route", receipt);
        pi.events.emit("workflow:routing-record", { cwd: context.cwd, sessionId: context.sessionManager.getSessionId(), note: lastReport });
      } catch {
        if (context.hasUI) context.ui.notify("The routing decision could not be saved.", "warning");
      }
    }
    status(context);
    return { modelApplied, thinkingClamped, effectiveThinking };
  }

  pi.registerFlag("routing", { type: "string", description: "Task routing: auto or lock (default auto; CLI model overrides lock unless --routing auto)." });
  pi.on("session_start", async (event, context) => {
    ctx = context;
    const hasControl = restore(context);
    const restoreOnly = ["reload", "resume", "fork"].includes(event.reason);
    if (restoreOnly && hasControl) { status(context); return; }
    const flag = pi.getFlag("routing");
    if (flag === "auto") locked = false;
    else if (flag === "lock" || hasExplicitStartupOverrides()) locked = true;
    else if (flag !== undefined && context.hasUI) context.ui.notify("Invalid --routing value; expected auto or lock.", "warning");
    const rawMode = pi.getFlag("workflow-mode") ?? pi.getFlag("mode");
    const mode = typeof rawMode === "string" ? normalizeMode(rawMode) : undefined;
    if (mode) {
      locked = true;
      const profile = MODEL_PROFILES[mode];
      await apply({ ...baselineRoute(), ...profile, reason: "Explicit legacy workflow mode." }, context, false);
    } else if (!locked) {
      await apply(baselineRoute(), context, false);
    } else status(context);
    if (flag !== undefined || hasExplicitStartupOverrides() || mode) pi.appendEntry("workflow-router-control", { locked });
  });
  pi.on("session_tree", (_event, context) => { restore(context); status(context); });
  pi.on("session_shutdown", () => {
    cancelClassifications();
    ctx = undefined;
    pending = undefined;
    nextUserLegend = undefined;
    activeResponseLegend = undefined;
  });

  // Ordinary model selection is a baseline selection, not a routing lock.
  pi.on("model_select", (event, context) => {
    const index = expectedModels.findIndex(expected => event.source === "set" && expected.provider === event.model.provider && expected.id === event.model.id && expected.previousProvider === event.previousModel?.provider && expected.previousId === event.previousModel?.id);
    if (index >= 0) expectedModels.splice(index, 1);
    else cancelClassifications();
    status(context);
  });
  pi.on("thinking_level_select", (event, context) => {
    const index = expectedThinking.findIndex(expected => expected.previousLevel === event.previousLevel && (expected.level === undefined || expected.level === event.level));
    if (index >= 0) expectedThinking.splice(index, 1);
    else cancelClassifications();
    status(context);
  });
  pi.events.on("workflow:manual-mode", () => {
    cancelClassifications();
    locked = true;
    if (ctx) status(ctx);
  });
  pi.events.on("workflow:request-mode", () => { if (ctx) status(ctx); });

  pi.on("input", (event, context) => {
    // Pi's streaming queue continues the existing agent loop without before_agent_start.
    // Keep its model stable; only independent, idle user submissions are routed.
    if (event.streamingBehavior || !context.isIdle()) return;
    pending = event.source === "extension" ? undefined : { text: event.text, images: Boolean(event.images?.length) };
  });
  pi.on("before_agent_start", async (event, context) => {
    const input = pending;
    pending = undefined;
    nextUserLegend = undefined;
    if (!input) return;
    if (locked) {
      nextUserLegend = manualLegend();
      return;
    }
    nextUserLegend = { state: "fallback", reason: "Automatic routing did not complete; current model and effort retained." };
    const currentRevision = revision;
    const images = input.images || Boolean(event.images?.length);
    let classification: Classification;
    if (context.hasUI) context.ui.setStatus("workflow-mode", "route: classifying · Luna low");
    try {
      classification = await classifyRequest(event.prompt, context, context.signal, images);
    } catch (error) {
      if (revision === currentRevision) status(context);
      if (revision !== currentRevision || context.signal?.aborted) {
        if (locked) nextUserLegend = manualLegend();
        return;
      }
      nextUserLegend = undefined;
      throw error;
    }
    if (locked || revision !== currentRevision || context.signal?.aborted) {
      if (locked) nextUserLegend = manualLegend();
      return;
    }
    const { route, classifier } = classification;
    const applied = await apply(route, context, true, { text: event.prompt, images }, classifier, currentRevision, context.signal);
    if (!applied || locked || revision !== currentRevision || context.signal?.aborted) {
      if (locked) nextUserLegend = manualLegend();
      return;
    }
    const fallback = classifier.status !== "classified" || !applied.modelApplied || applied.thinkingClamped;
    let reason = route.reason;
    if (!applied.modelApplied) reason += " The requested route was unavailable; current settings were retained.";
    else if (applied.thinkingClamped) reason += ` Pi applied ${applied.effectiveThinking} effort instead of ${route.thinking}.`;
    nextUserLegend = { state: fallback ? "fallback" : "auto", reason };
    const available = new Set(pi.getActiveTools());
    const tools = route.tools.filter(name => available.has(name));
    if (!tools.length) return;
    return { systemPrompt: `${event.systemPrompt}\n\nTask routing hint (advisory): consider ${tools.join(", ")} when relevant. Use only the tools needed; inspect source evidence before edits. This hint changes neither authorization nor required verification.` };
  });
  pi.on("message_end", event => {
    if (event.message.role === "user") {
      activeResponseLegend = nextUserLegend ?? retainedLegend();
      nextUserLegend = undefined;
    } else if (event.message.role === "custom" && !activeResponseLegend) {
      activeResponseLegend = retainedLegend();
    }
  });
  pi.on("context", (_event, context) => {
    if (activeResponseLegend) appendLegend(context, activeResponseLegend);
  });
  pi.on("agent_settled", () => {
    activeResponseLegend = undefined;
  });

  async function preview(text: string, context: ExtensionContext, signal?: AbortSignal) {
    if (!text.trim()) throw new Error("Provide a request to classify.");
    return classifyRequest(text, context, signal);
  }
  const formatClassification = (result: Classification) => `${formatRoute(result.route)}\nClassifier: ${result.classifier.status} · ${result.classifier.durationMs}ms`;
  pi.registerCommand("classify", {
    description: "Preview task model, reasoning effort, and tool strategy without switching",
    handler: async (text, context) => {
      if (!text.trim()) { context.ui.notify("Usage: /classify <request>", "warning"); return; }
      context.ui.notify(formatClassification(await preview(text, context)), "info");
    },
  });
  pi.registerTool({
    name: "classify_task", label: "Classify Task", description: "Preview routing with a bounded Luna-low LLM call and recent conversation. Does not switch the active model or execute tools. Falls back to Astra medium.",
    parameters: Type.Object({ request: Type.String({ minLength: 1, maxLength: 20000 }) }),
    async execute(_id, params, signal, _onUpdate, context) {
      signal?.throwIfAborted();
      const result = await preview(params.request, context, signal);
      return { content: [{ type: "text", text: formatClassification(result) }], details: result, usage: result.classifier.usage };
    },
  });
  pi.registerCommand("route", {
    description: "Routing status/control: /route [auto|lock|<request>] (request previews only)",
    handler: async (text, context) => {
      const value = text.trim();
      if (!value) { context.ui.notify(`Routing ${locked ? "locked" : "auto"}\n${lastReport}`, "info"); return; }
      if (value !== "auto" && value !== "lock") { context.ui.notify(formatClassification(await preview(value, context)), "info"); return; }
      if (!context.isIdle()) { context.ui.notify("Change routing after the current task finishes.", "warning"); return; }
      locked = value === "lock";
      cancelClassifications();
      pi.appendEntry("workflow-router-control", { locked });
      if (!locked) await apply(baselineRoute(), context, false);
      else status(context);
      context.ui.notify(`Routing ${value}.`, "info");
    },
  });
}
