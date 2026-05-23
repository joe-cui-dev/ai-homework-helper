import { analyzePages } from "../homework/analyzer";

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

const IMG = "data:image/jpeg;base64,/9j/abc";

beforeEach(() => {
  converseWithTools.mockReset();
});

describe("analyzePages", () => {
  it("returns subject and yearLevel on each identified question", async () => {
    converseWithTools.mockResolvedValueOnce({
      stopReason: "tool_use",
      usage: { inputTokens: 100, outputTokens: 50, costUsd: 0 },
      message: {
        role: "assistant",
        content: [
          {
            toolUse: {
              name: "submit_page_analysis",
              input: {
                questions: [
                  {
                    id: 1,
                    text: "What is 2 + 2?",
                    usesArticle: false,
                    sourcePage: 0,
                    subject: "math",
                    yearLevel: "year-1",
                  },
                  {
                    id: 2,
                    text: "Name the parts of a plant.",
                    usesArticle: false,
                    sourcePage: 0,
                    subject: "science",
                    yearLevel: "year-3",
                  },
                ],
              },
            },
          },
        ],
      },
    });

    const result = await analyzePages([IMG]);

    expect(result.analysis.questions).toHaveLength(2);
    expect(result.analysis.questions[0].subject).toBe("math");
    expect(result.analysis.questions[0].yearLevel).toBe("year-1");
    expect(result.analysis.questions[1].subject).toBe("science");
    expect(result.analysis.questions[1].yearLevel).toBe("year-3");
  });
});
