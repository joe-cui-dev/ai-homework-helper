import type { CoachingPacket, Subject, YearLevel } from "../shared/types";
import type { HomeworkQuestion } from "../shared/session";

export type QuestionRelation =
  | { kind: "new"; confidence: "high" }
  | { kind: "update"; questionId: number; confidence: "high" }
  | { kind: "possible_duplicate"; questionId: number; confidence: "uncertain" };

export interface SubmissionQuestionCandidate {
  text: string;
  subject: Subject;
  yearLevel: YearLevel;
  sourcePageIds: string[];
  relation: QuestionRelation;
}

export type ReconciledHomeworkQuestion = Omit<HomeworkQuestion, "packet"> & {
  packet?: CoachingPacket;
};

export interface ReconciliationResult {
  questions: ReconciledHomeworkQuestion[];
  addedQuestionIds: number[];
  updatedQuestionIds: number[];
  possiblyRepeatedQuestionIds: number[];
}

/** Applies model-proposed identity only when it is an explicit high-confidence match. */
export const reconcileSubmission = (
  existingQuestions: HomeworkQuestion[],
  candidates: SubmissionQuestionCandidate[],
): ReconciliationResult => {
  const questions: ReconciledHomeworkQuestion[] = [...existingQuestions];
  const byId = new Map(questions.map((question) => [question.questionId, question]));
  const addedQuestionIds: number[] = [];
  const updatedQuestionIds: number[] = [];
  const possiblyRepeatedQuestionIds: number[] = [];
  let nextQuestionId = Math.max(0, ...existingQuestions.map((q) => q.questionId)) + 1;

  for (const candidate of candidates) {
    if (candidate.relation.kind === "update") {
      const existing = byId.get(candidate.relation.questionId);
      if (existing) {
        const updated = {
          ...existing,
          input: candidate.text,
          subject: candidate.subject,
          yearLevel: candidate.yearLevel,
          sourcePageIds: [...new Set([...(existing.sourcePageIds ?? []), ...candidate.sourcePageIds])],
          revision: (existing.revision ?? 0) + 1,
        };
        const index = questions.findIndex((q) => q.questionId === existing.questionId);
        questions[index] = updated;
        byId.set(updated.questionId, updated);
        updatedQuestionIds.push(updated.questionId);
        continue;
      }
    }

    if (questions.length >= 30) {
      throw new Error("This submission would exceed the 30-question limit.");
    }
    const question: ReconciledHomeworkQuestion = {
      questionId: nextQuestionId++,
      input: candidate.text,
      subject: candidate.subject,
      yearLevel: candidate.yearLevel,
      sourcePageIds: candidate.sourcePageIds,
      ...(candidate.relation.kind === "possible_duplicate"
        ? { possiblyRepeatedOfQuestionId: candidate.relation.questionId }
        : {}),
    };
    questions.push(question);
    byId.set(question.questionId, question);
    addedQuestionIds.push(question.questionId);
    if (question.possiblyRepeatedOfQuestionId !== undefined) {
      possiblyRepeatedQuestionIds.push(question.questionId);
    }
  }

  return { questions, addedQuestionIds, updatedQuestionIds, possiblyRepeatedQuestionIds };
};
