import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { listSessions } from "../shared/sessionStore";
import type { HomeworkQuestion, Session } from "../shared/session";
import { listPracticeSessionsForOrigin } from "../practice/practiceStorage";
import type { PracticeSessionSummary } from "../practice/practiceStorage";
import type {
  BookContext,
  ReadingPacket,
  TokenUsage,
  WritingEndedReason,
  WritingPlanPacket,
  WritingTurn,
} from "../shared/types";
import { logger } from "../shared/logger";

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID ?? "",
  clientId: process.env.COGNITO_APP_CLIENT_ID ?? "",
  tokenUse: "access",
});

const s3 = new S3Client({});
const PRESIGN_EXPIRES_IN = 3600;

interface QuestionWithPractice extends HomeworkQuestion {
  practiceSession?: PracticeSessionSummary;
}

interface SessionSummary {
  sessionId: string;
  timestamp: string;
  sessionType: "homework" | "reading" | "writing";
  subjects: string[];
  imageUrls: string[];
  questions: QuestionWithPractice[];
  // Reading-only fields.
  bookContext?: BookContext;
  readingPackets?: ReadingPacket[];
  // Writing-only fields.
  status?: "active" | "ended";
  endedReason?: WritingEndedReason;
  updatedAt?: string;
  prompt?: { input: string; imageKeys?: string[] };
  plan?: WritingPlanPacket;
  turns?: WritingTurn[];
  draftCount?: number;
  questionCount?: number;
  usage?: TokenUsage;
}

export const handler = async (
  event: APIGatewayProxyEventV2,
  _context: Context,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const authHeader =
    event.headers?.["authorization"] ?? event.headers?.["Authorization"] ?? "";
  const bearerToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : "";

  if (!bearerToken) {
    logger.warn("history_auth_missing_token");
    return {
      statusCode: 401,
      body: JSON.stringify({ message: "Missing Authorization header" }),
    };
  }

  let studentId: string;
  try {
    const payload = await verifier.verify(bearerToken);
    studentId = payload.sub;
  } catch {
    logger.warn("history_auth_invalid_token");
    return {
      statusCode: 401,
      body: JSON.stringify({ message: "Invalid or expired token" }),
    };
  }

  logger.appendKeys({ studentId });

  const qs = event.queryStringParameters ?? {};
  const cursor = qs.cursor;
  const limit = qs.limit ? parseInt(qs.limit, 10) : 10;

  const bucket = process.env.S3_BUCKET_NAME ?? "";
  const { sessions, nextCursor } = await listSessions(studentId, cursor, limit);

  // Practice sessions are surfaced as siblings under their origin Homework
  // card, not as top-level cards (ADR 0004: data model peers; UI nests for now).
  const topLevel = sessions.filter(
    (s): s is Exclude<Session, { sessionType: "practice" }> =>
      s.sessionType !== "practice",
  );

  const summaries: SessionSummary[] = await Promise.all(
    topLevel.map(async (record) => {
      // For writing, surface only prompt images. Otherwise the session's imageKeys.
      const presignKeys =
        record.sessionType === "writing"
          ? record.prompt.imageKeys
          : record.imageKeys;
      const [imageUrls, practiceSummaries] = await Promise.all([
        presignKeys.length
          ? Promise.all(
              presignKeys.map((key) =>
                getSignedUrl(
                  s3,
                  new GetObjectCommand({ Bucket: bucket, Key: key }),
                  { expiresIn: PRESIGN_EXPIRES_IN },
                ),
              ),
            )
          : Promise.resolve([] as string[]),
        record.sessionType === "homework"
          ? listPracticeSessionsForOrigin(studentId, record.sessionId)
          : Promise.resolve([] as PracticeSessionSummary[]),
      ]);
      const practiceByQuestion = new Map(
        practiceSummaries.map((p) => [p.origin.questionId, p]),
      );

      const questions: QuestionWithPractice[] =
        record.sessionType === "homework"
          ? record.questions.map((q) => ({
              ...q,
              practiceSession: practiceByQuestion.get(q.questionId),
            }))
          : [];

      const subjects =
        record.sessionType === "reading"
          ? ["reading"]
          : record.sessionType === "writing"
            ? ["writing"]
            : [...new Set(record.questions.map((q) => q.packet.subject))];

      const summary: SessionSummary = {
        sessionId: record.sessionId,
        timestamp: record.timestamp,
        sessionType: record.sessionType,
        subjects,
        imageUrls,
        questions,
        usage: record.usage,
      };

      if (record.sessionType === "reading") {
        summary.bookContext = record.bookContext;
        summary.readingPackets = record.readingPackets;
      } else if (record.sessionType === "writing") {
        summary.status = record.status;
        summary.endedReason = record.endedReason;
        summary.updatedAt = record.updatedAt;
        summary.prompt = record.prompt;
        summary.plan = record.plan;
        summary.turns = record.turns;
        summary.draftCount = record.draftCount;
        summary.questionCount = record.questionCount;
      }

      return summary;
    }),
  );

  logger.info("history_fetched", { studentId, count: summaries.length });
  logger.resetKeys();

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessions: summaries, nextCursor }),
  };
};
