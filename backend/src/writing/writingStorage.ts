// ── Writing Session storage ──────────────────────────────────────────────────
// One JSON object per session at sessions/{studentId}/{batchId}.json. Mutated
// across HTTP requests (read-modify-write per turn). _internal carries Bedrock
// state and per-turn raw usage — history reader skips it. See ADR 0003.
//
// Lazy stale-flip: sessions older than WRITING_SESSION_MAX_AGE_HOURS since
// updatedAt are flipped to status="ended", endedReason="abandoned" on next
// read, mirroring practiceStorage.
// ─────────────────────────────────────────────────────────────────────────────
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  NoSuchKey,
} from "@aws-sdk/client-s3";
import type { BedrockMessage } from "../shared/bedrock";
import type { WritingSessionRecord } from "../shared/types";
import { logger } from "../shared/logger";

const s3 = new S3Client({});

export const WRITING_SESSION_MAX_AGE_HOURS = 24;
export const MAX_DRAFT_TURNS = 5;
export const MAX_QUESTION_TURNS = 3;

const bucket = (): string => {
  const b = process.env.S3_BUCKET_NAME;
  if (!b) throw new Error("S3_BUCKET_NAME environment variable is not set");
  return b;
};

const sessionKey = (studentId: string, batchId: string): string =>
  `sessions/${studentId}/${batchId}.json`;

const isStale = (record: WritingSessionRecord): boolean => {
  if (record.status === "ended") return false;
  const ageMs = Date.now() - new Date(record.updatedAt).getTime();
  return ageMs > WRITING_SESSION_MAX_AGE_HOURS * 3600 * 1000;
};

export interface WritingSessionLocator {
  studentId: string;
  batchId: string;
}

// Load a writing session by batchId. Performs lazy stale-flip: if the session
// is "active" but older than 24 h, flips to ended/abandoned and persists
// before returning. Throws if the session does not exist or belongs to
// another student.
export const loadWritingSession = async (
  loc: WritingSessionLocator,
): Promise<WritingSessionRecord> => {
  let response;
  try {
    response = await s3.send(
      new GetObjectCommand({
        Bucket: bucket(),
        Key: sessionKey(loc.studentId, loc.batchId),
      }),
    );
  } catch (err) {
    if (err instanceof NoSuchKey || (err as { name?: string }).name === "NoSuchKey") {
      const error = new Error("Writing session not found.");
      (error as { code?: string }).code = "NOT_FOUND";
      throw error;
    }
    throw err;
  }
  const body = await response.Body?.transformToString("utf-8");
  if (!body) throw new Error("Writing session is empty.");
  const record = JSON.parse(body) as WritingSessionRecord;

  // Defensive: a session at this path may have been written by Homework or
  // Reading. Reject so callers don't accidentally mutate a non-Writing record.
  if (record.sessionType !== "writing") {
    const error = new Error(
      "This session is not a writing session.",
    );
    (error as { code?: string }).code = "WRONG_TYPE";
    throw error;
  }

  // Tenancy check: studentId on the record must match the caller. If the
  // record is missing studentId (legacy or partial write), refuse.
  if (record.studentId !== loc.studentId) {
    const error = new Error("Writing session not found.");
    (error as { code?: string }).code = "NOT_FOUND";
    throw error;
  }

  // Self-heal sessions persisted before image-block redaction landed: any
  // image block whose `bytes` is no longer a Buffer/Uint8Array (e.g. the
  // JSON.parse-revived {type:"Buffer", data:[]} shape) gets replaced with a
  // text placeholder. Without this, the AWS SDK throws
  //   "@smithy/util-base64: toBase64 encoder function only accepts string |
  //    Uint8Array"
  // on the next turn that replays history.
  if (record._internal?.messages?.length) {
    record._internal.messages = sanitiseHistoryMessages(
      record._internal.messages,
    );
  }

  if (isStale(record)) {
    record.status = "ended";
    record.endedReason = "abandoned";
    await saveWritingSession(record);
    logger.info("writing_session_auto_abandoned", {
      sessionId: record.sessionId,
    });
  }

  return record;
};

// Save the full session record (including _internal). Atomic at the S3 object
// level — read-modify-write inside the Lambda is safe so long as we don't
// have concurrent turns for the same session, which the UI wizard prevents.
// Replace any image content block whose `bytes` is not a real Buffer/Uint8Array
// with a text placeholder. Detects the failure mode where Buffer was
// JSON.stringify'd to {type:"Buffer", data:[...]} and JSON.parse'd back as a
// plain object — which the AWS SDK's base64 encoder can't accept on a replay.
const sanitiseHistoryMessages = (
  messages: BedrockMessage[],
): BedrockMessage[] => {
  let healedCount = 0;
  const out = messages.map((msg) => {
    const content = (msg.content ?? []).map((block) => {
      const b = block as Record<string, unknown>;
      const image = b.image as
        | { source?: { bytes?: unknown } }
        | undefined;
      if (image) {
        const bytes = image.source?.bytes;
        const isUsable =
          bytes instanceof Uint8Array || typeof bytes === "string";
        if (!isUsable) {
          healedCount += 1;
          return { text: "[image from earlier turn omitted from history]" };
        }
      }
      return block;
    });
    return { role: msg.role, content };
  });
  if (healedCount > 0) {
    logger.warn("writing_history_sanitised", { healedImages: healedCount });
  }
  return out;
};

export const saveWritingSession = async (
  record: WritingSessionRecord,
): Promise<void> => {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: sessionKey(record.studentId, record.sessionId),
      Body: JSON.stringify(record),
      ContentType: "application/json",
    }),
  );
  logger.info("writing_session_save", {
    sessionId: record.sessionId,
    status: record.status,
    draftCount: record.draftCount,
    questionCount: record.questionCount,
  });
};
