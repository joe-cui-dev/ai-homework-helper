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

interface PracticeHistorySummary {
  questionId: number;
  status: PracticeSessionSummary["status"];
  endedReason?: PracticeSessionSummary["endedReason"];
  problemCount: number;
  updatedAt: string;
  totalUsage: TokenUsage;
  modelChoice: ModelChoice;
  finalSummary?: string;
}

type PublicWritingTurn =
  | (Omit<Extract<WritingTurn, { kind: "draft" }>, "input"> & {
      input: { text?: string; imageUrls?: Array<string | null> };
    })
  | Extract<WritingTurn, { kind: "question" }>;

interface QuestionWithPractice extends Pick<
  HomeworkQuestion,
  "questionId" | "input" | "subject" | "yearLevel" | "packet" | "possiblyRepeatedOfQuestionId"
> {
  practiceSessions?: PracticeHistorySummary[];
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
  prompt?: { input: string };
  plan?: WritingPlanPacket;
  turns?: PublicWritingTurn[];
  draftCount?: number;
  questionCount?: number;
  usage?: TokenUsage;
}

interface SessionCardSummary {
  sessionId: string;
  timestamp: string;
  updatedAt?: string;
  sessionType: HistoryModule;
  modelChoice: ModelChoice;
  subjects: string[];
  imageUrls: Array<string | null>;
  imageCount: number;
  questionPreview?: string;
  questionCount: number;
  bookContext?: BookContext;
  status?: "active" | "ended";
  endedReason?: WritingEndedReason;
  prompt?: { input: string };
  assignmentSummary?: string;
  draftCount?: number;
}

type HistorySession = Exclude<Session, { sessionType: "practice" }>;

const isHistoryVisible = (record: HistorySession): boolean =>
  record.sessionType !== "homework" || record.questions.length > 0;

const presignImages = async (
  keys: string[],
  bucket: string,
  sessionId: string,
): Promise<Array<string | null>> => Promise.all(keys.map(async (key, imageIndex) => {
  try {
    return await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: PRESIGN_EXPIRES_IN },
    );
  } catch {
    logger.warn("history_image_unavailable", { sessionId, imageIndex });
    return null;
  }
}));

const sessionImageKeys = (record: HistorySession): string[] => record.sessionType === "writing"
  ? record.prompt.imageKeys
  : record.sessionType === "homework"
    ? homeworkImageKeys(record)
    : record.imageKeys;

const sessionSubjects = (record: HistorySession): string[] => record.sessionType === "reading"
  ? ["reading"]
  : record.sessionType === "writing"
    ? ["writing"]
    : [...new Set(record.questions.map((question) => question.subject))];

const projectSessionCard = async (
  record: HistorySession,
  bucket: string,
): Promise<SessionCardSummary> => {
  const imageKeys = sessionImageKeys(record);
  const card: SessionCardSummary = {
    sessionId: record.sessionId,
    timestamp: record.timestamp,
    updatedAt: record.updatedAt,
    sessionType: record.sessionType,
    modelChoice: record.modelChoice,
    subjects: sessionSubjects(record),
    imageUrls: await presignImages(imageKeys.slice(0, 1), bucket, record.sessionId),
    imageCount: imageKeys.length,
    questionCount: record.sessionType === "homework"
      ? record.questions.length
      : record.sessionType === "reading"
        ? record.readingPackets.length
        : record.questionCount,
  };
  if (record.sessionType === "homework") card.questionPreview = record.questions[0]?.input;
  if (record.sessionType === "reading") {
    card.bookContext = record.bookContext;
    card.questionPreview = record.readingPackets[0]?.questionText;
  }
  if (record.sessionType === "writing") {
    card.status = record.status;
    card.endedReason = record.endedReason;
    card.prompt = { input: record.prompt.input };
    card.assignmentSummary = record.plan.assignmentSummary;
    card.draftCount = record.draftCount;
  }
  return card;
};

const projectSession = async (
  record: HistorySession,
  studentId: string,
  bucket: string,
): Promise<SessionSummary> => {
  const presignKeys = sessionImageKeys(record);
  const [imageUrls, practiceSummaries] = await Promise.all([
    presignImages(presignKeys, bucket, record.sessionId),
    record.sessionType === "homework"
      ? listPracticeSessionsForOrigin(studentId, record.sessionId)
      : Promise.resolve([] as PracticeSessionSummary[]),
  ]);
  const practiceByQuestion = new Map<number, PracticeSessionSummary[]>();
  for (const practice of [...practiceSummaries].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt))) {
    const questionId = practice.origin.questionId;
    practiceByQuestion.set(questionId, [...(practiceByQuestion.get(questionId) ?? []), practice]);
  }
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
        practiceSessions: (practiceByQuestion.get(question.questionId) ?? []).map((practice) => ({
          questionId: question.questionId,
          status: practice.status,
          endedReason: practice.endedReason,
          problemCount: practice.problemCount,
          updatedAt: practice.updatedAt,
          totalUsage: practice.usage,
          modelChoice: practice.modelChoice,
          finalSummary: practice.finalSummary,
        })),
      }))
    : [];
  const summary: SessionSummary = {
    sessionId: record.sessionId,
    timestamp: record.timestamp,
    sessionType: record.sessionType,
    modelChoice: record.modelChoice,
    subjects: sessionSubjects(record),
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
    summary.prompt = { input: record.prompt.input };
    summary.plan = record.plan;
    summary.turns = await Promise.all(record.turns.map(async (turn): Promise<PublicWritingTurn> => {
      if (turn.kind !== "draft") return turn;
      const { imageKeys, ...publicInput } = turn.input;
      if (!imageKeys?.length) return { ...turn, input: publicInput };
      const draftImageUrls = await presignImages(imageKeys, bucket, record.sessionId);
      return { ...turn, input: { ...publicInput, imageUrls: draftImageUrls } };
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
    if (!selected || selected.sessionType === "practice" || !isHistoryVisible(selected)) {
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
      (record): record is HistorySession => record.sessionType !== "practice" && isHistoryVisible(record),
    ));
    nextCursor = page.nextCursor;
    scanCursor = page.nextCursor ?? undefined;
  } while (sessions.length < limit && nextCursor);

  // Practice never appears under homework|reading|writing prefixes — it lives
  // under its own practice/ prefix and is only fetched via
  // listPracticeSessionsForOrigin to nest under each Homework card.
  const topLevel = sessions as HistorySession[];
  const summaries = await Promise.all(
    topLevel.map((record) => projectSessionCard(record, bucket)),
  );

  logger.info("history_fetched", { studentId, count: summaries.length });
  logger.resetKeys();

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessions: summaries, nextCursor }),
  };
};
