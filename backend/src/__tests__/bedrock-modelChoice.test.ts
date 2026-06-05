jest.mock("@aws-sdk/client-bedrock-runtime", () => {
  const sendMock = jest.fn();
  return {
    BedrockRuntimeClient: jest.fn(() => ({ send: sendMock })),
    ConverseCommand: jest.fn((input: unknown) => input),
    InvokeModelCommand: jest.fn((input: unknown) => input),
    _sendMock: sendMock,
  };
});

jest.mock("../shared/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const bedrockMock = jest.requireMock("@aws-sdk/client-bedrock-runtime") as {
  _sendMock: jest.Mock;
};

describe("Bedrock wrappers model choice", () => {
  beforeEach(() => {
    bedrockMock._sendMock.mockReset();
  });

  it("routes InvokeModel calls through the selected model registry entry", async () => {
    const { callClaude } = await import("../shared/bedrock");
    bedrockMock._sendMock.mockResolvedValueOnce({
      body: JSON.stringify({
        content: [{ type: "text", text: "{}" }],
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      }),
    });

    const result = await callClaude({
      prompt: "Return JSON.",
      temperature: 0,
      modelChoice: "advanced",
    });

    expect(bedrockMock._sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "au.anthropic.claude-sonnet-4-6",
      }),
    );
    expect(result.usage.costUsd).toBe(18);
  });

  it("routes Converse calls through the selected model registry entry", async () => {
    const { converseWithTools } = await import("../shared/bedrock");
    bedrockMock._sendMock.mockResolvedValueOnce({
      stopReason: "end_turn",
      output: { message: { role: "assistant", content: [{ text: "{}" }] } },
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    });

    const result = await converseWithTools({
      messages: [{ role: "user", content: [{ text: "hello" }] }],
      tools: [],
      system: "system",
      modelChoice: "advanced",
    });

    expect(bedrockMock._sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "au.anthropic.claude-sonnet-4-6",
      }),
    );
    expect(result.usage.costUsd).toBe(18);
  });
});
