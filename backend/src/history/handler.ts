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
  // "homework" | "reading" — defaults to "homework" for legacy rows.
  sessionType: TaskType;
  subjects: string[];
  imageUrls: string[];
  questions: QuestionWithPractice[];
  // Reading-only fields. Empty/undefined for homework sessions.
  bookContext?: BookContext;
  readingPackets?: ReadingPacket[];
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
      async ({
        imageKeys,
        questions,
        sessionId,
        timestamp,
        usage,
        sessionType,
        bookContext,
        readingPackets,
      }) => {
        const resolvedType: TaskType = sessionType ?? "homework";
        const [imageUrls, practiceSummaries] = await Promise.all([
          imageKeys?.length
            ? Promise.all(
                imageKeys.map((key) =>
                  getSignedUrl(
                    s3,
                    new GetObjectCommand({ Bucket: bucket, Key: key }),
                    { expiresIn: PRESIGN_EXPIRES_IN },
                  ),
                ),
              )
            : Promise.resolve([] as string[]),
          // Practice sessions are a homework-only concept in v1; skip the
          // S3 list for reading sessions.
          resolvedType === "reading"
            ? Promise.resolve([] as PracticeSessionSummary[])
            : listPracticeSessionsForBatch(studentId, sessionId),
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
