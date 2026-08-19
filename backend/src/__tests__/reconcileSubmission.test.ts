import { reconcileSubmission } from "../homework/reconcileSubmission";
import type { HomeworkQuestion } from "../shared/session";

const packet = (questionId: number) => ({ questionId, tldrAnswer: "answer", whyItWorks: "why", childHint: "hint" });
const existing = (questionId: number, input: string): HomeworkQuestion => ({
  questionId, input, subject: "math", yearLevel: "year-3", packet: packet(questionId), sourcePageIds: ["page-1"],
});

describe("reconcileSubmission", () => {
  it("keeps a confident continuation's stable id and only marks it updated", () => {
    const prior = existing(4, "Complete the number pattern");
    const result = reconcileSubmission([prior], [{
      text: "Complete the number pattern: 2, 4, 6, __", subject: "math", yearLevel: "year-3", sourcePageIds: ["page-2"], relation: { kind: "update", questionId: 4, confidence: "high" },
    }]);

    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].questionId).toBe(4);
    // The old packet remains available until the incremental generator replaces it.
    expect(result.questions[0].packet).toBe(prior.packet);
    expect(result.updatedQuestionIds).toEqual([4]);
    expect(result.addedQuestionIds).toEqual([]);
  });

  it("preserves uncertain overlaps as new possible duplicates with monotonic ids", () => {
    const result = reconcileSubmission([existing(4, "What is 2 + 2?")], [{
      text: "What is two plus two?", subject: "math", yearLevel: "year-3", sourcePageIds: ["page-2"], relation: { kind: "possible_duplicate", questionId: 4, confidence: "uncertain" },
    }]);

    expect(result.questions[1]).toMatchObject({ questionId: 5, possiblyRepeatedOfQuestionId: 4 });
    expect(result.possiblyRepeatedQuestionIds).toEqual([5]);
  });

  it("rejects a submission rather than truncating when it would exceed 30 questions", () => {
    const questions = Array.from({ length: 30 }, (_, i) => existing(i + 1, `Question ${i + 1}`));
    expect(() => reconcileSubmission(questions, [{ text: "Another", subject: "math", yearLevel: "year-3", sourcePageIds: ["page-2"], relation: { kind: "new", confidence: "high" } }])).toThrow("30-question limit");
  });

  it("rejects model relations that target a question outside the session", () => {
    expect(() => reconcileSubmission([existing(4, "What is 2 + 2?")], [{
      text: "continued text", subject: "math", yearLevel: "year-3", sourcePageIds: ["page-2"], relation: { kind: "update", questionId: 99, confidence: "high" },
    }])).toThrow("unknown question 99");
  });

  it("deduplicates confident overlaps inside one submission before checking the limit", () => {
    const questions = Array.from({ length: 29 }, (_, i) => existing(i + 1, `Question ${i + 1}`));
    const result = reconcileSubmission(questions, [
      { text: "What is 8 x 7?", subject: "math", yearLevel: "year-3", sourcePageIds: ["page-30"], relation: { kind: "new", confidence: "high" } },
      { text: "  what   is 8 X 7? ", subject: "math", yearLevel: "year-3", sourcePageIds: ["page-31"], relation: { kind: "new", confidence: "high" } },
    ]);

    expect(result.questions).toHaveLength(30);
    expect(result.addedQuestionIds).toEqual([30]);
    expect(result.questions[29].sourcePageIds).toEqual(["page-30", "page-31"]);
  });

  it("deduplicates semantic OCR variants carrying the analyzer's overlap key", () => {
    const result = reconcileSubmission([], [
      { overlapKey: "worksheet-q7", text: "7. Find 12 ÷ 3", subject: "math", yearLevel: "year-3", sourcePageIds: ["page-a"], relation: { kind: "new", confidence: "high" } },
      { overlapKey: "worksheet-q7", text: "Q7 Find 12 / 3", subject: "math", yearLevel: "year-3", sourcePageIds: ["page-b"], relation: { kind: "new", confidence: "high" } },
    ]);
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].sourcePageIds).toEqual(["page-a", "page-b"]);
  });

  it("preflights every distinct new question so overflow leaves the inputs untouched", () => {
    const questions = Array.from({ length: 29 }, (_, i) => existing(i + 1, `Question ${i + 1}`));
    const snapshot = JSON.stringify(questions);

    expect(() => reconcileSubmission(questions, [
      { text: "New A", subject: "math", yearLevel: "year-3", sourcePageIds: ["page-30"], relation: { kind: "new", confidence: "high" } },
      { text: "New B", subject: "math", yearLevel: "year-3", sourcePageIds: ["page-31"], relation: { kind: "new", confidence: "high" } },
    ])).toThrow("30-question limit");
    expect(JSON.stringify(questions)).toBe(snapshot);
  });

  it("allocates after sparse ids and preserves unchanged question identity", () => {
    const first = existing(2, "First");
    const second = existing(8, "Second");
    const result = reconcileSubmission([first, second], [{
      text: "Third", subject: "science", yearLevel: "year-4", sourcePageIds: ["page-3"], relation: { kind: "new", confidence: "high" },
    }]);

    expect(result.questions[0]).toBe(first);
    expect(result.questions[1]).toBe(second);
    expect(result.questions[2].questionId).toBe(9);
  });
});
