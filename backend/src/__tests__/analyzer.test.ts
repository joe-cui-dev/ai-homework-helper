import { analyzeHomeworkSubmission, analyzePages } from "../homework/analyzer";

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

describe("analyzeHomeworkSubmission", () => {
  const finalInput = {
    pageContexts: [{ pageId: "new-1", content: "Text with $x^2$, | table |, and a graph description." }],
    candidates: [{
      text: "Continue the graph", subject: "math", yearLevel: "year-4", sourcePageIds: ["old-1", "new-1"],
      relation: { kind: "update", questionId: 7, confidence: "high" },
    }],
    requestedPriorPageIds: [],
  };

  it("analyzes text-only initial questions instead of fabricating classification", async () => {
    converseWithTools.mockResolvedValueOnce({ stopReason: "tool_use", usage: { inputTokens: 8, outputTokens: 3, costUsd: 0.001 }, message: { role: "assistant", content: [{ toolUse: { name: "submit_homework_submission_analysis", input: {
      pageContexts: [], requestedPriorPageIds: [], candidates: [{ text: "Explain photosynthesis", subject: "science", yearLevel: "year-5", sourcePageIds: [], relation: { kind: "new", confidence: "high" } }],
    } } }] } });
    const result = await analyzeHomeworkSubmission({ newPages: [], priorPages: [], existingQuestions: [], questionText: "Explain photosynthesis", modelChoice: "fast", loadPriorImage: jest.fn() });
    expect(converseWithTools).toHaveBeenCalledTimes(1);
    expect(result.candidates[0]).toMatchObject({ subject: "science", yearLevel: "year-5" });
    expect(result.usage.inputTokens).toBe(8);
  });

  it("sends prior semantic context and summaries but no prior image in a normal append", async () => {
    converseWithTools.mockResolvedValueOnce({ stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 }, message: { role: "assistant", content: [{ toolUse: { name: "submit_homework_submission_analysis", input: finalInput } }] } });
    const loadPriorImage = jest.fn();

    const result = await analyzeHomeworkSubmission({
      newPages: [{ pageId: "new-1", image: IMG }],
      priorPages: [{ pageId: "old-1", content: "Earlier graph axes" }],
      existingQuestions: [{ questionId: 7, input: "Graph question", subject: "math", yearLevel: "year-4", sourcePageIds: ["old-1"] }],
      modelChoice: "fast", loadPriorImage,
    });

    expect(result.candidates[0].relation).toMatchObject({ kind: "update", questionId: 7 });
    expect(loadPriorImage).not.toHaveBeenCalled();
    const messages = converseWithTools.mock.calls[0][0] as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages[0].content.filter((block) => "image" in block)).toHaveLength(1);
    expect(JSON.stringify(messages)).toContain("Earlier graph axes");
  });

  it("guards the typed question only, leaving prior Page Context unassessed", async () => {
    converseWithTools.mockResolvedValueOnce({ stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 }, message: { role: "assistant", content: [{ toolUse: { name: "submit_homework_submission_analysis", input: finalInput } }] } });

    await analyzeHomeworkSubmission({
      newPages: [{ pageId: "new-1", image: IMG }],
      priorPages: [{ pageId: "old-1", content: "Earlier graph axes" }],
      existingQuestions: [{ questionId: 7, input: "Graph question", subject: "math", yearLevel: "year-4", sourcePageIds: ["old-1"] }],
      questionText: "Why is question 3 wrong?",
      modelChoice: "fast", loadPriorImage: jest.fn(),
    });

    const content = converseWithTools.mock.calls[0][0][0].content as Array<Record<string, unknown>>;
    const guarded = content.filter((block) => "guardContent" in block);
    // Prior Page Context is worksheet text the parent photographed earlier;
    // assessing it as a request is what blocks legitimate submissions.
    expect(JSON.stringify(guarded)).not.toContain("Earlier graph axes");
    expect(JSON.stringify(guarded)).toContain("Why is question 3 wrong?");
    expect(guarded).toHaveLength(1);
  });

  it("still emits one guarded block when the parent typed nothing", async () => {
    converseWithTools.mockResolvedValueOnce({ stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 }, message: { role: "assistant", content: [{ toolUse: { name: "submit_homework_submission_analysis", input: finalInput } }] } });

    await analyzeHomeworkSubmission({
      newPages: [{ pageId: "new-1", image: IMG }],
      priorPages: [{ pageId: "old-1", content: "Earlier graph axes" }],
      existingQuestions: [{ questionId: 7, input: "Graph question", subject: "math", yearLevel: "year-4", sourcePageIds: ["old-1"] }],
      modelChoice: "fast", loadPriorImage: jest.fn(),
    });

    // Without a guarded block Bedrock reverts to assessing the whole message,
    // prior Page Context included.
    const content = converseWithTools.mock.calls[0][0][0].content as Array<Record<string, unknown>>;
    expect(content.filter((block) => "guardContent" in block)).toHaveLength(1);
  });

  it("loads only requested owned prior images and permits one fallback", async () => {
    converseWithTools
      .mockResolvedValueOnce({ stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 }, message: { role: "assistant", content: [{ toolUse: { name: "submit_homework_submission_analysis", input: { ...finalInput, candidates: [], requestedPriorPageIds: ["old-1"] } } }] } })
      .mockResolvedValueOnce({ stopReason: "tool_use", usage: { inputTokens: 12, outputTokens: 6, costUsd: 0 }, message: { role: "assistant", content: [{ toolUse: { name: "submit_homework_submission_analysis", input: { ...finalInput, pageContexts: [{ pageId: "new-1", content: "incorrectly regenerated" }] } } }] } });
    const loadPriorImage = jest.fn().mockResolvedValue({ mediaType: "image/png", data: new Uint8Array([1, 2]) });

    const result = await analyzeHomeworkSubmission({
      newPages: [{ pageId: "new-1", image: IMG }], priorPages: [{ pageId: "old-1", content: "Earlier graph axes" }],
      existingQuestions: [{ questionId: 7, input: "Graph question", subject: "math", yearLevel: "year-4", sourcePageIds: ["old-1"] }],
      modelChoice: "fast", loadPriorImage,
    });

    expect(loadPriorImage).toHaveBeenCalledWith("old-1");
    expect(converseWithTools).toHaveBeenCalledTimes(2);
    const fallbackMessages = converseWithTools.mock.calls[1][0] as Array<{ content: Array<Record<string, unknown>> }>;
    expect(fallbackMessages[0].content.filter((block) => "image" in block)).toHaveLength(1);
    expect(result.newPageContexts[0].content).toContain("graph description");
  });

  it("rejects foreign fallback ids and a second unresolved fallback request", async () => {
    converseWithTools.mockResolvedValueOnce({ stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, message: { role: "assistant", content: [{ toolUse: { name: "submit_homework_submission_analysis", input: { ...finalInput, candidates: [], requestedPriorPageIds: ["foreign"] } } }] } });
    await expect(analyzeHomeworkSubmission({
      newPages: [{ pageId: "new-1", image: IMG }], priorPages: [{ pageId: "old-1", content: "Earlier" }], existingQuestions: [], modelChoice: "fast", loadPriorImage: jest.fn(),
    })).rejects.toThrow("unknown prior page");

    converseWithTools
      .mockResolvedValueOnce({ stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, message: { role: "assistant", content: [{ toolUse: { name: "submit_homework_submission_analysis", input: { ...finalInput, candidates: [], requestedPriorPageIds: ["old-1"] } } }] } })
      .mockResolvedValueOnce({ stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, message: { role: "assistant", content: [{ toolUse: { name: "submit_homework_submission_analysis", input: { ...finalInput, requestedPriorPageIds: ["old-1"] } } }] } });
    await expect(analyzeHomeworkSubmission({
      newPages: [{ pageId: "new-1", image: IMG }], priorPages: [{ pageId: "old-1", content: "Earlier" }], existingQuestions: [{ questionId: 7, input: "Graph", subject: "math", yearLevel: "year-4", sourcePageIds: ["old-1"] }], modelChoice: "fast", loadPriorImage: jest.fn().mockResolvedValue({ mediaType: "image/png", data: new Uint8Array([1]) }),
    })).rejects.toThrow("one fallback");
  });
});
