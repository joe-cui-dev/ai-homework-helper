// ── Lambda entry point ───────────────────────────────────────────────────────
// Handles every HTTPS POST from the frontend browser.
//
// Request flow:
//   1. Verify the Cognito Bearer token — reject immediately if invalid.
//   2. Validate and sanitise all uploaded images and the optional text question.
//   3. Call analyzePages() — a single Claude vision call that identifies every
//      question across all uploaded images and extracts any reading passage.
//   4. Solve each identified question sequentially with runAgent(), streaming
//      question_start / tool_start / tool_end / question_complete events.
//   5. Emit a final complete event carrying all results, then save each
//      question's answer to S3 for session history.
// ─────────────────────────────────────────────────────────────────────────────
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { v4 as uuidv4 } from "uuid";
import { runAgent, AlreadyReportedError } from "./agent";
import { analyzePages } from "./analyzer";
import { saveSession, uploadSessionImages } from "./storage";
import type { StreamEvent, QuestionResult } from "./types";
import { logger } from "./logger";

// Verifier is created once at cold-start; it caches JWKS automatically.
const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID ?? "",
  clientId: process.env.COGNITO_APP_CLIENT_ID ?? "",
  tokenUse: "access",
});

// Content-Type for the streaming response.
// CORS headers (Access-Control-Allow-Origin etc.) are injected automatically
// by the Lambda Function URL CORS config defined in CDK — setting them here
// too would produce duplicate header values and cause browser CORS errors.
const RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "application/x-ndjson",
};

const IMAGE_REGEX = /^data:image\/(jpeg|png|gif|webp);base64,/;
// ~2 MB raw image → ~2.8 MB base64. Keeps a single image well under Lambda's
// 6 MB request body limit even after JSON framing.
const MAX_IMAGE_B64_LENGTH = 2_800_000;
const MAX_IMAGES = 5;
// Total base64 budget across all images: ~4 MB raw, leaving headroom for JSON
// framing and the question text inside Lambda's 6 MB request body ceiling.
const MAX_TOTAL_B64_LENGTH = 5_500_000;

function validateImage(image: unknown, index: number): string {
  if (typeof image !== "string" || !IMAGE_REGEX.test(image)) {
    throw Object.assign(new Error(`Image ${index + 1}: invalid format`), { userFacing: true });
  }
  const base64Data = image.split(",")[1] ?? "";
  if (base64Data.length > MAX_IMAGE_B64_LENGTH) {
    throw Object.assign(new Error(`Image ${index + 1} must be under 2 MB`), { userFacing: true });
  }
  return image;
}

export const handler = awslambda.streamifyResponse(
  async (event: APIGatewayProxyEventV2, responseStream, context) => {
    logger.addContext(context);
    // Attach HTTP metadata (status 200 + headers) before the first write.
    // For validation errors we still respond 200 and write an error event —
    // this is idiomatic for streaming APIs where the status code is fixed at
    // stream-open time.
    const httpStream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: RESPONSE_HEADERS,
    });

    const writeEvent = (evt: StreamEvent): void => {
      httpStream.write(JSON.stringify(evt) + "\n");
    };

    try {
      // ── Authentication ──────────────────────────────────────────────────
      const authHeader =
        event.headers?.["authorization"] ??
        event.headers?.["Authorization"] ??
        "";
      const bearerToken = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : "";

      if (!bearerToken) {
        logger.warn("auth_missing_token");
        writeEvent({ type: "error", message: "Missing Authorization header" });
        return;
      }

      let tokenSub: string;
      try {
        const payload = await verifier.verify(bearerToken);
        tokenSub = payload.sub;
      } catch {
        logger.warn("auth_invalid_token");
        writeEvent({ type: "error", message: "Invalid or expired token" });
        return;
      }

      logger.appendKeys({ studentId: tokenSub });

      // ── Request parsing ─────────────────────────────────────────────────
      let body: { question?: unknown; image?: unknown; images?: unknown };
      try {
        body = JSON.parse(event.body ?? "{}") as {
          question?: unknown;
          image?: unknown;
          images?: unknown;
        };
      } catch {
        logger.warn("validation_invalid_json");
        writeEvent({ type: "error", message: "Invalid JSON body" });
        return;
      }

      const { question, image, images } = body;

      // Normalise: accept either `images` (array) or legacy `image` (single).
      const rawImages: unknown[] = Array.isArray(images)
        ? images
        : image != null
          ? [image]
          : [];

      if (rawImages.length > MAX_IMAGES) {
        logger.warn("validation_too_many_images", { count: rawImages.length });
        writeEvent({ type: "error", message: `Please upload at most ${MAX_IMAGES} images at a time` });
        return;
      }

      let validatedImages: string[];
      try {
        validatedImages = rawImages.map(validateImage);
      } catch (err) {
        logger.warn("validation_invalid_image", { message: (err as Error).message });
        writeEvent({ type: "error", message: (err as Error).message });
        return;
      }

      const totalB64 = validatedImages.reduce((sum, img) => sum + (img.split(",")[1]?.length ?? 0), 0);
      if (totalB64 > MAX_TOTAL_B64_LENGTH) {
        logger.warn("validation_total_payload_too_large", { totalB64 });
        writeEvent({ type: "error", message: "Total image size must be under 4 MB. Please use fewer or smaller photos." });
        return;
      }

      const trimmedQuestion =
        typeof question === "string" ? question.trim() : "";

      if (!trimmedQuestion && validatedImages.length === 0) {
        logger.warn("validation_missing_question");
        writeEvent({
          type: "error",
          message: "Please provide a question or an image",
        });
        return;
      }

      if (trimmedQuestion.length > 2000) {
        logger.warn("validation_question_too_long", { length: trimmedQuestion.length });
        writeEvent({
          type: "error",
          message: "Question must be 2000 characters or fewer",
        });
        return;
      }

      const resolvedStudentId = tokenSub;
      const batchId = uuidv4();

      logger.appendKeys({ batchId });
      logger.info("request_received", {
        imageCount: validatedImages.length,
        hasText: !!trimmedQuestion,
      });

      // ── Page analysis ───────────────────────────────────────────────────
      // Single Claude call that reads all images and extracts questions + article.
      const analysis = await analyzePages(validatedImages, trimmedQuestion);

      // Fallback: unreadable images / no questions detected.
      if (analysis.questions.length === 0) {
        logger.warn("analyzer_no_questions_found");
        writeEvent({ type: "error", message: "No questions were found in your submission. Please try a clearer photo." });
        return;
      }

      logger.info("analyzer_questions_found", { count: analysis.questions.length });

      // ── Sequential question solving ─────────────────────────────────────
      const allResults: QuestionResult[] = [];
      const total = analysis.questions.length;

      // Upload images once for the whole batch before solving any questions.
      // All questions share the same uploaded images — no duplicates.
      let batchImageKeys: string[] = [];
      try {
        batchImageKeys = await uploadSessionImages(resolvedStudentId, batchId, validatedImages);
      } catch (uploadErr) {
        logger.error("upload_images_failed", uploadErr instanceof Error ? uploadErr : String(uploadErr));
      }

      for (const q of analysis.questions) {
        logger.appendKeys({ questionId: q.id });

        writeEvent({ type: "question_start", questionId: q.id, total, text: q.text });

        // Use the specific page image if we know which page the question is on;
        // otherwise pass all images so Claude can orient itself.
        const questionImages =
          q.sourcePage !== undefined && validatedImages[q.sourcePage]
            ? [validatedImages[q.sourcePage]]
            : validatedImages;

        const result = await runAgent(
          q.text,
          resolvedStudentId,
          writeEvent,
          questionImages,
          q.usesArticle ? analysis.articleContext : undefined,
        );

        writeEvent({ type: "question_complete", questionId: q.id, result });
        allResults.push({ questionId: q.id, questionText: q.text, result });

        logger.info("question_complete", {
          subject: result.subject,
          difficulty: result.difficulty,
        });
      }

      // Save one batch session JSON after all questions are solved.
      // Non-critical — a storage failure must not overwrite the answer already
      // shown to the student with an error banner.
      try {
        await saveSession(
          batchId,
          {
            timestamp: new Date().toISOString(),
            questions: allResults.map((r) => ({
              input: r.questionText,
              subject: r.result.subject,
              difficulty: r.result.difficulty,
              answer: r.result.answer,
              steps: r.result.steps,
              explanation: r.result.explanation,
              hints: r.result.hints,
            })),
          },
          resolvedStudentId,
          batchImageKeys.length ? batchImageKeys : undefined,
        );
      } catch (saveErr) {
        logger.error("save_session_failed", saveErr instanceof Error ? saveErr : String(saveErr));
      }

      writeEvent({ type: "complete", results: allResults });
      logger.info("request_complete", { questionCount: allResults.length });
    } catch (err) {
      if (err instanceof AlreadyReportedError) {
        logger.warn("error_already_reported", { message: err.message });
      } else {
        logger.error(
          "unhandled_error",
          err instanceof Error ? err : String(err),
        );
        writeEvent({
          type: "error",
          message: err instanceof Error ? err.message : "Internal server error",
        });
      }
    } finally {
      logger.resetKeys();
      httpStream.end();
    }
  },
);
