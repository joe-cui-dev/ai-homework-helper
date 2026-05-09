import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { listSessions } from "../shared/storage";
import type { BatchQuestion } from "../shared/storage";
import { listPracticeSessionsForBatch } from "../practice/practiceStorage";
import type { PracticeSessionSummary } from "../practice/practiceStorage";
import type {
  BookContext,
  ReadingPacket,
  TaskType,
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

interface QuestionWithPractice extends BatchQuestion {
  practiceSession?: PracticeSessionSummary;
}

interface SessionSummary {
  sessionId: string;
  timestamp: string;
  // "homework" | "reading" | "writing" — defaults to "homework" for legacy rows.
  sessionType: TaskType;
  subjects: string[];
  imageUrls: string[];
  questions: QuestionWithPractice[];
  // Reading-only fields. Empty/undefined for non-reading sessions.
  bookContext?: BookContext;
  readingPackets?: ReadingPacket[];
  // Writing-only fields. Empty/undefined for non-writing sessions. _internal
  // is intentionally NOT projected — see ADR 0003.
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

  const summaries: SessionSummary[] = await Promise.all(
    sessions.map(
      async (record) => {
        const {
          imageKeys,
          questions,
          sessionId,
          timestamp,
          usage,
          sessionType,
          bookContext,
          readingPackets,
        } = record;
        const resolvedType: TaskType = sessionType ?? "homework";
        // For writing sessions, surface ONLY the prompt image so the history
        // sidebar doesn't expose the student's draft work as thumbnails.
        const presignKeys =
          resolvedType === "writing"
            ? (record.prompt?.imageKeys ?? [])
            : (imageKeys ?? []);
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
          // Practice sessions are a homework-only concept; skip the S3 list
          // for reading and writing sessions.
          resolvedType === "homework"
            ? listPracticeSessionsForBatch(studentId, sessionId)
            : Promise.resolve([] as PracticeSessionSummary[]),
        ]);
        const practiceByQuestion = new Map(
          practiceSummaries.map((p) => [p.questionId, p]),
        );
        const questionsWithPractice: QuestionWithPractice[] = questions.map(
          (q) => ({
            ...q,
            practiceSession: practiceByQuestion.get(q.questionId),
          }),
        );
        const subjects =
          resolvedType === "reading"
            ? ["reading"]
            : resolvedType === "writing"
              ? ["writing"]
              : [...new Set(questions.map((q) => q.packet.subject))];
        return {
          sessionId,
          timestamp,
          sessionType: resolvedType,
          subjects,
          imageUrls,
          questions: questionsWithPractice,
          bookContext,
          readingPackets,
          // Writing-only fields; undefined for other types.
          status: resolvedType === "writing" ? record.status : undefined,
          endedReason:
            resolvedType === "writing" ? record.endedReason : undefined,
          updatedAt:
            resolvedType === "writing" ? record.updatedAt : undefined,
          prompt: resolvedType === "writing" ? record.prompt : undefined,
          plan: resolvedType === "writing" ? record.plan : undefined,
          turns: resolvedType === "writing" ? record.turns : undefined,
          draftCount:
            resolvedType === "writing" ? record.draftCount : undefined,
          questionCount:
            resolvedType === "writing" ? record.questionCount : undefined,
          usage,
        };
      },
    ),
  );

  logger.info("history_fetched", { studentId, count: summaries.length });
  logger.resetKeys();

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessions: summaries, nextCursor }),
  };
};
