import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { parseOptionalModelChoice } from "../shared/modelChoice";
import { logger } from "../shared/logger";
import type { StreamEvent } from "../shared/types";
import { HomeworkSubmissionError, processHomeworkSubmission, type HomeworkSubmissionRequest } from "./submissionService";
import { parseSessionId, parseStudentId, parseSubmissionId } from "../shared/storageIdentifiers";

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID ?? "",
  clientId: process.env.COGNITO_APP_CLIENT_ID ?? "",
  tokenUse: "access",
});

const IMAGE_REGEX = /^data:image\/(jpeg|png|gif|webp);base64,/;
const MAX_IMAGE_B64_LENGTH = 2_800_000;
const MAX_IMAGES = 5;
const MAX_TOTAL_B64_LENGTH = 5_500_000;
const validationError = (message: string): HomeworkSubmissionError => new HomeworkSubmissionError(message, "validation");

const validateImage = (image: unknown, index: number): string => {
  if (typeof image !== "string" || !IMAGE_REGEX.test(image)) throw validationError(`Image ${index + 1}: invalid format`);
  if ((image.split(",")[1] ?? "").length > MAX_IMAGE_B64_LENGTH) throw validationError(`Image ${index + 1} must be under 2 MB`);
  return image;
};

const parseImages = (body: Record<string, unknown>): string[] => {
  const raw: unknown[] = Array.isArray(body.images) ? body.images : body.image != null ? [body.image] : [];
  if (raw.length > MAX_IMAGES) throw validationError(`Please upload at most ${MAX_IMAGES} images at a time`);
  const images = raw.map(validateImage);
  const totalB64 = images.reduce((sum, image) => sum + (image.split(",")[1]?.length ?? 0), 0);
  if (totalB64 > MAX_TOTAL_B64_LENGTH) throw validationError("Total image size must be under 4 MB. Please use fewer or smaller photos.");
  return images;
};

const parseRequest = (body: Record<string, unknown>): HomeworkSubmissionRequest => {
  const images = parseImages(body);
  if (body.kind === "append_pages") {
    const allowed = new Set(["kind", "sessionId", "submissionId", "images"]);
    if (Object.keys(body).some((key) => !allowed.has(key))) throw validationError("Append requests accept only sessionId, submissionId, and images.");
    if (typeof body.sessionId !== "string" || typeof body.submissionId !== "string" || images.length === 0) {
      throw validationError("Adding pages requires a session, submission ID, and one or more images.");
    }
    try {
      return { kind: "append_pages", sessionId: parseSessionId(body.sessionId), submissionId: parseSubmissionId(body.submissionId), images };
    } catch (error) {
      throw validationError(error instanceof Error ? error.message : "Invalid homework identifier.");
    }
  }
  if (body.kind !== "initial") throw validationError("Homework requests require an explicit kind discriminator.");
  const allowed = new Set(["kind", "question", "images", "modelChoice"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw validationError("Initial requests accept only question, images, and modelChoice.");
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question && images.length === 0) throw validationError("Please provide a question or an image");
  if (question.length > 2000) throw validationError("Question must be 2000 characters or fewer");
  return { kind: "initial", question, images, modelChoice: parseOptionalModelChoice(body.modelChoice) };
};

export const handler = awslambda.streamifyResponse(
  async (event: APIGatewayProxyEventV2, responseStream, context) => {
    logger.addContext(context);
    const httpStream = awslambda.HttpResponseStream.from(responseStream, { statusCode: 200, headers: { "Content-Type": "application/x-ndjson" } });
    const emit = (streamEvent: StreamEvent): void => { httpStream.write(`${JSON.stringify(streamEvent)}\n`); };
    try {
      const authHeader = event.headers?.authorization ?? event.headers?.Authorization ?? "";
      const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (!bearerToken) throw new HomeworkSubmissionError("Missing Authorization header", "validation");
      let studentId: string;
      try { studentId = parseStudentId((await verifier.verify(bearerToken)).sub); }
      catch { throw new HomeworkSubmissionError("Invalid or expired token", "validation"); }
      logger.appendKeys({ studentId });
      let body: Record<string, unknown>;
      try { body = JSON.parse(event.body ?? "{}") as Record<string, unknown>; }
      catch { throw validationError("Invalid JSON body"); }
      const request = parseRequest(body);
      logger.info("homework_submission_start", { kind: request.kind, imageCount: request.images.length, ...(request.kind === "append_pages" ? { sessionId: request.sessionId, submissionId: request.submissionId } : {}) });
      await processHomeworkSubmission({ studentId, request, emit });
    } catch (error) {
      logger.error("homework_submission_failed", error instanceof Error ? error : String(error));
      const known = error instanceof HomeworkSubmissionError ? error : null;
      emit({ type: "error", code: known?.code ?? "processing_failure", retryable: known?.retryable ?? true, message: error instanceof Error ? error.message : "Internal server error" });
    } finally {
      logger.resetKeys();
      httpStream.end();
    }
  },
);
