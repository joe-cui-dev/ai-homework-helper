import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { listSessions, loadSession } from "../shared/sessionStore";
import { homeworkImageKeys, type HomeworkQuestion, type Session } from "../shared/session";
import { listPracticeSessionsForOrigin } from "../practice/practiceStorage";
import type { PracticeSessionSummary } from "../practice/practiceStorage";
import type { ModelChoice } from "../shared/modelChoice";
import type {
  BookContext,
  ReadingPacket,
  TokenUsage,
  WritingEndedReason,
  WritingPlanPacket,
  WritingTurn,
} from "../shared/types";
import { logger } from "../shared/logger";
import { parseSessionId, parseStudentId } from "../shared/storageIdentifiers";

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID ?? "",
  clientId: process.env.COGNITO_APP_CLIENT_ID ?? "",
  tokenUse: "access",
});

const s3 = new S3Client({});
const PRESIGN_EXPIRES_IN = 3600;

interface QuestionWithPractice extends Pick<
  HomeworkQuestion,
  "questionId" | "input" | "subject" | "yearLevel" | "packet" | "possiblyRepeatedOfQuestionId"
> {
  practiceSession?: PracticeSessionSummary;
}

type HistoryModule = "homework" | "reading" | "writing";

const isHistoryModule = (v: string | undefined): v is HistoryModule =>
  v === "homework" || v === "reading" || v === "writing";

interface SessionSummary {
  sessionId: string;
  timestamp: string;
  sessionType: HistoryModule;
  modelChoice: ModelChoice;
  subjects: string[];
  imageUrls: Array<string | null>;
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

type HistorySession = Exclude<Session, { sessionType: "practice" }>;

const projectSession = async (
  record: HistorySession,
  studentId: string,
  bucket: string,
): Promise<SessionSummary> => {
  const presignKeys = record.sessionType === "writing"
    ? record.prompt.imageKeys
    : record.sessionType === "homework"
      ? homeworkImageKeys(record)
      : record.imageKeys;
  const [imageUrls, practiceSummaries] = await Promise.all([
    Promise.all(presignKeys.map(async (key, imageIndex) => {
      try {
        return await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: bucket, Key: key }),
          { expiresIn: PRESIGN_EXPIRES_IN },
        );
      } catch {
        logger.warn("history_image_unavailable", { sessionId: record.sessionId, imageIndex });
        return null;
      }
    })),
    record.sessionType === "homework"
      ? listPracticeSessionsForOrigin(studentId, record.sessionId)
      : Promise.resolve([] as PracticeSessionSummary[]),
  ]);
  const practiceByQuestion = new Map(
    practiceSummaries.map((practice) => [practice.origin.questionId, practice]),
  );
  const questions: QuestionWithPractice[] = record.sessionType === "homework"
    ? record.questions.map((question) => ({
        questionId: question.questionId,
        input: question.input,
        subject: question.subject,
        yearLevel: question.yearLevel,
        packet: question.packet,
        ...(question.possiblyRepeatedOfQuestionId !== undefined
          ? { possiblyRepeatedOfQuestionId: question.possiblyRepeatedOfQuestionId }
          : {}),
        practiceSession: practiceByQuestion.get(question.questionId),
      }))
    : [];
  const subjects = record.sessionType === "reading"
    ? ["reading"]
    : record.sessionType === "writing"
      ? ["writing"]
      : [...new Set(record.questions.map((question) => question.subject))];
  const summary: SessionSummary = {
    sessionId: record.sessionId,
    timestamp: record.timestamp,
    sessionType: record.sessionType,
    modelChoice: record.modelChoice,
    subjects,
    imageUrls,
    questions,
    usage: record.usage,
    updatedAt: record.updatedAt,
  };

  if (record.sessionType === "reading") {
    summary.bookContext = record.bookContext;
    summary.readingPackets = record.readingPackets;
  } else if (record.sessionType === "writing") {
    summary.status = record.status;
    summary.endedReason = record.endedReason;
    summary.prompt = record.prompt;
    summary.plan = record.plan;
    summary.turns = await Promise.all(record.turns.map(async (turn): Promise<WritingTurn> => {
      if (turn.kind !== "draft" || !turn.input.imageKeys?.length) return turn;
      const draftImageUrls = await Promise.all(turn.input.imageKeys.map((key) =>
        getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: bucket, Key: key }),
          { expiresIn: PRESIGN_EXPIRES_IN },
        )));
      return { ...turn, input: { ...turn.input, imageUrls: draftImageUrls } };
    }));
    summary.draftCount = record.draftCount;
    summary.questionCount = record.questionCount;
  }

  return summary;
};

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
    studentId = parseStudentId(payload.sub);
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
  const typeParam = qs.type;
  if (!isHistoryModule(typeParam)) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        message:
          "Missing or invalid `type` query parameter; expected one of homework|reading|writing",
      }),
    };
  }

  const bucket = process.env.S3_BUCKET_NAME ?? "";
  if (qs.sessionId) {
    let selectedSessionId: string;
    try {
      selectedSessionId = parseSessionId(qs.sessionId);
    } catch {
      logger.resetKeys();
      return {
        statusCode: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Session unavailable." }),
      };
    }
    const selected = await loadSession(studentId, typeParam, selectedSessionId);
    if (!selected || selected.sessionType === "practice") {
      logger.resetKeys();
      return {
        statusCode: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Session unavailable." }),
      };
    }
    const detail = await projectSession(selected, studentId, bucket);
    logger.info("history_detail_fetched", { sessionId: selected.sessionId });
    logger.resetKeys();
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: detail }),
    };
  }
  let scanCursor = cursor;
  let nextCursor: string | null = null;
  const sessions: Session[] = [];
  do {
    const page = await listSessions(
      studentId,
      typeParam,
      scanCursor,
      Math.max(1, limit - sessions.length),
    );
    sessions.push(...page.sessions.filter(
      (record) => record.sessionType !== "homework" || record.questions.length > 0,
    ));
    nextCursor = page.nextCursor;
    scanCursor = page.nextCursor ?? undefined;
  } while (sessions.length < limit && nextCursor);

  // Practice never appears under homework|reading|writing prefixes — it lives
  // under its own practice/ prefix and is only fetched via
  // listPracticeSessionsForOrigin to nest under each Homework card.
  const topLevel = sessions as HistorySession[];
  const summaries = await Promise.all(
    topLevel.map((record) => projectSession(record, studentId, bucket)),
  );

  logger.info("history_fetched", { studentId, count: summaries.length });
  logger.resetKeys();

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessions: summaries, nextCursor }),
  };
};
