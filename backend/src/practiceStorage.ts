// ── Practice Session storage ─────────────────────────────────────────────────
// One JSON object per practice session, keyed at:
//   sessions/{studentId}/{batchId}/practice-{questionId}.json
//
// Sessions are loaded fresh per Lambda invocation (stateless turn model).
// Sessions older than PRACTICE_SESSION_MAX_AGE_HOURS since updatedAt are
// auto-flipped to status="ended", endedReason="abandoned" on next read.
// ─────────────────────────────────────────────────────────────────────────────
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
} from "@aws-sdk/client-s3";
import type { CoachingPacket, PracticeSession, TokenUsage } from "./types";
import { logger } from "./logger";

const s3 = new S3Client({});

export const PRACTICE_SESSION_MAX_AGE_HOURS = 24;

const bucket = (): string => {
  const b = process.env.S3_BUCKET_NAME;
  if (!b) throw new Error("S3_BUCKET_NAME environment variable is not set");
  return b;
};

const practiceKey = (
  studentId: string,
  batchId: string,
  questionId: number,
): string => `sessions/${studentId}/${batchId}/practice-${questionId}.json`;

const sessionKey = (studentId: string, batchId: string): string =>
  `sessions/${studentId}/${batchId}.json`;

const isStale = (session: PracticeSession): boolean => {
  if (session.status === "ended") return false;
  const ageMs = Date.now() - new Date(session.updatedAt).getTime();
  return ageMs > PRACTICE_SESSION_MAX_AGE_HOURS * 3600 * 1000;
};

export interface PracticeSessionLocator {
  studentId: string;
  batchId: string;
  questionId: number;
}

// Look up the source CoachingPacket from the parent batch session JSON.
// Used by createPracticeSession to snapshot the packet at session start.
const loadSourceCoachingPacket = async (
  studentId: string,
  batchId: string,
  questionId: number,
): Promise<CoachingPacket> => {
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: bucket(),
      Key: sessionKey(studentId, batchId),
    }),
  );
  const body = await response.Body?.transformToString("utf-8");
  if (!body) throw new Error(`Source session ${batchId} not found.`);
  const raw = JSON.parse(body) as {
    questions?: Array<{ questionId: number; packet: CoachingPacket }>;
  };
  const match = raw.questions?.find((q) => q.questionId === questionId);
  if (!match) {
    throw new Error(
      `Question ${questionId} not found in batch ${batchId}.`,
    );
  }
  return match.packet;
};

export const createPracticeSession = async (
  loc: PracticeSessionLocator,
): Promise<PracticeSession> => {
  const { studentId, batchId, questionId } = loc;

  // Refuse if a session already exists for this composite key.
  try {
    const existing = await loadPracticeSession(loc);
    if (existing.status === "active") {
      throw Object.assign(
        new Error(
          "A practice session is already in progress for this question. Resume it instead of starting a new one.",
        ),
        { code: "ALREADY_ACTIVE" },
      );
    }
    // If existing session is "ended", fall through and replace it. The parent
    // is starting a fresh attempt at the same source question.
  } catch (err) {
    if ((err as { code?: string }).code === "ALREADY_ACTIVE") throw err;
    if (!(err instanceof NoSuchKey || (err as { name?: string }).name === "NoSuchKey")) {
      // Real read error — surface.
      // (NoSuchKey is the expected "no existing session" path; anything else is a bug.)
    }
  }

  const sourceCoachingPacket = await loadSourceCoachingPacket(
    studentId,
    batchId,
    questionId,
  );
  const now = new Date().toISOString();
  const session: PracticeSession = {
    practiceSessionId: `${batchId}:${questionId}`,
    studentId,
    sourceBatchId: batchId,
    sourceQuestionId: questionId,
    sourceCoachingPacket,
    createdAt: now,
    updatedAt: now,
    status: "active",
    problemCount: 0,
    toolCallCount: 0,
    problems: [],
    messages: [],
    toolLog: [],
    totalUsage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  };
  await savePracticeSession(session);
  return session;
};

export const loadPracticeSession = async (
  loc: PracticeSessionLocator,
): Promise<PracticeSession> => {
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: bucket(),
      Key: practiceKey(loc.studentId, loc.batchId, loc.questionId),
    }),
  );
  const body = await response.Body?.transformToString("utf-8");
  if (!body) throw new Error("Practice session is empty.");
  const session = JSON.parse(body) as PracticeSession;
  // Defensive: older sessions written before usage tracking landed.
  if (!session.totalUsage) {
    session.totalUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }

  if (isStale(session)) {
    session.status = "ended";
    session.endedReason = "abandoned";
    session.finalSummary =
      session.finalSummary ??
      "Session expired after 24 hours of inactivity.";
    await savePracticeSession(session);
    logger.info("practice_session_auto_abandoned", {
      practiceSessionId: session.practiceSessionId,
    });
  }

  return session;
};

export const savePracticeSession = async (
  session: PracticeSession,
): Promise<void> => {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: practiceKey(
        session.studentId,
        session.sourceBatchId,
        session.sourceQuestionId,
      ),
      Body: JSON.stringify(session),
      ContentType: "application/json",
    }),
  );
  logger.info("practice_session_save", {
    practiceSessionId: session.practiceSessionId,
    status: session.status,
  });
};

// Used by history-handler.ts to surface "Practice ✓" pills per question.
export interface PracticeSessionSummary {
  questionId: number;
  status: PracticeSession["status"];
  endedReason?: PracticeSession["endedReason"];
  problemCount: number;
  updatedAt: string;
  totalUsage?: TokenUsage;
}

export const listPracticeSessionsForBatch = async (
  studentId: string,
  batchId: string,
): Promise<PracticeSessionSummary[]> => {
  const list = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket(),
      Prefix: `sessions/${studentId}/${batchId}/practice-`,
    }),
  );
  if (!list.Contents || list.Contents.length === 0) return [];
  const summaries = await Promise.all(
    list.Contents.filter((obj): obj is typeof obj & { Key: string } =>
      obj.Key !== undefined && obj.Key.endsWith(".json"),
    ).map(async (obj): Promise<PracticeSessionSummary | null> => {
      const response = await s3.send(
        new GetObjectCommand({ Bucket: bucket(), Key: obj.Key }),
      );
      const body = await response.Body?.transformToString("utf-8");
      if (!body) return null;
      const session = JSON.parse(body) as PracticeSession;
      return {
        questionId: session.sourceQuestionId,
        status: session.status,
        endedReason: session.endedReason,
        problemCount: session.problemCount,
        updatedAt: session.updatedAt,
        totalUsage: session.totalUsage,
      };
    }),
  );
  return summaries.filter((s): s is PracticeSessionSummary => s !== null);
};
