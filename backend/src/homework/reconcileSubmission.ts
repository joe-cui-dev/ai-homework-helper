import type { CoachingPacket, Subject, YearLevel } from "../shared/types";
import type { HomeworkQuestion } from "../shared/session";

export type QuestionRelation =
  | { kind: "new"; confidence: "high" }
  | { kind: "update"; questionId: number; confidence: "high" }
  | { kind: "possible_duplicate"; questionId: number; confidence: "uncertain" };

export interface SubmissionQuestionCandidate {
  /** Same value marks high-confidence semantic overlap within this submission. */
  overlapKey?: string;
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
  const existingIds = new Set(existingQuestions.map((question) => question.questionId));
  for (const candidate of candidates) {
    if (candidate.relation.kind !== "new" && !existingIds.has(candidate.relation.questionId)) {
      throw new Error(`Analyzer related a candidate to unknown question ${candidate.relation.questionId}.`);
    }
  }

  // A model can see the same complete question in overlapping photos. Collapse
  // only confident `new` candidates with identical normalized text; uncertain
  // relationships deliberately stay separate so we never erase ambiguity.
  const normalizedNew = new Map<string, SubmissionQuestionCandidate>();
  const distinctCandidates: SubmissionQuestionCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.relation.kind !== "new") {
      distinctCandidates.push(candidate);
      continue;
    }
    const fingerprint = candidate.overlapKey?.trim()
      ? `model:${candidate.overlapKey.trim()}`
      : `text:${candidate.text.trim().replace(/\s+/g, " ").toLocaleLowerCase()}`;
    const prior = normalizedNew.get(fingerprint);
    if (!prior) {
      const copy = { ...candidate, sourcePageIds: [...new Set(candidate.sourcePageIds)] };
      normalizedNew.set(fingerprint, copy);
      distinctCandidates.push(copy);
    } else {
      prior.sourcePageIds = [...new Set([...prior.sourcePageIds, ...candidate.sourcePageIds])];
    }
  }

  const distinctNewCount = distinctCandidates.filter((candidate) => candidate.relation.kind !== "update").length;
  if (existingQuestions.length + distinctNewCount > 30) {
    throw new Error("This submission would exceed the 30-question limit.");
  }

  const questions: ReconciledHomeworkQuestion[] = [...existingQuestions];
  const byId = new Map(questions.map((question) => [question.questionId, question]));
  const addedQuestionIds: number[] = [];
  const updatedQuestionIds: number[] = [];
  const possiblyRepeatedQuestionIds: number[] = [];
  let nextQuestionId = Math.max(0, ...existingQuestions.map((q) => q.questionId)) + 1;

  for (const candidate of distinctCandidates) {
    if (candidate.relation.kind === "update") {
      const existing = byId.get(candidate.relation.questionId);
      // Targets were validated before any mutation.
      const updated = {
        ...existing!,
        input: candidate.text,
        subject: candidate.subject,
        yearLevel: candidate.yearLevel,
        sourcePageIds: [...new Set([...(existing!.sourcePageIds ?? []), ...candidate.sourcePageIds])],
        revision: (existing!.revision ?? 0) + 1,
      };
      const index = questions.findIndex((q) => q.questionId === existing!.questionId);
      questions[index] = updated;
      byId.set(updated.questionId, updated);
      if (!updatedQuestionIds.includes(updated.questionId)) updatedQuestionIds.push(updated.questionId);
      continue;
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
