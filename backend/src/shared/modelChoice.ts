export type ModelChoice = "fast" | "advanced";

export interface BedrockModelConfig {
  choice: ModelChoice;
  label: "Fast" | "Advanced";
  modelId: string;
  baseModelId: string;
  inputPricePerMTok: number;
  outputPricePerMTok: number;
}

const readNumberEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const MODEL_REGISTRY: Record<ModelChoice, BedrockModelConfig> = {
  fast: {
    choice: "fast",
    label: "Fast",
    modelId:
      process.env.BEDROCK_FAST_MODEL_ID ??
      "au.anthropic.claude-haiku-4-5-20251001-v1:0",
    baseModelId:
      process.env.BEDROCK_FAST_BASE_MODEL_ID ??
      "anthropic.claude-haiku-4-5-20251001-v1:0",
    inputPricePerMTok: readNumberEnv("BEDROCK_FAST_INPUT_PRICE_PER_MTOK", 1),
    outputPricePerMTok: readNumberEnv("BEDROCK_FAST_OUTPUT_PRICE_PER_MTOK", 5),
  },
  advanced: {
    choice: "advanced",
    label: "Advanced",
    modelId:
      process.env.BEDROCK_ADVANCED_MODEL_ID ??
      "au.anthropic.claude-sonnet-4-6",
    baseModelId:
      process.env.BEDROCK_ADVANCED_BASE_MODEL_ID ??
      "anthropic.claude-sonnet-4-6",
    inputPricePerMTok: readNumberEnv(
      "BEDROCK_ADVANCED_INPUT_PRICE_PER_MTOK",
      3,
    ),
    outputPricePerMTok: readNumberEnv(
      "BEDROCK_ADVANCED_OUTPUT_PRICE_PER_MTOK",
      15,
    ),
  },
};

export const isModelChoice = (value: unknown): value is ModelChoice =>
  value === "fast" || value === "advanced";

export const normaliseModelChoice = (value: unknown): ModelChoice =>
  isModelChoice(value) ? value : "fast";

export const parseOptionalModelChoice = (value: unknown): ModelChoice => {
  if (value == null || value === "") return "fast";
  if (isModelChoice(value)) return value;
  throw new Error('modelChoice must be "fast" or "advanced"');
};

export const resolveBedrockModel = (
  modelChoice: ModelChoice = "fast",
): BedrockModelConfig => MODEL_REGISTRY[modelChoice];

export const computeCostUsdForModelChoice = (
  inputTokens: number,
  outputTokens: number,
  modelChoice: ModelChoice = "fast",
): number => {
  const config = resolveBedrockModel(modelChoice);
  const cost =
    (inputTokens / 1_000_000) * config.inputPricePerMTok +
    (outputTokens / 1_000_000) * config.outputPricePerMTok;
  return Math.round(cost * 10_000) / 10_000;
};
