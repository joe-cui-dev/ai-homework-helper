import type { BedrockMessage, RawTokenUsage, Tool } from "../shared/bedrock";
import { converseWithTools, parseToolInput } from "../shared/bedrock";
import type { ModelChoice } from "../shared/modelChoice";

interface ForcedHomeworkToolInput {
  messages: BedrockMessage[];
  tool: Tool;
  toolName: string;
  systemPrompt: string;
  modelChoice: ModelChoice;
  missingToolMessage: string;
}

/** Shared forced-tool mechanics for Homework model calls. Prompts and schemas stay explicit at callers. */
export const runForcedHomeworkTool = async <T>(
  input: ForcedHomeworkToolInput,
): Promise<{ input: T; usage: RawTokenUsage }> => {
  const response = await converseWithTools(
    input.messages,
    [input.tool],
    input.systemPrompt,
    { tool: { name: input.toolName } },
    8192,
    true,
    input.modelChoice,
  );
  if (response.stopReason === "guardrail_intervened") {
    const message = (response.message.content ?? [])
      .map((block) => (block as { text?: string }).text)
      .filter(Boolean)
      .join(" ") || "Your submission was blocked by the content filter. Please rephrase it.";
    throw new Error(message);
  }
  for (const block of response.message.content ?? []) {
    const toolUse = block.toolUse as { name: string; input: unknown } | undefined;
    if (toolUse?.name === input.toolName) {
      return { input: parseToolInput<T>(toolUse.input), usage: response.usage };
    }
  }
  throw new Error(input.missingToolMessage);
};
