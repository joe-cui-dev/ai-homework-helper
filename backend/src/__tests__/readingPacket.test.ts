import { generateReadingPackets } from "../readingPacket";
import type { BookContext, ReadingPacket } from "../types";

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

const PAGE = "data:image/jpeg;base64,/9j/page";

const PACKET = (
  id: number,
  questionType: ReadingPacket["questionType"] = "literal",
): ReadingPacket => ({
  questionId: id,
  yearLevel: "year-3",
  questionType,
  questionText: `Question ${id}?`,
  modelAnswer: `Model answer for ${id}.`,
  comprehensionSkill: `Skill for question ${id}.`,
  coachingTip: `Coach the child by doing X for question ${id}.`,
  commonMisreadings: [`Wrong A ${id}`, `Wrong B ${id}`],
  discussionPrompt: `Prompt ${id}.`,
});

const BOOK: BookContext = { title: "The Sample", author: "An Author" };

beforeEach(() => {
  converseWithTools.mockReset();
});

describe("generateReadingPackets", () => {
  it("returns empty when no images provided (no Bedrock call)", async () => {
    const result = await generateReadingPackets([], BOOK, "year-3");
    expect(result.packets).toEqual([]);
    expect(converseWithTools).not.toHaveBeenCalled();
  });

  it("parses packets out of submit_reading_packets tool input", async () => {
    converseWithTools.mockResolvedValueOnce({
      stopReason: "tool_use",
      usage: { inputTokens: 200, outputTokens: 300, costUsd: 0.0015 },
      message: {
        role: "assistant",
        content: [
          {
            toolUse: {
              name: "submit_reading_packets",
              input: {
                packets: [
                  PACKET(1, "literal"),
                  PACKET(2, "literal"),
                  PACKET(3, "inference"),
                  PACKET(4, "inference"),
                  PACKET(5, "vocabulary"),
                ],
              },
            },
          },
        ],
      },
    });

    const result = await generateReadingPackets([PAGE, PAGE], BOOK, "year-3");
    expect(result.packets).toHaveLength(5);
    expect(result.packets.map((p) => p.questionType)).toEqual([
      "literal",
      "literal",
      "inference",
      "inference",
      "vocabulary",
    ]);
    expect(result.packets[0].questionId).toBe(1);
    expect(result.usage.inputTokens).toBe(200);
  });

  it("forces submit_reading_packets via toolChoice", async () => {
    converseWithTools.mockResolvedValueOnce({
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      message: {
        role: "assistant",
        content: [
          {
            toolUse: {
              name: "submit_reading_packets",
              input: { packets: [PACKET(1)] },
            },
          },
        ],
      },
    });

    await generateReadingPackets([PAGE], BOOK, "year-3");

    const [, , , toolChoice] = converseWithTools.mock.calls[0];
    expect(toolChoice).toEqual({ tool: { name: "submit_reading_packets" } });
  });

  it("includes book context, year level, and curriculum outcomes in the user message", async () => {
    converseWithTools.mockResolvedValueOnce({
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      message: {
        role: "assistant",
        content: [
          {
            toolUse: {
              name: "submit_reading_packets",
              input: { packets: [PACKET(1)] },
            },
          },
        ],
      },
    });

    await generateReadingPackets([PAGE], BOOK, "year-4");

    const [messages] = converseWithTools.mock.calls[0];
    const textBlocks = messages[0].content
      .map((b: Record<string, unknown>) => (b.text as string | undefined) ?? "")
      .filter(Boolean)
      .join("\n");
    expect(textBlocks).toContain("The Sample");
    expect(textBlocks).toContain("An Author");
    expect(textBlocks).toContain("year-4");
    expect(textBlocks).toContain("Australian Curriculum");
  });

  it("works even when book context is empty (cover not legible)", async () => {
    converseWithTools.mockResolvedValueOnce({
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      message: {
        role: "assistant",
        content: [
          {
            toolUse: {
              name: "submit_reading_packets",
              input: { packets: [PACKET(1)] },
            },
          },
        ],
      },
    });

    await generateReadingPackets([PAGE], {}, "year-2");

    const [messages] = converseWithTools.mock.calls[0];
    const textBlocks = messages[0].content
      .map((b: Record<string, unknown>) => (b.text as string | undefined) ?? "")
      .filter(Boolean)
      .join("\n");
    expect(textBlocks).toContain("not legible");
  });

  it("throws when guardrail intervenes", async () => {
    converseWithTools.mockResolvedValueOnce({
      stopReason: "guardrail_intervened",
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      message: {
        role: "assistant",
        content: [{ text: "Blocked." }],
      },
    });

    await expect(
      generateReadingPackets([PAGE], BOOK, "year-3"),
    ).rejects.toThrow(/Blocked/);
  });

  it("throws when Claude does not call the tool", async () => {
    converseWithTools.mockResolvedValueOnce({
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      message: { role: "assistant", content: [{ text: "I cannot help." }] },
    });

    await expect(
      generateReadingPackets([PAGE], BOOK, "year-3"),
    ).rejects.toThrow(/could not produce reading questions/);
  });
});
