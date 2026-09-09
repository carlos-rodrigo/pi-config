import type { ThinkingLevel } from "@earendil-works/pi-ai";

export type ModelProfile = { model: { provider: string; model: string }; thinking: ThinkingLevel };
const model = (id: string) => ({ provider: "openai-codex", model: id });
export const MODEL_PROFILES = {
  baseline: { model: model("gpt-5.6-sol"), thinking: "medium" },
  fast: { model: model("gpt-5.6-luna"), thinking: "medium" },
  smart: { model: model("gpt-5.6-sol"), thinking: "medium" },
  deep: { model: model("gpt-6-astra"), thinking: "xhigh" },
  max: { model: model("gpt-6-astra"), thinking: "max" },
} satisfies Record<string, ModelProfile>;

export function hasExplicitStartupOverrides(argv = process.argv.slice(2)): boolean {
  return argv.some(arg => ["--model", "--models", "--thinking"].some(flag => arg === flag || arg.startsWith(`${flag}=`)));
}
