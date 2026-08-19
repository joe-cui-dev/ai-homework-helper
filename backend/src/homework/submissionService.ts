import { createHash, randomUUID } from "crypto";
import { sumUsage } from "../shared/bedrock";
import type { ModelChoice } from "../shared/modelChoice";
import { logger } from "../shared/logger";
import type { HomeworkPageSubmissionRecord, HomeworkQuestion, HomeworkSession, Session } from "../shared/session";
import {
  acquireHomeworkSubmissionClaim,
  loadSessionImage,
  loadSessionWithVersion,
  saveSession,
  saveSessionIfVersion,
  updateHomeworkSubmissionClaim,
  uploadHomeworkSubmissionImages,
  uploadSessionImages,
  type AcquireHomeworkSubmissionClaimResult,
  type HomeworkSubmissionClaim,
  type SessionWithVersion,
  type StoredImage,
} from "../shared/sessionStore";
import type { StreamEvent } from "../shared/types";
import { analyzeHomeworkSubmission, type HomeworkSubmissionAnalysisResult } from "./analyzer";
import { generateCoachingPacketsFromContext, type ContextPacketQuestion, type IdentifiedPageContext } from "./coachingPacket";
import { reconcileSubmission } from "./reconcileSubmission";

export type InitialHomeworkRequest = {
  kind: "initial";
  question: string;
  images: string[];
  modelChoice: ModelChoice;
};

export type AppendHomeworkPagesRequest = {
  kind: "append_pages";
  sessionId: string;
  submissionId: string;
  images: string[];
};

export type HomeworkSubmissionRequest = InitialHomeworkRequest | AppendHomeworkPagesRequest;
export type HomeworkCompleteEvent = Extract<StreamEvent, { type: "complete" }>;

export class HomeworkSubmissionError extends Error {
  constructor(
    message: string,
    public readonly code: Extract<StreamEvent, { type: "error" }>["code"],
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "HomeworkSubmissionError";
  }
}

export interface HomeworkSubmissionDependencies {
  loadSessionWithVersion(studentId: string, sessionType: "homework", sessionId: string): Promise<SessionWithVersion | null>;
  saveSession(session: Session): Promise<void>;
  saveSessionIfVersion(session: Session, eTag: string | undefined): Promise<void>;
  acquireClaim(input: {
    studentId: string; sessionId: string; submissionId: string; payloadHash: string;
    ownerAttemptId: string; now: string; leaseExpiresAt: string;
  }): Promise<AcquireHomeworkSubmissionClaimResult>;
  updateClaim(input: { studentId: string; sessionId: string; submissionId: string; claim: HomeworkSubmissionClaim; eTag: string | undefined }): Promise<string | undefined>;
  analyze(input: Parameters<typeof analyzeHomeworkSubmission>[0]): Promise<HomeworkSubmissionAnalysisResult>;
  generatePackets(questions: ContextPacketQuestion[], contexts: IdentifiedPageContext[], modelChoice: ModelChoice): ReturnType<typeof generateCoachingPacketsFromContext>;
  uploadInitialImages(studentId: string, sessionId: string, images: string[]): Promise<string[]>;
  uploadAppendImages(studentId: string, sessionId: string, submissionId: string, images: string[]): Promise<string[]>;
  loadImage(imageKey: string): Promise<StoredImage>;
  now(): Date;
  id(): string;
  hashImages(images: string[]): string;
}

const defaultDependencies: HomeworkSubmissionDependencies = {
  loadSessionWithVersion,
  saveSession,
  saveSessionIfVersion,
  acquireClaim: acquireHomeworkSubmissionClaim,
  updateClaim: updateHomeworkSubmissionClaim,
  analyze: analyzeHomeworkSubmission,
  generatePackets: generateCoachingPacketsFromContext,
  uploadInitialImages: (studentId, sessionId, images) => uploadSessionImages(studentId, "homework", sessionId, images),
  uploadAppendImages: uploadHomeworkSubmissionImages,
  loadImage: loadSessionImage,
  now: () => new Date(),
  id: randomUUID,
  hashImages: (images) => createHash("sha256").update(images.join("\n")).digest("hex"),
};

const completeEvent = (
  session: HomeworkSession,
  updatedQuestionIds: number[] = [],
  possiblyRepeatedQuestionIds: number[] = [],
): HomeworkCompleteEvent => ({
  type: "complete",
  sessionId: session.sessionId,
  packets: session.questions.map((question) => ({
    questionId: question.questionId,
    questionText: question.input,
    subject: question.subject,
    yearLevel: question.yearLevel,
    packet: question.packet,
  })),
  usage: session.usage,
  modelChoice: session.modelChoice,
  pageCount: session.pages?.length ?? session.imageKeys?.length ?? 0,
  questionCount: session.questions.length,
  updatedQuestionIds,
  possiblyRepeatedQuestionIds,
  hasNoCompleteQuestions: session.questions.length === 0,
});

const replayCommitted = (
  session: HomeworkSession,
  submission: HomeworkPageSubmissionRecord,
  payloadHash: string,
): HomeworkCompleteEvent => {
  if (submission.payloadHash !== payloadHash) {
    throw new HomeworkSubmissionError("This submission ID belongs to different pages.", "validation");
  }
  return completeEvent(session, submission.updatedQuestionIds, submission.possiblyRepeatedQuestionIds);
};

const joinPackets = (
  questions: Array<Omit<HomeworkQuestion, "packet"> & { packet?: HomeworkQuestion["packet"] }>,
  changedIds: Set<number>,
  packets: HomeworkQuestion["packet"][],
): HomeworkQuestion[] => {
  const packetById = new Map<number, HomeworkQuestion["packet"]>();
  for (const packet of packets) {
    if (packetById.has(packet.questionId)) throw new Error("The tutor returned a duplicate coaching packet.");
    packetById.set(packet.questionId, packet);
  }
  if ([...changedIds].some((id) => !packetById.has(id))) {
    throw new Error("The tutor did not return every changed coaching packet.");
  }
  return questions.map((question) => {
    const nextPacket = changedIds.has(question.questionId) ? packetById.get(question.questionId) : question.packet;
    if (!nextPacket) throw new Error(`Question ${question.questionId} has no coaching packet.`);
    return { ...question, packet: nextPacket };
  });
};

const reconcileWithLimitCode = (
  existingQuestions: HomeworkQuestion[],
  candidates: Parameters<typeof reconcileSubmission>[1],
) => {
  try {
    return reconcileSubmission(existingQuestions, candidates);
  } catch (error) {
    if (error instanceof Error && error.message.includes("30-question limit")) {
      throw new HomeworkSubmissionError(error.message, "question_limit");
    }
    throw error;
  }
};

const runInitial = async (
  studentId: string,
  request: InitialHomeworkRequest,
  emit: (event: StreamEvent) => void,
  deps: HomeworkSubmissionDependencies,
): Promise<HomeworkCompleteEvent> => {
  const sessionId = deps.id();
  const pageIds = request.images.map((_, index) => `initial-page-${index}`);
  emit({ type: "analyzing" });
  const analysis = await deps.analyze({
    newPages: request.images.map((image, index) => ({ pageId: pageIds[index], image })),
    priorPages: [], existingQuestions: [], questionText: request.question,
    modelChoice: request.modelChoice, loadPriorImage: async () => { throw new Error("Initial submissions have no prior pages."); },
  });
  const reconciliation = reconcileWithLimitCode([], analysis.candidates);
  for (const question of reconciliation.questions) {
    emit({ type: "packet_start", sessionId, questionId: question.questionId, total: reconciliation.questions.length, text: question.input });
  }
  const contexts = analysis.newPageContexts;
  const packetResult = await deps.generatePackets(
    reconciliation.questions.map((question) => ({ questionId: question.questionId, input: question.input, subject: question.subject, yearLevel: question.yearLevel, sourcePageIds: question.sourcePageIds })),
    contexts,
    request.modelChoice,
  );
  const changedIds = new Set(reconciliation.addedQuestionIds);
  const questions = joinPackets(reconciliation.questions, changedIds, packetResult.packets);
  const imageKeys = await deps.uploadInitialImages(studentId, sessionId, request.images);
  if (imageKeys.length !== contexts.length) throw new Error("Every Page Context must have a durable image.");
  const now = deps.now().toISOString();
  const contextByPageId = new Map(contexts.map((context) => [context.pageId, context.content]));
  const session: HomeworkSession = {
    sessionType: "homework", sessionId, studentId, modelChoice: request.modelChoice,
    timestamp: now, updatedAt: now, usage: sumUsage(analysis.usage, packetResult.usage),
    pages: imageKeys.map((imageKey, index) => ({ pageId: pageIds[index], imageKey, context: { content: contextByPageId.get(pageIds[index])! } })),
    questions, submissions: [],
  };
  await deps.saveSession(session);
  logger.info("homework_initial_complete", {
    sessionId,
    pageCount: session.pages?.length ?? 0,
    questionCount: session.questions.length,
    inputTokens: session.usage.inputTokens,
    outputTokens: session.usage.outputTokens,
    costUsd: session.usage.costUsd,
  });
  for (const question of questions) emit({ type: "packet_complete", questionId: question.questionId, subject: question.subject, yearLevel: question.yearLevel, packet: question.packet });
  const event = completeEvent(session);
  emit(event);
  return event;
};

const runAppend = async (
  studentId: string,
  request: AppendHomeworkPagesRequest,
  emit: (event: StreamEvent) => void,
  deps: HomeworkSubmissionDependencies,
): Promise<HomeworkCompleteEvent> => {
  const loaded = await deps.loadSessionWithVersion(studentId, "homework", request.sessionId);
  if (!loaded || loaded.session.sessionType !== "homework") throw new HomeworkSubmissionError("This homework session is no longer available.", "not_found");
  const session = loaded.session;
  const payloadHash = deps.hashImages(request.images);
  const established = session.submissions?.find((submission) => submission.submissionId === request.submissionId);
  if (established) {
    const event = replayCommitted(session, established, payloadHash);
    logger.info("homework_submission_replay", { sessionId: session.sessionId, submissionId: request.submissionId });
    emit(event);
    return event;
  }
  if (!session.pages) throw new HomeworkSubmissionError("Older homework sessions cannot accept more pages.", "validation");
  if (session.pages.length + request.images.length > 10) throw new HomeworkSubmissionError("A homework session can contain at most 10 pages.", "page_limit");
  if (session.questions.length >= 30) throw new HomeworkSubmissionError("This homework session has reached its 30-question limit.", "question_limit");

  const startedAt = deps.now();
  const ownerAttemptId = deps.id();
  emit({ type: "append_phase", phase: "preparing" });
  const claimResult = await deps.acquireClaim({
    studentId, sessionId: session.sessionId, submissionId: request.submissionId, payloadHash, ownerAttemptId,
    now: startedAt.toISOString(), leaseExpiresAt: new Date(startedAt.getTime() + 6 * 60_000).toISOString(),
  });
  if (claimResult.kind === "payload_mismatch") throw new HomeworkSubmissionError("This submission ID belongs to different pages.", "validation");
  if (claimResult.kind !== "acquired") throw new HomeworkSubmissionError("This page submission is still processing. Retry shortly.", "in_progress", true);

  const claim = claimResult.claim;
  const claimETag = claimResult.eTag;
  let committed = false;
  try {
    const pageIds = request.images.map((_, index) => `submission-${request.submissionId}-page-${index}`);
    const pageById = new Map(session.pages.map((page) => [page.pageId, page]));
    emit({ type: "append_phase", phase: "analyzing" });
    const analysis = await deps.analyze({
      newPages: request.images.map((image, index) => ({ pageId: pageIds[index], image })),
      priorPages: session.pages.map((page) => ({ pageId: page.pageId, content: page.context.content })),
      existingQuestions: session.questions.map(({ questionId, input, subject, yearLevel, sourcePageIds }) => ({ questionId, input, subject, yearLevel, sourcePageIds })),
      modelChoice: session.modelChoice,
      loadPriorImage: async (pageId) => {
        const page = pageById.get(pageId);
        if (!page) throw new Error(`Analyzer requested unknown prior page ${pageId}.`);
        return deps.loadImage(page.imageKey);
      },
    });
    logger.info("homework_append_analyzed", {
      sessionId: session.sessionId,
      submissionId: request.submissionId,
      candidateCount: analysis.candidates.length,
      fallbackPageCount: analysis.fallbackPageIds.length,
      inputTokens: analysis.usage.inputTokens,
      outputTokens: analysis.usage.outputTokens,
    });
    const reconciliation = reconcileWithLimitCode(session.questions, analysis.candidates);
    const changedIds = new Set([...reconciliation.addedQuestionIds, ...reconciliation.updatedQuestionIds]);
    const changedQuestions = reconciliation.questions.filter((question) => changedIds.has(question.questionId));
    const contexts = [
      ...session.pages.map((page) => ({ pageId: page.pageId, content: page.context.content })),
      ...analysis.newPageContexts,
    ];
    emit({ type: "append_phase", phase: "generating" });
    const packetResult = await deps.generatePackets(changedQuestions.map((question) => ({
      questionId: question.questionId, input: question.input, subject: question.subject,
      yearLevel: question.yearLevel, sourcePageIds: question.sourcePageIds,
    })), contexts, session.modelChoice);
    const questions = joinPackets(reconciliation.questions, changedIds, packetResult.packets);
    emit({ type: "append_phase", phase: "saving" });
    const imageKeys = await deps.uploadAppendImages(studentId, session.sessionId, request.submissionId, request.images);
    if (imageKeys.length !== analysis.newPageContexts.length) throw new Error("Every Page Context must have a durable image.");
    const now = deps.now().toISOString();
    const submissionUsage = sumUsage(analysis.usage, packetResult.usage);
    const submission: HomeworkPageSubmissionRecord = {
      submissionId: request.submissionId, payloadHash, timestamp: now, pageIds,
      addedQuestionIds: reconciliation.addedQuestionIds, updatedQuestionIds: reconciliation.updatedQuestionIds,
      possiblyRepeatedQuestionIds: reconciliation.possiblyRepeatedQuestionIds, usage: submissionUsage,
    };
    const newContextByPageId = new Map(analysis.newPageContexts.map((context) => [context.pageId, context.content]));
    const next: HomeworkSession = {
      ...session, updatedAt: now, usage: sumUsage(session.usage, submissionUsage), questions,
      pages: [...session.pages, ...imageKeys.map((imageKey, index) => ({ pageId: pageIds[index], imageKey, context: { content: newContextByPageId.get(pageIds[index])! } }))],
      submissions: [...(session.submissions ?? []), submission],
    };
    try {
      await deps.saveSessionIfVersion(next, loaded.eTag);
      committed = true;
    } catch (error) {
      if ((error as { code?: string }).code !== "conflict") throw error;
      logger.warn("homework_append_commit_conflict", { sessionId: session.sessionId, submissionId: request.submissionId });
      const reloaded = await deps.loadSessionWithVersion(studentId, "homework", request.sessionId);
      if (reloaded?.session.sessionType === "homework") {
        const winner = reloaded.session.submissions?.find((record) => record.submissionId === request.submissionId);
        if (winner) {
          const event = replayCommitted(reloaded.session, winner, payloadHash);
          emit(event);
          return event;
        }
      }
      throw new HomeworkSubmissionError("This homework session changed while pages were being added. Retry the submission.", "conflict", true);
    }

    try {
      await deps.updateClaim({
        studentId, sessionId: session.sessionId, submissionId: request.submissionId, eTag: claimETag,
        claim: { ...claim, status: "complete", updatedAt: now, version: claim.version + 1 },
      });
    } catch {
      // Session JSON is the commit point. A retry will replay its committed record.
    }
    const event = completeEvent(next, reconciliation.updatedQuestionIds, reconciliation.possiblyRepeatedQuestionIds);
    logger.info("homework_append_complete", {
      sessionId: next.sessionId,
      submissionId: request.submissionId,
      pageCount: event.pageCount,
      questionCount: event.questionCount,
      addedQuestionIds: reconciliation.addedQuestionIds,
      updatedQuestionIds: reconciliation.updatedQuestionIds,
      inputTokens: submissionUsage.inputTokens,
      outputTokens: submissionUsage.outputTokens,
      costUsd: submissionUsage.costUsd,
    });
    emit(event);
    return event;
  } catch (error) {
    if (!committed) {
      try {
        await deps.updateClaim({
          studentId, sessionId: session.sessionId, submissionId: request.submissionId, eTag: claimETag,
          claim: { ...claim, status: "failed", updatedAt: deps.now().toISOString(), version: claim.version + 1 },
        });
      } catch {
        // A conditional failure means another owner changed the claim; never overwrite it.
      }
    }
    throw error;
  }
};

export const processHomeworkSubmission = async (input: {
  studentId: string;
  request: HomeworkSubmissionRequest;
  emit: (event: StreamEvent) => void;
  deps?: HomeworkSubmissionDependencies;
}): Promise<HomeworkCompleteEvent> => {
  const deps = input.deps ?? defaultDependencies;
  if (input.request.images.length > 5) throw new HomeworkSubmissionError("Please upload at most 5 images at a time.", "validation");
  if (input.request.kind === "append_pages" && input.request.images.length === 0) throw new HomeworkSubmissionError("Adding pages requires at least one image.", "validation");
  return input.request.kind === "initial"
    ? runInitial(input.studentId, input.request, input.emit, deps)
    : runAppend(input.studentId, input.request, input.emit, deps);
};
