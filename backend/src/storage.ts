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
import type { CoachingPacket } from "./types";
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
  questions: BatchQuestion[];
}

export interface SessionPage {
  sessions: SessionRecord[];
  nextCursor: string | null;
}

const s3 = new S3Client({});

export const saveSession = async (
  sessionId: string,
  data: { timestamp: string; questions: BatchQuestion[] },
  studentId?: string,
  imageKeys?: string[],
): Promise<void> => {
  const bucket = process.env.S3_BUCKET_NAME;
  if (!bucket) {
    throw new Error("S3_BUCKET_NAME environment variable is not set");
  }

  const key = studentId
    ? `sessions/${studentId}/${sessionId}.json`
    : `sessions/${sessionId}.json`;

  const body = imageKeys?.length ? { ...data, imageKeys } : data;

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(body),
      ContentType: "application/json",
    }),
  );
  logger.info("session_save", { key });
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
      return {
        sessionId,
        timestamp: (raw.timestamp as string) ?? "",
        imageKeys: raw.imageKeys as string[] | undefined,
        questions: (raw.questions as BatchQuestion[] | undefined) ?? [],
      } as SessionRecord;
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
      const key = `sessions/${studentId}/${sessionId}/image-${i}.${ext}`;
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

      return {
        sessionId,
        timestamp: (raw.timestamp as string) ?? "",
        imageKeys: raw.imageKeys as string[] | undefined,
        questions: (raw.questions as BatchQuestion[] | undefined) ?? [],
      } as SessionRecord;
    }),
  );

  const validSessions = sessions.filter((s): s is SessionRecord => s !== null);
  logger.info("list_sessions", { studentId, count: validSessions.length });
  return { sessions: validSessions, nextCursor };
};
