import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { logger } from "./logger";

const s3 = new S3Client({});

export const saveSession = async (
  sessionId: string,
  data: object,
  studentId?: string,
): Promise<void> => {
  const bucket = process.env.S3_BUCKET_NAME;
  if (!bucket) {
    throw new Error("S3_BUCKET_NAME environment variable is not set");
  }

  const key = studentId
    ? `sessions/${studentId}/${sessionId}.json`
    : `sessions/${sessionId}.json`;

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(data),
      ContentType: "application/json",
    }),
  );
  logger.info("session_save", { key });
};

export const getRecentSessions = async (
  studentId: string,
  limit = 3,
): Promise<object[]> => {
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

  const recentKeys = list.Contents.sort(
    (a, b) =>
      (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0),
  )
    .slice(0, limit)
    .filter(
      (obj): obj is typeof obj & { Key: string } => obj.Key !== undefined,
    );

  const sessions = await Promise.all(
    recentKeys.map(async (obj) => {
      const response = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: obj.Key }),
      );
      const body = await response.Body?.transformToString("utf-8");
      return body ? (JSON.parse(body) as object) : null;
    }),
  );

  const result = sessions.filter((s): s is object => s !== null);
  logger.info("sessions_fetched", { studentId, count: result.length });
  return result;
};
