import type { TokenUsage } from "../types";

const numberFormat = new Intl.NumberFormat("en-AU");

// "12,400 in / 3,200 out · ~$0.029"
export const formatUsage = (usage: TokenUsage | undefined): string => {
  if (!usage) return "";
  const inTok = numberFormat.format(usage.inputTokens);
  const outTok = numberFormat.format(usage.outputTokens);
  const cost = usage.costUsd > 0 ? ` · ~$${usage.costUsd.toFixed(4)}` : "";
  return `${inTok} in / ${outTok} out${cost}`;
};

// Compact variant for tight cards: "15,600 tok · $0.029"
export const formatUsageCompact = (usage: TokenUsage | undefined): string => {
  if (!usage) return "";
  const total = numberFormat.format(usage.inputTokens + usage.outputTokens);
  const cost = usage.costUsd > 0 ? ` · $${usage.costUsd.toFixed(4)}` : "";
  return `${total} tok${cost}`;
};
