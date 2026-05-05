import { generateCoachingPackets } from "../coachingPacket";
import type { IdentifiedQuestion, CoachingPacket } from "../types";

jest.mock("../bedrock", () => ({
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
}));

jest.mock("../logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { converseWithTools } = jest.requireMock("../bedrock") as {
  converseWithTools: jest.Mock;
};

const PACKET = (id: number, subject = "english"): CoachingPacket => ({
  questionId: id,
  subject: subject as CoachingPacket["subject"],
  yearLevel: "year-3",
  tldrAnswer: `Answer for question ${id}.`,
  whyItWorks: `Concept for question ${id}.`,
  howToCoach: `Coach the child by doing X for question ${id}.`,
  watchFor: [`Common mistake A for question ${id}`, `Common mistake B for question ${id}`],
  childHint: `Hint for question ${id}.`,
});

const QUESTIONS: IdentifiedQuestion[] = [
  { id: 1, text: "What are Alex's symptoms?", usesArticle: true, sourcePage: 0 },
  { id: 2, text: "What does Mum think?", usesArticle: true, sourcePage: 0 },
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
