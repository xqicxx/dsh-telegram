/**
 * Reasoning effort — a per-chat preference that steers how much deliberation
 * the agent applies. Mirrors codex-telegram-bot: implemented as a concise
 * directive prepended to inbound messages so it works regardless of
 * backend-specific knobs (dsh providers without reasoning metadata reject
 * the official reasoningEffort route with UNSUPPORTED_REASONING_EFFORT).
 */
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const REASONING_DEFAULT: ReasoningEffort = "medium";

const DIRECTIVE: Record<ReasoningEffort, string> = {
  minimal: "Answer directly and briefly with minimal deliberation.",
  low: "Keep reasoning light; prefer a quick, concise solution.",
  medium: "", // default behaviour — no directive
  high: "Think carefully and thoroughly before answering; verify your work.",
  max: "Use maximum rigor: explore edge cases, double-check assumptions, and verify the result before finishing.",
};

const LABEL: Record<ReasoningEffort, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  max: "Max",
};

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

export function reasoningDirective(effort: ReasoningEffort): string {
  return DIRECTIVE[effort];
}

export function reasoningLabel(effort: ReasoningEffort): string {
  return LABEL[effort];
}
