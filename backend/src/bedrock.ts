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

export async function callClaude(
  prompt: string,
  temperature: number = 0,
): Promise<string> {
  const modelId = process.env.BEDROCK_MODEL_ID;
  if (!modelId) {
    throw new Error("BEDROCK_MODEL_ID environment variable is not set");
  }

  const requestBody = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
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
}

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
): Promise<ConverseResponse> => {
  const modelId = process.env.BEDROCK_MODEL_ID;
  if (!modelId) {
    throw new Error("BEDROCK_MODEL_ID environment variable is not set");
  }

  const command = new ConverseCommand({
    modelId,
    messages: messages as unknown as Message[],
    system: [{ text: system }],
    toolConfig: {
      tools,
      toolChoice: { any: {} },
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
