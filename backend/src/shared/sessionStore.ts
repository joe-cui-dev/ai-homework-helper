// ── Session storage ───────────────────────────────────────────────────────────
// Persists Session records (discriminated union over sessionType) to S3.
//
// Key layout (see ADR 0004):
//   sessions/{studentId}/{sessionId}.json          ← user-facing Session
//   sessions/{studentId}/{sessionId}.agent.json    ← Bedrock sidecar (Writing/Practice)
//   sessions/{studentId}/{sessionId}/image-*.{ext} ← uploaded images
//
// 30-day S3 lifecycle ages everything out.
// ─────────────────────────────────────────────────────────────────────────────
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import type { Session } from "./session";
import type { BedrockMessage } from "./bedrock";
import { logger } from "./logger";

export interface SessionPage {
  sessions: Session[];
  nextCursor: string | null;
}

// Per-turn raw Bedrock usage. Lives only in the sidecar.
export interface AgentTurnUsage {
  turnIndex: number;
  inputTokens: number;
  outputTokens: number;
}

// Sidecar payload for Writing and Practice sessions. Carries the raw Bedrock
// conversation needed to resume a multi-turn session, plus per-turn usage.
// Never returned to the frontend. See ADR 0004.
export interface AgentSidecar {
  bedrockMessages: BedrockMessage[];
  usagePerTurn: AgentTurnUsage[];
}

const s3 = new S3Client({});

const bucketName = (): string => {
  const bucket = process.env.S3_BUCKET_NAME;
  if (!bucket) throw new Error("S3_BUCKET_NAME environment variable is not set");
  return bucket;
};

const sessionKey = (studentId: string, sessionId: string): string =>
  `sessions/${studentId}/${sessionId}.json`;

const sidecarKey = (studentId: string, sessionId: string): string =>
  `sessions/${studentId}/${sessionId}.agent.json`;

export const saveSession = async (session: Session): Promise<void> => {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: sessionKey(session.studentId, session.sessionId),
      Body: JSON.stringify(session),
      ContentType: "application/json",
    }),
  );
  logger.info("session_save", {
    sessionId: session.sessionId,
    sessionType: session.sessionType,
  });
};

export const loadSession = async (
  studentId: string,
  sessionId: string,
): Promise<Session | null> => {
  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: bucketName(),
        Key: sessionKey(studentId, sessionId),
      }),
    );
    const body = await response.Body?.transformToString("utf-8");
    if (!body) return null;
    return JSON.parse(body) as Session;
  } catch (err) {
    if ((err as { name?: string }).name === "NoSuchKey") return null;
    throw err;
  }
};

const isSessionKey = (key: string): boolean =>
  key.endsWith(".json") && !key.endsWith(".agent.json");

export const listSessions = async (
  studentId: string,
  cursor?: string,
  limit = 10,
): Promise<SessionPage> => {
  const bucket = bucketName();
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
      isSessionKey(obj.Key) &&
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
      return JSON.parse(body) as Session;
    }),
  );

  const valid = sessions.filter((s): s is Session => s !== null);
  logger.info("list_sessions", { studentId, count: valid.length });
  return { sessions: valid, nextCursor };
};

export const saveAgentSidecar = async (
  studentId: string,
  sessionId: string,
  sidecar: AgentSidecar,
): Promise<void> => {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: sidecarKey(studentId, sessionId),
      Body: JSON.stringify(sidecar),
      ContentType: "application/json",
    }),
  );
};

export const uploadSessionImages = async (
  studentId: string,
  sessionId: string,
  images: string[],
  // Lets multi-turn sessions (Writing) namespace images per turn role
  // (e.g. "prompt-image", "draft-2-image"). Defaults to "image".
  prefix: string = "image",
): Promise<string[]> => {
  if (images.length === 0) return [];
  const bucket = bucketName();

  return Promise.all(
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
};

export const loadAgentSidecar = async (
  studentId: string,
  sessionId: string,
): Promise<AgentSidecar | null> => {
  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: bucketName(),
        Key: sidecarKey(studentId, sessionId),
      }),
    );
    const body = await response.Body?.transformToString("utf-8");
    if (!body) return null;
    return JSON.parse(body) as AgentSidecar;
  } catch (err) {
    if ((err as { name?: string }).name === "NoSuchKey") return null;
    throw err;
  }
};
