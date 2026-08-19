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

const normalizeText = (value: string): string =>
  value.trim().replace(/\s+/g, " ").toLocaleLowerCase();

const normalizeOverlapKey = (value: string): string =>
  normalizeText(value);

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const uniqueSorted = (values: string[]): string[] =>
  [...new Set(values)].sort(compareStrings);

const candidateGroupKey = (candidate: SubmissionQuestionCandidate): string => {
  if (candidate.overlapKey?.trim()) return `overlap:${normalizeOverlapKey(candidate.overlapKey)}`;
  if (candidate.relation.kind === "new") return `new-text:${normalizeText(candidate.text)}`;
  if (candidate.relation.kind === "update") return `update:${candidate.relation.questionId}`;
  return `possible:${candidate.relation.questionId}:${normalizeText(candidate.text)}`;
};

const chooseRepresentative = (
  candidates: SubmissionQuestionCandidate[],
): SubmissionQuestionCandidate => [...candidates].sort((left, right) => {
  const lengthDifference = normalizeText(right.text).length - normalizeText(left.text).length;
  if (lengthDifference !== 0) return lengthDifference;
  const textDifference = compareStrings(normalizeText(left.text), normalizeText(right.text));
  if (textDifference !== 0) return textDifference;
  const subjectDifference = compareStrings(left.subject, right.subject);
  if (subjectDifference !== 0) return subjectDifference;
  return compareStrings(left.yearLevel, right.yearLevel);
})[0];

const reconcileGroup = (
  groupKey: string,
  candidates: SubmissionQuestionCandidate[],
): SubmissionQuestionCandidate => {
  const relatedIds = new Set(candidates.flatMap((candidate) =>
    candidate.relation.kind === "new" ? [] : [candidate.relation.questionId]));
  if (relatedIds.size > 1) {
    throw new Error(`Analyzer produced a contradictory overlap group (${groupKey}).`);
  }

  // A confident update wins over a new/uncertain rendering of the same overlap.
  // Otherwise uncertainty is preserved rather than silently promoted to `new`.
  const updates = candidates.filter((candidate) => candidate.relation.kind === "update");
  const possibleDuplicates = candidates.filter((candidate) => candidate.relation.kind === "possible_duplicate");
  const eligible = updates.length > 0
    ? updates
    : possibleDuplicates.length > 0
      ? possibleDuplicates
      : candidates;
  const representative = chooseRepresentative(eligible);
  return {
    ...representative,
    sourcePageIds: uniqueSorted(candidates.flatMap((candidate) => candidate.sourcePageIds)),
  };
};

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

  // Reconcile every explicit overlap identity as a group. Only genuinely new
  // candidates without an analyzer identity receive the normalized-text fallback.
  const groups = new Map<string, SubmissionQuestionCandidate[]>();
  for (const candidate of candidates) {
    const key = candidateGroupKey(candidate);
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  const distinctCandidates = [...groups.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([key, group]) => reconcileGroup(key, group));

  const updateGroupsByQuestionId = new Map<number, number>();
  for (const candidate of distinctCandidates) {
    if (candidate.relation.kind !== "update") continue;
    const count = (updateGroupsByQuestionId.get(candidate.relation.questionId) ?? 0) + 1;
    updateGroupsByQuestionId.set(candidate.relation.questionId, count);
    if (count > 1) {
      throw new Error(`Analyzer updated question ${candidate.relation.questionId} from more than one overlap group.`);
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
