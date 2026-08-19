// ── Practice Session storage ─────────────────────────────────────────────────
// Practice is a top-level Session kind. Stored under the typed key layout
// (ADR 0005, supersedes ADR 0004):
//   sessions/{studentId}/practice/{sessionId}.json
//   sessions/{studentId}/practice/{sessionId}.agent.json
//
// The originating Homework question is recorded inside the session JSON as
// `origin: { sessionId, questionId }`.
//
// Sessions older than PRACTICE_SESSION_MAX_AGE_HOURS since updatedAt are
// auto-flipped to ended/abandoned on next read.
// ─────────────────────────────────────────────────────────────────────────────
import { randomUUID } from "node:crypto";
import type { PracticeSession } from "../shared/session";
import type { AgentSidecar } from "../shared/sessionStore";
import {
  loadAgentSidecar,
  loadSession,
  listSessions,
  saveAgentSidecar,
  saveSession,
} from "../shared/sessionStore";
import { logger } from "../shared/logger";

export const PRACTICE_SESSION_MAX_AGE_HOURS = 24;

export interface PracticeBundle {
  session: PracticeSession;
  sidecar: AgentSidecar;
}

export interface PracticeLocator {
  studentId: string;
  sessionId: string;
}

export interface PracticeOriginInput {
  studentId: string;
  originSessionId: string;
  originQuestionId: number;
}

const isStale = (session: PracticeSession): boolean => {
  if (session.status === "ended") return false;
  const ageMs = Date.now() - new Date(session.updatedAt).getTime();
  return ageMs > PRACTICE_SESSION_MAX_AGE_HOURS * 3600 * 1000;
};

export const createPracticeBundle = async (
  input: PracticeOriginInput,
): Promise<PracticeBundle> => {
  const origin = await loadSession(
    input.studentId,
    "homework",
    input.originSessionId,
  );
  if (!origin || origin.sessionType !== "homework") {
    throw new Error(`Origin homework session ${input.originSessionId} not found.`);
  }
  const sourceQuestion = origin.questions.find(
    (q) => q.questionId === input.originQuestionId,
  );
  if (!sourceQuestion) {
    throw new Error(
      `Question ${input.originQuestionId} not found in session ${input.originSessionId}.`,
    );
  }

  const now = new Date().toISOString();
  const session: PracticeSession = {
    sessionType: "practice",
    sessionId: randomUUID(),
    studentId: input.studentId,
    modelChoice: origin.modelChoice,
    timestamp: now,
    updatedAt: now,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    status: "active",
    origin: {
      sessionId: input.originSessionId,
      questionId: input.originQuestionId,
    },
    subject: sourceQuestion.subject,
    yearLevel: sourceQuestion.yearLevel,
    sourceCoachingPacket: sourceQuestion.packet,
    problemCount: 0,
    toolCallCount: 0,
    problems: [],
    toolLog: [],
  };

  await saveSession(session);
  return {
    session,
    sidecar: { bedrockMessages: [], usagePerTurn: [] },
  };
};

export const loadPracticeBundle = async (
  loc: PracticeLocator,
): Promise<PracticeBundle> => {
  const session = await loadSession(loc.studentId, "practice", loc.sessionId);
  if (!session) {
    const err = new Error("Practice session not found.");
    (err as { code?: string }).code = "NOT_FOUND";
    throw err;
  }
  if (session.sessionType !== "practice") {
    const err = new Error("This session is not a practice session.");
    (err as { code?: string }).code = "WRONG_TYPE";
    throw err;
  }
  if (session.studentId !== loc.studentId) {
    const err = new Error("Practice session not found.");
    (err as { code?: string }).code = "NOT_FOUND";
    throw err;
  }

  const sidecar: AgentSidecar = (await loadAgentSidecar(
    loc.studentId,
    "practice",
    loc.sessionId,
  )) ?? { bedrockMessages: [], usagePerTurn: [] };

  if (isStale(session)) {
    session.status = "ended";
    session.endedReason = "abandoned";
    session.finalSummary =
      session.finalSummary ??
      "Session expired after 24 hours of inactivity.";
    await saveSession(session);
    logger.info("practice_session_auto_abandoned", {
      sessionId: session.sessionId,
    });
  }

  return { session, sidecar };
};

export const savePracticeBundle = async (
  bundle: PracticeBundle,
): Promise<void> => {
  await saveSession(bundle.session);
  await saveAgentSidecar(
    bundle.session.studentId,
    "practice",
    bundle.session.sessionId,
    bundle.sidecar,
  );
  logger.info("practice_bundle_save", {
    sessionId: bundle.session.sessionId,
    status: bundle.session.status,
  });
};

// Used by history-handler.ts to surface "Practice ✓" pills per question.
// With the typed prefix layout (ADR 0005), we list only the practice/ prefix
// and filter to those whose origin matches.
export interface PracticeSessionSummary {
  sessionId: string;
  origin: { sessionId: string; questionId: number };
  status: PracticeSession["status"];
  endedReason?: PracticeSession["endedReason"];
  problemCount: number;
  updatedAt: string;
  usage: PracticeSession["usage"];
  modelChoice: PracticeSession["modelChoice"];
  finalSummary?: string;
}

export const listPracticeSessionsForOrigin = async (
  studentId: string,
  originSessionId: string,
): Promise<PracticeSessionSummary[]> => {
  // For an early-stage app this is fine; if session counts grow we can
  // maintain an index. listSessions paginates so we walk pages.
  const results: PracticeSessionSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await listSessions(studentId, "practice", cursor, 100);
    for (const s of page.sessions) {
      if (s.sessionType === "practice" && s.origin.sessionId === originSessionId) {
        results.push({
          sessionId: s.sessionId,
          origin: s.origin,
          status: s.status,
          endedReason: s.endedReason,
          problemCount: s.problemCount,
          updatedAt: s.updatedAt,
          usage: s.usage,
          modelChoice: s.modelChoice,
          finalSummary: s.finalSummary,
        });
      }
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return results;
};
