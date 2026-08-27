// ── Bedrock API wrappers ──────────────────────────────────────────────────────
// Two distinct AWS Bedrock APIs are used, each for a different purpose:
//
//   callClaude          → InvokeModelCommand  (single-turn)
//     Used by pipeline.ts. Sends one prompt, returns raw text. Simple and cheap.
//     Each pipeline skill (solve, explain, hint) calls this independently.
//
//   converseWithTools   → ConverseCommand  (multi-turn + tool use)
//     Used by the agent loop. Maintains the full conversation history and
//     advertises the tool schema so Claude can decide what to call next.
// ─────────────────────────────────────────────────────────────────────────────
import {
  BedrockRuntimeClient,
  ConverseCommand,
  InvokeModelCommand,
  type Message,
  type Tool,
} from "@aws-sdk/client-bedrock-runtime";
import type { DocumentType } from "@smithy/types";
import { jsonrepair } from "jsonrepair";
import { logger } from "./logger";
import type { ModelChoice } from "./modelChoice";
import { computeCostUsdForModelChoice, resolveBedrockModel } from "./modelChoice";

const client = new BedrockRuntimeClient({});

const GUARDRAIL_ID = process.env.BEDROCK_GUARDRAIL_ID;
const GUARDRAIL_VERSION = process.env.BEDROCK_GUARDRAIL_VERSION;

export const computeCostUsd = (
  inputTokens: number,
  outputTokens: number,
  modelChoice: ModelChoice = "fast",
): number => {
  return computeCostUsdForModelChoice(inputTokens, outputTokens, modelChoice);
};

// Helper: build a TokenUsage from raw counts using current price constants.
export interface RawTokenUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export const buildUsage = (
  inputTokens: number,
  outputTokens: number,
  modelChoice: ModelChoice = "fast",
): RawTokenUsage => ({
  inputTokens,
  outputTokens,
  costUsd: computeCostUsd(inputTokens, outputTokens, modelChoice),
});

export const sumUsage = (
  ...usages: RawTokenUsage[]
): RawTokenUsage => {
  let i = 0;
  let o = 0;
  for (const u of usages) {
    i += u.inputTokens;
    o += u.outputTokens;
  }
  const costUsd =
    Math.round(usages.reduce((sum, u) => sum + u.costUsd, 0) * 10_000) /
    10_000;
  return { inputTokens: i, outputTokens: o, costUsd };
};

const SYSTEM_PROMPT =
  "You are a helpful homework tutor for school students. Always respond in JSON.";

export const parseDataUrl = (
  dataUrl: string,
): { mediaType: string; base64Data: string } => {
  // Example data URL format:
  // data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...
  // This regex captures the media type (e.g., "image/png") and the base64 data separately.
  const match = dataUrl.match(
    /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/s,
  );
  if (!match) throw new Error("Invalid image data URL");
  // match[1] is the media type (e.g., "image/png"), match[2] is the base64-encoded data.
  return { mediaType: match[1], base64Data: match[2] };
};

// ---------------------------------------------------------------------------
// Single-turn API wrapper for pipeline skills (solve, explain, hint)
// ---------------------------------------------------------------------------

export interface CallClaudeResult {
  text: string;
  usage: RawTokenUsage;
}

export interface CallClaudeOptions {
  prompt: string;
  temperature?: number;
  image?: string;
  modelChoice?: ModelChoice;
}

export const callClaude = async (
  input: string | CallClaudeOptions,
  temperature: number = 0,
  image?: string,
  modelChoice: ModelChoice = "fast",
): Promise<CallClaudeResult> => {
  const options: CallClaudeOptions =
    typeof input === "string"
      ? { prompt: input, temperature, image, modelChoice }
      : input;
  const model = resolveBedrockModel(options.modelChoice ?? "fast");

  const userContent = options.image
    ? (() => {
        const { mediaType, base64Data } = parseDataUrl(options.image);
        return [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: base64Data },
          },
          { type: "text", text: options.prompt },
        ];
      })()
    : options.prompt;

  const requestBody = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
    temperature: options.temperature ?? 0,
    ...model.requestOverrides,
  };

  const command = new InvokeModelCommand({
    modelId: model.modelId,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify(requestBody),
    ...(GUARDRAIL_ID && GUARDRAIL_VERSION
      ? {
          guardrailIdentifier: GUARDRAIL_ID,
          guardrailVersion: GUARDRAIL_VERSION,
        }
      : {}),
  });

  logger.debug("bedrock_invoke_start", {
    modelId: model.modelId,
    modelChoice: model.choice,
    temperature: options.temperature ?? 0,
    guardrailEnabled: !!(GUARDRAIL_ID && GUARDRAIL_VERSION),
  });
  const invokeStart = Date.now();

  const response = await client.send(command);
  logger.debug("bedrock_invoke_complete", {
    modelId: model.modelId,
    modelChoice: model.choice,
    durationMs: Date.now() - invokeStart,
  });

  const parsed = JSON.parse(Buffer.from(response.body).toString("utf-8")) as {
    content: Array<{ type: string; text: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  if (!parsed.content?.length || !parsed.content[0]?.text) {
    throw new Error(
      "The content filter blocked this response. Please rephrase the question.",
    );
  }
  return {
    text: parsed.content[0].text,
    usage: buildUsage(
      parsed.usage?.input_tokens ?? 0,
      parsed.usage?.output_tokens ?? 0,
      model.choice,
    ),
  };
};

// ---------------------------------------------------------------------------
// Converse API — used by the agent loop (tool use)
// ---------------------------------------------------------------------------

// Looser message type: avoids the SDK's strict $unknown-bearing ContentBlock
// discriminated union while still producing objects the SDK accepts at runtime.
export interface BedrockMessage {
  role: "user" | "assistant";
  content: Record<string, unknown>[];
}

export interface ConverseResponse {
  stopReason: string;
  message: BedrockMessage;
  usage: RawTokenUsage;
}

export interface ConverseWithToolsOptions {
  messages: BedrockMessage[];
  tools: Tool[];
  system: string;
  toolChoice?: Record<string, unknown>;
  maxTokens?: number;
  enableGuardrail?: boolean;
  modelChoice?: ModelChoice;
}

export const converseWithTools = async (
  input: BedrockMessage[] | ConverseWithToolsOptions,
  tools?: Tool[],
  system?: string,
  toolChoice: Record<string, unknown> = { any: {} },
  maxTokens = 4096,
  enableGuardrail = true,
  modelChoice: ModelChoice = "fast",
): Promise<ConverseResponse> => {
  const options: ConverseWithToolsOptions = Array.isArray(input)
    ? {
        messages: input,
        tools: tools ?? [],
        system: system ?? "",
        toolChoice,
        maxTokens,
        enableGuardrail,
        modelChoice,
      }
    : input;
  const model = resolveBedrockModel(options.modelChoice ?? "fast");
  const command = new ConverseCommand({
    modelId: model.modelId,
    messages: options.messages as unknown as Message[],
    system: [{ text: options.system }],
    inferenceConfig: { maxTokens: options.maxTokens ?? 4096 },
    toolConfig: {
      tools: options.tools,
      toolChoice: (options.toolChoice ?? { any: {} }) as unknown as {
        any: Record<string, never>;
      },
    },
    ...(model.requestOverrides
      ? {
          additionalModelRequestFields:
            model.requestOverrides as unknown as DocumentType,
        }
      : {}),
    ...((options.enableGuardrail ?? true) && GUARDRAIL_ID && GUARDRAIL_VERSION
      ? {
          guardrailConfig: {
            guardrailIdentifier: GUARDRAIL_ID,
            guardrailVersion: GUARDRAIL_VERSION,
            trace: "enabled",
          },
        }
      : {}),
  });

  logger.debug("bedrock_converse_start", {
    modelId: model.modelId,
    modelChoice: model.choice,
    messageCount: options.messages.length,
    guardrailEnabled: !!(GUARDRAIL_ID && GUARDRAIL_VERSION),
  });
  const converseStart = Date.now();

  const response = await client.send(command);
  logger.debug("bedrock_converse_complete", {
    modelId: model.modelId,
    modelChoice: model.choice,
    durationMs: Date.now() - converseStart,
    stopReason: response.stopReason,
  });
  return {
    stopReason: response.stopReason ?? "end_turn",
    message: response.output!.message! as unknown as BedrockMessage,
    usage: buildUsage(
      response.usage?.inputTokens ?? 0,
      response.usage?.outputTokens ?? 0,
      model.choice,
    ),
  };
};

// Normalise a Bedrock tool-use `input` payload. Models occasionally emit
// structured arguments as JSON-encoded strings instead of the array/object
// the tool schema declares (observed with Haiku 4.5 + nested arrays). This
// helper accepts either form, parsing strings and, recursively, any string
// values that look like JSON arrays/objects.
//
// Use this at every tool-input extraction site instead of casting raw.
export const parseToolInput = <T,>(raw: unknown): T => {
  const parsed = parseIfJsonString(raw);
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      out[k] = parseIfJsonString(v);
    }
    return out as T;
  }
  return parsed as T;
};

const parseIfJsonString = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  const trimmed = v.trim();
  if (!trimmed) return v;
  const first = trimmed[0];
  if (first !== "[" && first !== "{") return v;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Models occasionally emit malformed JSON inside the stringified payload
    // (e.g. unescaped inner quotes). Fall back to jsonrepair before giving up.
    try {
      const repaired = jsonrepair(trimmed);
      const parsed = JSON.parse(repaired);
      logger.warn("tool_input_json_repaired", { originalLength: trimmed.length });
      return parsed;
    } catch {
      return v;
    }
  }
};

export type { Tool };
