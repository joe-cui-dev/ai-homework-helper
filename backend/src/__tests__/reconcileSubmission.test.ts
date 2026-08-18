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
});
