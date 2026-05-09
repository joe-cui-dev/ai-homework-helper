// ── Session storage ───────────────────────────────────────────────────────────
// Persists completed batch sessions to S3.
//
// Key format: sessions/<studentId>/<batchId>.json
// Sessions expire after 30 days (lifecycle rule set in CDK).
//
// Phase 1 redesign: legacy single-question session shape has been retired.
// All sessions in S3 use the CoachingPacket shape. Older sessions written
// before the redesign are wiped at deploy time (manual aws s3 rm step).
// ─────────────────────────────────────────────────────────────────────────────
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import type {
  BookContext,
  CoachingPacket,
  ReadingPacket,
  TaskType,
  TokenUsage,
  WritingEndedReason,
  WritingPlanPacket,
  WritingTurn,
} from "./types";
import { logger } from "./logger";

export interface BatchQuestion {
  questionId: number;
  input: string;
  packet: CoachingPacket;
}

export interface SessionRecord {
  sessionId: string;
  timestamp: string;
  imageKeys?: string[];
  // Discriminator. Absent on legacy rows written before reading sessions
  // landed — readers must default to "homework".
  sessionType?: TaskType;
  // Populated for homework sessions only (for back-compat the field is named
  // `questions` in the JSON regardless).
  questions: BatchQuestion[];
  // Populated for reading sessions only.
  bookContext?: BookContext;
  readingPackets?: ReadingPacket[];
  // Populated for writing sessions only. The _internal field on the underlying
  // S3 JSON (Bedrock messages, per-turn raw usage) is intentionally NOT
  // surfaced on SessionRecord — see ADR 0003. Readers strip it before
  // projection.
  status?: "active" | "ended";
  endedReason?: WritingEndedReason;
  updatedAt?: string;
  prompt?: { input: string; imageKeys?: string[] };
  plan?: WritingPlanPacket;
  turns?: WritingTurn[];
  draftCount?: number;
  questionCount?: number;
  // Total tokens used to produce the entire batch (analyze + chunked packet
  // calls). Optional for backward compatibility with sessions written before
  // usage tracking landed.
  usage?: TokenUsage;
}

export interface SessionPage {
  sessions: SessionRecord[];
  nextCursor: string | null;
}

const s3 = new S3Client({});

export interface SaveSessionData {
  timestamp: string;
  questions?: BatchQuestion[];
  sessionType?: TaskType;
  bookContext?: BookContext;
  readingPackets?: ReadingPacket[];
}

export const saveSession = async (
  sessionId: string,
  data: SaveSessionData,
  studentId?: string,
  imageKeys?: string[],
  usage?: TokenUsage,
): Promise<void> => {
  const bucket = process.env.S3_BUCKET_NAME;
  if (!bucket) {
    throw new Error("S3_BUCKET_NAME environment variable is not set");
  }

  const key = studentId
    ? `sessions/${studentId}/${sessionId}.json`
    : `sessions/${sessionId}.json`;

  const body: Record<string, unknown> = { ...data };
  // Default homework sessions don't write the questions key as undefined.
  if (!data.questions?.length) delete body.questions;
  if (!data.readingPackets?.length) delete body.readingPackets;
  if (!data.bookContext) delete body.bookContext;
  if (!data.sessionType) delete body.sessionType;
  if (imageKeys?.length) body.imageKeys = imageKeys;
  if (usage) body.usage = usage;

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(body),
      ContentType: "application/json",
    }),
  );
  logger.info("session_save", { key, sessionType: data.sessionType ?? "homework" });
};

// Kept exported for Phase 2 (Coaching Dialogue) which may surface recent
// sessions as agent context. Unused in Phase 1.
export const getRecentSessions = async (
  studentId: string,
  limit = 3,
): Promise<SessionRecord[]> => {
  const bucket = process.env.S3_BUCKET_NAME;
  if (!bucket) {
    throw new Error("S3_BUCKET_NAME environment variable is not set");
  }

  const list = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `sessions/${studentId}/`,
    }),
  );

  if (!list.Contents || list.Contents.length === 0) return [];

  const recentKeys = list.Contents.filter(
    (obj): obj is typeof obj & { Key: string; LastModified: Date } =>
      obj.Key !== undefined &&
      obj.Key.endsWith(".json") &&
      obj.LastModified !== undefined,
  )
    .sort((a, b) => b.LastModified.getTime() - a.LastModified.getTime())
    .slice(0, limit);

  const sessions = await Promise.all(
    recentKeys.map(async (obj) => {
      const response = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: obj.Key }),
      );
      const body = await response.Body?.transformToString("utf-8");
      if (!body) return null;
      const raw = JSON.parse(body) as Record<string, unknown>;
      const sessionId = obj.Key.replace(`sessions/${studentId}/`, "").replace(
        ".json",
        "",
      );
      return projectSessionRecord(sessionId, raw);
    }),
  );

  const result = sessions.filter((s): s is SessionRecord => s !== null);
  logger.info("sessions_fetched", { studentId, count: result.length });
  return result;
};

export const uploadSessionImages = async (
  studentId: string,
  sessionId: string,
  images: string[],
  // Prefix lets multi-turn sessions (Writing) namespace images per turn role
  // without colliding on flat sessions/<studentId>/<batchId>/. Defaults to
  // "image" — the original homework/reading naming.
  prefix: string = "image",
): Promise<string[]> => {
  if (images.length === 0) return [];

  const bucket = process.env.S3_BUCKET_NAME;
  if (!bucket)
    throw new Error("S3_BUCKET_NAME environment variable is not set");

  const keys = await Promise.all(
    images.map(async (dataUrl, i) => {
      const match = dataUrl.match(
        /^data:(image\/(jpeg|png|gif|webp));base64,(.+)$/s,
      );
      if (!match) throw new Error(`Invalid image data URL at index ${i}`);
      const [, mediaType, ext, base64Data] = match;
      const key = `sessions/${studentId}/${sessionId}/${prefix}-${i}.${ext}`;
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: Buffer.from(base64Data, "base64"),
          ContentType: mediaType,
        }),
      );
      return key;
    }),
  );

  return keys;
};

export const listSessions = async (
  studentId: string,
  cursor?: string,
  limit = 10,
): Promise<SessionPage> => {
  const bucket = process.env.S3_BUCKET_NAME;
  if (!bucket)
    throw new Error("S3_BUCKET_NAME environment variable is not set");

  const list = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `sessions/${studentId}/`,
    }),
  );

  if (!list.Contents || list.Contents.length === 0) {
    return { sessions: [], nextCursor: null };
  }

  const jsonKeys = list.Contents.filter(
    (obj): obj is typeof obj & { Key: string; LastModified: Date } =>
      obj.Key !== undefined &&
      obj.Key.endsWith(".json") &&
      obj.LastModified !== undefined,
  ).sort((a, b) => b.LastModified.getTime() - a.LastModified.getTime());

  const offset = cursor
    ? parseInt(Buffer.from(cursor, "base64").toString(), 10)
    : 0;
  const page = jsonKeys.slice(offset, offset + limit);
  const nextCursor =
    offset + limit < jsonKeys.length
      ? Buffer.from(String(offset + limit)).toString("base64")
      : null;

  const sessions = await Promise.all(
    page.map(async (obj) => {
      const response = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: obj.Key }),
      );
      const body = await response.Body?.transformToString("utf-8");
      if (!body) return null;

      const sessionId = obj.Key.replace(`sessions/${studentId}/`, "").replace(
        ".json",
        "",
      );
      const raw = JSON.parse(body) as Record<string, unknown>;
      return projectSessionRecord(sessionId, raw);
    }),
  );

  const validSessions = sessions.filter((s): s is SessionRecord => s !== null);
  logger.info("list_sessions", { studentId, count: validSessions.length });
  return { sessions: validSessions, nextCursor };
};

// Project the raw S3 JSON of a session into the SessionRecord public shape.
// Critical: never echo `_internal` (Writing Session Bedrock messages, per-turn
// raw usage). See ADR 0003. Defaults `sessionType` to "homework" for legacy
// rows written before the discriminator existed.
const projectSessionRecord = (
  sessionId: string,
  raw: Record<string, unknown>,
): SessionRecord => {
  const sessionType =
    (raw.sessionType as TaskType | undefined) ?? "homework";
  const base: SessionRecord = {
    sessionId,
    timestamp: (raw.timestamp as string) ?? "",
    imageKeys: raw.imageKeys as string[] | undefined,
    sessionType,
    questions: (raw.questions as BatchQuestion[] | undefined) ?? [],
    bookContext: raw.bookContext as BookContext | undefined,
    readingPackets: raw.readingPackets as ReadingPacket[] | undefined,
    usage: raw.usage as TokenUsage | undefined,
  };
  if (sessionType === "writing") {
    base.status = raw.status as SessionRecord["status"];
    base.endedReason = raw.endedReason as WritingEndedReason | undefined;
    base.updatedAt = raw.updatedAt as string | undefined;
    base.prompt = raw.prompt as SessionRecord["prompt"];
    base.plan = raw.plan as WritingPlanPacket | undefined;
    base.turns = (raw.turns as WritingTurn[] | undefined) ?? [];
    base.draftCount = (raw.draftCount as number | undefined) ?? 0;
    base.questionCount = (raw.questionCount as number | undefined) ?? 0;
  }
  return base;
};
