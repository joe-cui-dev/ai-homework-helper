import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendHomeworkPages, streamHomework } from "./homeworkApi";

describe("homework API request contracts", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_HOMEWORK_API_URL", "https://example.test/homework");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      type: "complete", sessionId: "session-1", packets: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, modelChoice: "fast",
      pageCount: 1, questionCount: 0, updatedQuestionIds: [],
      possiblyRepeatedQuestionIds: [], hasNoCompleteQuestions: true,
    }) + "\n", { status: 200 })));
  });

  it("sends an explicit initial discriminator", async () => {
    await streamHomework("Question", "token", vi.fn(), [], undefined, "advanced");
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      kind: "initial", question: "Question", images: null, modelChoice: "advanced",
    });
  });

  it("never sends a model choice with append", async () => {
    await appendHomeworkPages("session-1", "submission-1", ["image"], "token", vi.fn());
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      kind: "append_pages", sessionId: "session-1", submissionId: "submission-1", images: ["image"],
    });
  });
});
