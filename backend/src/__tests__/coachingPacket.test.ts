import { generateCoachingPackets, generateCoachingPacketsFromContext } from "../homework/coachingPacket";
import type { IdentifiedQuestion, CoachingPacket } from "../shared/types";

jest.mock("../shared/bedrock", () => ({
  converseWithTools: jest.fn(),
  parseDataUrl: (url: string) => {
    const match = url.match(/^data:(image\/(?:jpeg|png));base64,(.+)$/);
    return { mediaType: match![1], base64Data: match![2] };
  },
  buildUsage: (i: number, o: number) => ({
    inputTokens: i,
    outputTokens: o,
    costUsd: 0,
  }),
  parseToolInput: <T,>(raw: unknown): T => raw as T,
  sumUsage: (...usages: Array<{ inputTokens: number; outputTokens: number; costUsd: number }>) => ({
    inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
    outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
    costUsd: usages.reduce((sum, usage) => sum + usage.costUsd, 0),
  }),
}));

jest.mock("../shared/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { converseWithTools } = jest.requireMock("../shared/bedrock") as {
  converseWithTools: jest.Mock;
};

const PACKET = (id: number): CoachingPacket => ({
  questionId: id,
  tldrAnswer: `Answer for question ${id}.`,
  whyItWorks: `Concept for question ${id}.`,
  childHint: `Hint for question ${id}.`,
});

describe("generateCoachingPacketsFromContext", () => {
  const contextQuestions = [
    { questionId: 4, input: "Use the graph", subject: "math" as const, yearLevel: "year-4" as const, sourcePageIds: ["page-a"] },
    { questionId: 9, input: "Read the table", subject: "science" as const, yearLevel: "year-4" as const, sourcePageIds: ["page-b"] },
  ];
  const contexts = [
    { pageId: "page-a", content: "GRAPH CONTEXT" },
    { pageId: "page-b", content: "TABLE CONTEXT" },
    { pageId: "page-c", content: "UNRELATED CONTEXT" },
  ];

  it("groups calls by the exact relevant Page Context set", async () => {
    converseWithTools
      .mockResolvedValueOnce({ stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, message: { role: "assistant", content: [{ toolUse: { name: "submit_coaching_packets", input: { packets: [PACKET(4)] } } }] } })
      .mockResolvedValueOnce({ stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, message: { role: "assistant", content: [{ toolUse: { name: "submit_coaching_packets", input: { packets: [PACKET(9)] } } }] } });

    const result = await generateCoachingPacketsFromContext(contextQuestions, contexts, "fast");

    expect(result.packets.map((packet) => packet.questionId)).toEqual([4, 9]);
    const firstPrompt = JSON.stringify(converseWithTools.mock.calls[0][0]);
    const secondPrompt = JSON.stringify(converseWithTools.mock.calls[1][0]);
    expect(firstPrompt).toContain("GRAPH CONTEXT");
    expect(firstPrompt).not.toContain("TABLE CONTEXT");
    expect(firstPrompt).not.toContain("UNRELATED CONTEXT");
    expect(secondPrompt).toContain("TABLE CONTEXT");
  });

  it("fails the whole generation when output is missing or duplicated", async () => {
    converseWithTools.mockResolvedValueOnce({ stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, message: { role: "assistant", content: [{ toolUse: { name: "submit_coaching_packets", input: { packets: [] } } }] } });
    await expect(generateCoachingPacketsFromContext([contextQuestions[0]], contexts, "fast")).rejects.toThrow("exactly one");

    converseWithTools.mockResolvedValueOnce({ stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, message: { role: "assistant", content: [{ toolUse: { name: "submit_coaching_packets", input: { packets: [PACKET(4), PACKET(4)] } } }] } });
    await expect(generateCoachingPacketsFromContext([contextQuestions[0]], contexts, "fast")).rejects.toThrow("exactly one");
  });
});

const QUESTIONS: IdentifiedQuestion[] = [
  {
    id: 1,
    text: "What are Alex's symptoms?",
    usesArticle: true,
    sourcePage: 0,
    subject: "english",
    yearLevel: "year-3",
  },
  {
    id: 2,
    text: "What does Mum think?",
    usesArticle: true,
    sourcePage: 0,
    subject: "english",
    yearLevel: "year-3",
  },
];

const IMG = "data:image/jpeg;base64,/9j/abc";

beforeEach(() => {
  converseWithTools.mockReset();
});

describe("generateCoachingPackets", () => {
  it("returns empty array when no questions provided", async () => {
    const result = await generateCoachingPackets([IMG], [], "article");
    expect(result.packets).toEqual([]);
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    expect(converseWithTools).not.toHaveBeenCalled();
  });

  it("parses packets out of the submit_coaching_packets tool input", async () => {
    converseWithTools.mockResolvedValueOnce({
      stopReason: "tool_use",
      usage: { inputTokens: 100, outputTokens: 200, costUsd: 0.0011 },
      message: {
        role: "assistant",
        content: [
          {
            toolUse: {
              toolUseId: "t1",
              name: "submit_coaching_packets",
              input: { packets: [PACKET(1), PACKET(2)] },
            },
          },
        ],
      },
    });

    const result = await generateCoachingPackets([IMG], QUESTIONS, "Article body");

    expect(result.packets).toHaveLength(2);
    expect(result.packets[0].questionId).toBe(1);
    expect(result.packets[1].questionId).toBe(2);
    expect(result.packets[0].whyItWorks).toContain("Concept for question 1");
    expect(result.usage.inputTokens).toBeGreaterThanOrEqual(0);
  });

  it("forces submit_coaching_packets via toolChoice", async () => {
    converseWithTools.mockResolvedValueOnce({
      stopReason: "tool_use",
      usage: { inputTokens: 100, outputTokens: 200, costUsd: 0.0011 },
      message: {
        role: "assistant",
        content: [
          {
            toolUse: {
              toolUseId: "t1",
              name: "submit_coaching_packets",
              input: { packets: [PACKET(1)] },
            },
          },
        ],
      },
    });

    await generateCoachingPackets(
      [IMG],
      [QUESTIONS[0]],
      "Article body",
    );

    const [, , , toolChoice] = converseWithTools.mock.calls[0];
    expect(toolChoice).toEqual({ tool: { name: "submit_coaching_packets" } });
  });

  it("includes the article text and per-question id list in the user message", async () => {
    converseWithTools.mockResolvedValueOnce({
      stopReason: "tool_use",
      usage: { inputTokens: 100, outputTokens: 200, costUsd: 0.0011 },
      message: {
        role: "assistant",
        content: [
          {
            toolUse: {
              name: "submit_coaching_packets",
              input: { packets: [PACKET(1), PACKET(2)] },
            },
          },
        ],
      },
    });

    await generateCoachingPackets([IMG], QUESTIONS, "READING PASSAGE BODY");

    const [messages] = converseWithTools.mock.calls[0];
    const userMessage = messages[0];
    const textBlocks = userMessage.content
      .map((b: Record<string, unknown>) => (b.text as string | undefined) ?? "")
      .filter(Boolean)
      .join("\n");
    expect(textBlocks).toContain("READING PASSAGE BODY");
    expect(textBlocks).toContain("[questionId=1");
    expect(textBlocks).toContain("[questionId=2");
    expect(textBlocks).toContain("What are Alex's symptoms?");
    // subject and yearLevel live on IdentifiedQuestion now; the coaching
    // call must pass them to the model so it can calibrate childHint and
    // shape whyItWorks without re-classifying.
    expect(textBlocks).toContain("subject=english");
    expect(textBlocks).toContain("yearLevel=year-3");
  });

  it("throws when guardrail intervenes, surfacing the message", async () => {
    converseWithTools.mockResolvedValueOnce({
      stopReason: "guardrail_intervened",
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      message: {
        role: "assistant",
        content: [{ text: "Blocked by content filter." }],
      },
    });

    await expect(
      generateCoachingPackets([IMG], QUESTIONS, undefined),
    ).rejects.toThrow(/Blocked by content filter/);
  });

  it("throws when Claude does not call the tool", async () => {
    converseWithTools.mockResolvedValueOnce({
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      message: {
        role: "assistant",
        content: [{ text: "I cannot answer." }],
      },
    });

    await expect(
      generateCoachingPackets([IMG], QUESTIONS, undefined),
    ).rejects.toThrow(/could not produce a coaching packet/);
  });
});
