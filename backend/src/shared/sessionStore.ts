// ── Session storage ───────────────────────────────────────────────────────────
// Persists Session records (discriminated union over sessionType) to S3.
//
// Key layout (see ADR 0005, supersedes the layout in ADR 0004):
//   sessions/{studentId}/{sessionType}/{sessionId}.json          ← user-facing Session
//   sessions/{studentId}/{sessionType}/{sessionId}.agent.json    ← Bedrock sidecar (Writing/Practice)
//   sessions/{studentId}/{sessionType}/{sessionId}/image-*.{ext} ← uploaded images
//
// 30-day S3 lifecycle ages everything out.
// ─────────────────────────────────────────────────────────────────────────────
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import type { Session, SessionType } from "./session";
import type { BedrockMessage } from "./bedrock";
import { normaliseModelChoice } from "./modelChoice";
import { logger } from "./logger";

export interface SessionPage {
  sessions: Session[];
  nextCursor: string | null;
}

export interface SessionWithVersion {
  session: Session;
  eTag: string | undefined;
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

const sessionKey = (
  studentId: string,
  sessionType: SessionType,
  sessionId: string,
): string => `sessions/${studentId}/${sessionType}/${sessionId}.json`;

const sidecarKey = (
  studentId: string,
  sessionType: SessionType,
  sessionId: string,
): string => `sessions/${studentId}/${sessionType}/${sessionId}.agent.json`;

const normaliseSession = (raw: unknown): Session => {
  const session = raw as Session;
  return {
    ...session,
    modelChoice: normaliseModelChoice(
      (session as Session & { modelChoice?: unknown }).modelChoice,
    ),
  };
};

export const saveSession = async (session: Session): Promise<void> => {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: sessionKey(session.studentId, session.sessionType, session.sessionId),
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
  sessionType: SessionType,
  sessionId: string,
): Promise<Session | null> => {
  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: bucketName(),
        Key: sessionKey(studentId, sessionType, sessionId),
      }),
    );
    const body = await response.Body?.transformToString("utf-8");
    if (!body) return null;
    return normaliseSession(JSON.parse(body));
  } catch (err) {
    if ((err as { name?: string }).name === "NoSuchKey") return null;
    throw err;
  }
};

/** Loads a session together with the S3 version used for an atomic mutation. */
export const loadSessionWithVersion = async (
  studentId: string,
  sessionType: SessionType,
  sessionId: string,
): Promise<SessionWithVersion | null> => {
  try {
    const response = await s3.send(new GetObjectCommand({
      Bucket: bucketName(), Key: sessionKey(studentId, sessionType, sessionId),
    }));
    const body = await response.Body?.transformToString("utf-8");
    return body ? { session: normaliseSession(JSON.parse(body)), eTag: response.ETag } : null;
  } catch (err) {
    if ((err as { name?: string }).name === "NoSuchKey") return null;
    throw err;
  }
};

/** Writes only if the object still has the version observed by the caller. */
export const saveSessionIfVersion = async (
  session: Session,
  eTag: string | undefined,
): Promise<void> => {
  try {
    await s3.send(new PutObjectCommand({
      Bucket: bucketName(),
      Key: sessionKey(session.studentId, session.sessionType, session.sessionId),
      Body: JSON.stringify(session),
      ContentType: "application/json",
      ...(eTag ? { IfMatch: eTag } : { IfNoneMatch: "*" }),
    }));
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "PreconditionFailed" || name === "ConditionalRequestConflict") {
      throw Object.assign(new Error("Session was updated concurrently"), { code: "conflict" });
    }
    throw err;
  }
};

const isSessionKey = (key: string): boolean =>
  key.endsWith(".json") && !key.endsWith(".agent.json");

export const listSessions = async (
  studentId: string,
  sessionType: SessionType,
  cursor?: string,
  limit = 10,
): Promise<SessionPage> => {
  const bucket = bucketName();
  const list = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `sessions/${studentId}/${sessionType}/`,
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
      return normaliseSession(JSON.parse(body));
    }),
  );

  const valid = sessions.filter((s): s is Session => s !== null);
  logger.info("list_sessions", { studentId, count: valid.length });
  return { sessions: valid, nextCursor };
};

export const saveAgentSidecar = async (
  studentId: string,
  sessionType: SessionType,
  sessionId: string,
  sidecar: AgentSidecar,
): Promise<void> => {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: sidecarKey(studentId, sessionType, sessionId),
      Body: JSON.stringify(sidecar),
      ContentType: "application/json",
    }),
  );
};

export const uploadSessionImages = async (
  studentId: string,
  sessionType: SessionType,
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
      const key = `sessions/${studentId}/${sessionType}/${sessionId}/${prefix}-${i}.${ext}`;
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

/** Page-submission image keys never collide with earlier submissions. */
export const uploadHomeworkSubmissionImages = async (
  studentId: string,
  sessionId: string,
  submissionId: string,
  images: string[],
): Promise<string[]> => uploadSessionImages(studentId, "homework", sessionId, images, `submission-${submissionId}-image`);

export const loadAgentSidecar = async (
  studentId: string,
  sessionType: SessionType,
  sessionId: string,
): Promise<AgentSidecar | null> => {
  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: bucketName(),
        Key: sidecarKey(studentId, sessionType, sessionId),
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
