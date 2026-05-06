import { analyzeBook } from "../bookAnalyzer";

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

const COVER = "data:image/jpeg;base64,/9j/cover";
const PAGE = "data:image/jpeg;base64,/9j/page";

beforeEach(() => {
  converseWithTools.mockReset();
});

describe("analyzeBook", () => {
  it("returns insufficient sentinel when no images are provided (no Bedrock call)", async () => {
    const result = await analyzeBook([]);
    expect(result.analysis.pagesAreSufficient).toBe(false);
    expect(result.analysis.insufficientReason).toMatch(/upload/i);
    expect(converseWithTools).not.toHaveBeenCalled();
  });

  it("returns the analysis when Bedrock judges pages sufficient", async () => {
    converseWithTools.mockResolvedValueOnce({
      stopReason: "tool_use",
      usage: { inputTokens: 50, outputTokens: 30, costUsd: 0.0002 },
      message: {
        role: "assistant",
        content: [
          {
            toolUse: {
              name: "submit_book_analysis",
              input: {
                bookContext: { title: "The Very Hungry Caterpillar", author: "Eric Carle" },
                yearLevel: "year-1",
                pagesAreSufficient: true,
              },
            },
          },
        ],
      },
    });

    const result = await analyzeBook([COVER, PAGE, PAGE]);
    expect(result.analysis.pagesAreSufficient).toBe(true);
    expect(result.analysis.bookContext.title).toBe("The Very Hungry Caterpillar");
    expect(result.analysis.yearLevel).toBe("year-1");
  });

  it("surfaces insufficientReason when Bedrock judges pages insufficient", async () => {
    converseWithTools.mockResolvedValueOnce({
      stopReason: "tool_use",
      usage: { inputTokens: 40, outputTokens: 20, costUsd: 0.0001 },
      message: {
        role: "assistant",
        content: [
          {
            toolUse: {
              name: "submit_book_analysis",
              input: {
                bookContext: {},
                yearLevel: "year-3",
                pagesAreSufficient: false,
                insufficientReason:
                  "Please upload 3–5 pages from the middle of the book showing the story text.",
              },
            },
          },
        ],
      },
    });

    const result = await analyzeBook([COVER]);
    expect(result.analysis.pagesAreSufficient).toBe(false);
    expect(result.analysis.insufficientReason).toContain("middle of the book");
  });

  it("forces submit_book_analysis via toolChoice", async () => {
    converseWithTools.mockResolvedValueOnce({
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      message: {
        role: "assistant",
        content: [
          {
            toolUse: {
              name: "submit_book_analysis",
              input: {
                bookContext: {},
                yearLevel: "year-2",
                pagesAreSufficient: true,
              },
            },
          },
        ],
      },
    });

    await analyzeBook([COVER, PAGE]);

    const [, , , toolChoice] = converseWithTools.mock.calls[0];
    expect(toolChoice).toEqual({ tool: { name: "submit_book_analysis" } });
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

    await expect(analyzeBook([COVER])).rejects.toThrow(/Blocked by content filter/);
  });

  it("throws when Claude does not call the tool", async () => {
    converseWithTools.mockResolvedValueOnce({
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      message: {
        role: "assistant",
        content: [{ text: "I cannot help." }],
      },
    });

    await expect(analyzeBook([COVER])).rejects.toThrow(
      /could not analyse this upload/,
    );
  });
});
