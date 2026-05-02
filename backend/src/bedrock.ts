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
import { logger } from "./logger";

const client = new BedrockRuntimeClient({});

const GUARDRAIL_ID = process.env.BEDROCK_GUARDRAIL_ID;
const GUARDRAIL_VERSION = process.env.BEDROCK_GUARDRAIL_VERSION;

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

export const callClaude = async (
  prompt: string,
  temperature: number = 0,
  image?: string,
): Promise<string> => {
  const modelId = process.env.BEDROCK_MODEL_ID;
  if (!modelId) {
    throw new Error("BEDROCK_MODEL_ID environment variable is not set");
  }

  const userContent = image
    ? (() => {
        const { mediaType, base64Data } = parseDataUrl(image);
        return [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: base64Data },
          },
          { type: "text", text: prompt },
        ];
      })()
    : prompt;

  const requestBody = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
    temperature,
  };

  const command = new InvokeModelCommand({
    modelId,
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
    modelId,
    temperature,
    guardrailEnabled: !!(GUARDRAIL_ID && GUARDRAIL_VERSION),
  });
  const invokeStart = Date.now();

  const response = await client.send(command);
  logger.debug("bedrock_invoke_complete", {
    modelId,
    durationMs: Date.now() - invokeStart,
  });

  const parsed = JSON.parse(Buffer.from(response.body).toString("utf-8")) as {
    content: Array<{ type: string; text: string }>;
  };
  if (!parsed.content?.length || !parsed.content[0]?.text) {
    throw new Error(
      "The content filter blocked this response. Please rephrase the question.",
    );
  }
  return parsed.content[0].text;
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
}

export const converseWithTools = async (
  messages: BedrockMessage[],
  tools: Tool[],
  system: string,
  toolChoice: Record<string, unknown> = { any: {} },
  maxTokens = 4096,
): Promise<ConverseResponse> => {
  const modelId = process.env.BEDROCK_MODEL_ID;
  if (!modelId) {
    throw new Error("BEDROCK_MODEL_ID environment variable is not set");
  }

  const command = new ConverseCommand({
    modelId,
    messages: messages as unknown as Message[],
    system: [{ text: system }],
    inferenceConfig: { maxTokens },
    toolConfig: {
      tools,
      toolChoice: toolChoice as unknown as { any: Record<string, never> },
    },
    ...(GUARDRAIL_ID && GUARDRAIL_VERSION
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
    modelId,
    messageCount: messages.length,
    guardrailEnabled: !!(GUARDRAIL_ID && GUARDRAIL_VERSION),
  });
  const converseStart = Date.now();

  const response = await client.send(command);
  logger.debug("bedrock_converse_complete", {
    modelId,
    durationMs: Date.now() - converseStart,
    stopReason: response.stopReason,
  });
  return {
    stopReason: response.stopReason ?? "end_turn",
    message: response.output!.message! as unknown as BedrockMessage,
  };
};

export type { Tool };
