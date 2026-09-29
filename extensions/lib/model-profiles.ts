import type { ThinkingLevel } from "@earendil-works/pi-ai";

export type ModelProfile = { model: { provider: string; model: string }; thinking: ThinkingLevel };
const openai = (id: string) => ({ provider: "openai", model: id });
export const MODEL_PROFILES = {
  fast: { model: openai("gpt-6.1-sol"), thinking: "medium" },
  smart: { model: { provider: "claude-bridge", model: "claude-opus-5-5" }, thinking: "medium" },
  deep: { model: openai("gpt-6-astra"), thinking: "xhigh" },
  max: { model: openai("gpt-6-astra"), thinking: "max" },
} satisfies Record<string, ModelProfile>;

export function hasExplicitStartupOverrides(argv = process.argv.slice(2)): boolean {
  return argv.some(arg => ["--model", "--models", "--thinking"].some(flag => arg === flag || arg.startsWith(`${flag}=`)));
}
