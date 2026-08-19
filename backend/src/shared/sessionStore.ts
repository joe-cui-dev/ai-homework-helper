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

interface SessionListCursor {
  /** Ordered membership captured on the first page; new activity cannot reorder it. */
  remainingSessionIds: string[];
}

export interface SessionWithVersion {
  session: Session;
  eTag: string | undefined;
}

export interface HomeworkSubmissionClaim {
  status: "processing" | "failed" | "complete";
  payloadHash: string;
  ownerAttemptId: string;
  leaseExpiresAt: string;
  updatedAt: string;
  version: number;
}

export type AcquireHomeworkSubmissionClaimResult =
  | { kind: "acquired"; claim: HomeworkSubmissionClaim; eTag: string | undefined }
  | { kind: "in_progress"; claim: HomeworkSubmissionClaim }
  | { kind: "complete"; claim: HomeworkSubmissionClaim }
  | { kind: "payload_mismatch"; claim: HomeworkSubmissionClaim };

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

const homeworkSubmissionClaimKey = (
  studentId: string,
  sessionId: string,
  submissionId: string,
): string => `sessions/${studentId}/homework/${sessionId}/submission-${submissionId}.claim`;

const isConditionalConflict = (err: unknown): boolean => {
  const name = (err as { name?: string }).name;
  return name === "PreconditionFailed" || name === "ConditionalRequestConflict";
};

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
    if (isConditionalConflict(err)) {
      throw Object.assign(new Error("Session was updated concurrently"), { code: "conflict" });
    }
    throw err;
  }
};

const loadHomeworkSubmissionClaim = async (
  studentId: string,
  sessionId: string,
  submissionId: string,
): Promise<{ claim: HomeworkSubmissionClaim; eTag: string | undefined } | null> => {
  try {
    const response = await s3.send(new GetObjectCommand({
      Bucket: bucketName(),
      Key: homeworkSubmissionClaimKey(studentId, sessionId, submissionId),
    }));
    const body = await response.Body?.transformToString("utf-8");
    return body ? { claim: JSON.parse(body) as HomeworkSubmissionClaim, eTag: response.ETag } : null;
  } catch (err) {
    if ((err as { name?: string }).name === "NoSuchKey") return null;
    throw err;
  }
};

export const updateHomeworkSubmissionClaim = async (input: {
  studentId: string;
  sessionId: string;
  submissionId: string;
  claim: HomeworkSubmissionClaim;
  eTag: string | undefined;
}): Promise<string | undefined> => {
  const response = await s3.send(new PutObjectCommand({
    Bucket: bucketName(),
    Key: homeworkSubmissionClaimKey(input.studentId, input.sessionId, input.submissionId),
    Body: JSON.stringify(input.claim),
    ContentType: "application/json",
    ...(input.eTag ? { IfMatch: input.eTag } : { IfNoneMatch: "*" }),
  }));
  return response.ETag;
};

/** Claims a submission before any model/image work. Failed or expired leases are reclaimable. */
export const acquireHomeworkSubmissionClaim = async (input: {
  studentId: string;
  sessionId: string;
  submissionId: string;
  payloadHash: string;
  ownerAttemptId: string;
  now: string;
  leaseExpiresAt: string;
}): Promise<AcquireHomeworkSubmissionClaimResult> => {
  const fresh: HomeworkSubmissionClaim = {
    status: "processing",
    payloadHash: input.payloadHash,
    ownerAttemptId: input.ownerAttemptId,
    leaseExpiresAt: input.leaseExpiresAt,
    updatedAt: input.now,
    version: 1,
  };
  try {
    const eTag = await updateHomeworkSubmissionClaim({ ...input, claim: fresh, eTag: undefined });
    return { kind: "acquired", claim: fresh, eTag };
  } catch (err) {
    if (!isConditionalConflict(err)) throw err;
  }

  const loaded = await loadHomeworkSubmissionClaim(input.studentId, input.sessionId, input.submissionId);
  if (!loaded) {
    // The object disappeared between the failed create and read. Let the caller
    // retry rather than starting expensive work without ownership.
    return { kind: "in_progress", claim: fresh };
  }
  if (loaded.claim.payloadHash !== input.payloadHash) {
    return { kind: "payload_mismatch", claim: loaded.claim };
  }
  if (loaded.claim.status === "complete") return { kind: "complete", claim: loaded.claim };

  const leaseIsLive = loaded.claim.status === "processing" && Date.parse(loaded.claim.leaseExpiresAt) > Date.parse(input.now);
  if (leaseIsLive) return { kind: "in_progress", claim: loaded.claim };

  const reclaimed: HomeworkSubmissionClaim = {
    ...fresh,
    version: loaded.claim.version + 1,
  };
  try {
    const eTag = await updateHomeworkSubmissionClaim({ ...input, claim: reclaimed, eTag: loaded.eTag });
    return { kind: "acquired", claim: reclaimed, eTag };
  } catch (err) {
    if (isConditionalConflict(err)) return { kind: "in_progress", claim: loaded.claim };
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

  const allJsonKeys = list.Contents.filter(
    (obj): obj is typeof obj & { Key: string; LastModified: Date } =>
      obj.Key !== undefined &&
      isSessionKey(obj.Key) &&
      obj.LastModified !== undefined,
  ).sort((a, b) =>
    b.LastModified.getTime() - a.LastModified.getTime() || a.Key.localeCompare(b.Key),
  );

  let decodedCursor: SessionListCursor | null = null;
  let legacyOffset = 0;
  if (cursor) {
    const decoded = Buffer.from(cursor, "base64url").toString("utf-8");
    try {
      const parsed = JSON.parse(decoded) as SessionListCursor;
      if (Array.isArray(parsed.remainingSessionIds) && parsed.remainingSessionIds.every((id) => typeof id === "string" && !id.includes("/"))) decodedCursor = parsed;
    } catch {
      legacyOffset = Number.parseInt(decoded, 10) || 0;
    }
  }
  const byKey = new Map(allJsonKeys.map((item) => [item.Key, item]));
  const orderedKeys = decodedCursor
    ? decodedCursor.remainingSessionIds
        .map((sessionId) => byKey.get(sessionKey(studentId, sessionType, sessionId)))
        .filter((item): item is (typeof allJsonKeys)[number] => item !== undefined)
    : allJsonKeys.slice(legacyOffset);
  const page = orderedKeys.slice(0, limit);
  const remainingSessionIds = orderedKeys.slice(limit).map((item) => item.Key.slice(item.Key.lastIndexOf("/") + 1, -".json".length));
  const nextCursor = remainingSessionIds.length > 0
    ? Buffer.from(JSON.stringify({ remainingSessionIds } satisfies SessionListCursor)).toString("base64url")
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

export interface StoredImage {
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  data: Uint8Array;
}

/** Loads only a key already selected from an authenticated Session. */
export const loadSessionImage = async (imageKey: string): Promise<StoredImage> => {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucketName(), Key: imageKey }));
  const mediaType = response.ContentType;
  if (!mediaType || !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mediaType)) {
    throw new Error("Stored homework image has an unsupported content type.");
  }
  const data = await response.Body?.transformToByteArray();
  if (!data) throw new Error("Stored homework image is empty.");
  return { mediaType: mediaType as StoredImage["mediaType"], data };
};

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
