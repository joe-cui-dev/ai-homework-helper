// ── Lambda entry point ───────────────────────────────────────────────────────
// Phase 1: deterministic Coaching Packet generation. No agent loop here.
//
// Request flow:
//   1. Verify Cognito Bearer token.
//   2. Validate uploaded images and optional text question.
//   3. Emit `analyzing` → call analyzePages() to identify questions + article.
//   4. Emit `packet_start` for every identified question (optimistic placeholders).
//   5. Single call to generateCoachingPackets() with all images, all questions,
//      optional article — produces one CoachingPacket per question.
//   6. Emit `packet_complete` per packet, then a final `complete` event.
//   7. Persist the batch session to S3.
// ─────────────────────────────────────────────────────────────────────────────
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { v4 as uuidv4 } from "uuid";
import { analyzePages } from "./analyzer";
import {
  chunkQuestionsForPacketCall,
  generateCoachingPackets,
} from "./coachingPacket";
import { saveSession, uploadSessionImages } from "./storage";
import type { BatchPacket, StreamEvent } from "./types";
import { logger } from "./logger";

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID ?? "",
  clientId: process.env.COGNITO_APP_CLIENT_ID ?? "",
  tokenUse: "access",
});

const RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "application/x-ndjson",
};

const IMAGE_REGEX = /^data:image\/(jpeg|png|gif|webp);base64,/;
const MAX_IMAGE_B64_LENGTH = 2_800_000;
const MAX_IMAGES = 5;
const MAX_TOTAL_B64_LENGTH = 5_500_000;

function validateImage(image: unknown, index: number): string {
  if (typeof image !== "string" || !IMAGE_REGEX.test(image)) {
    throw Object.assign(new Error(`Image ${index + 1}: invalid format`), {
      userFacing: true,
    });
  }
  const base64Data = image.split(",")[1] ?? "";
  if (base64Data.length > MAX_IMAGE_B64_LENGTH) {
    throw Object.assign(new Error(`Image ${index + 1} must be under 2 MB`), {
      userFacing: true,
    });
  }
  return image;
}

export const handler = awslambda.streamifyResponse(
  async (event: APIGatewayProxyEventV2, responseStream, context) => {
    logger.addContext(context);
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

      const rawImages: unknown[] = Array.isArray(images)
        ? images
        : image != null
          ? [image]
          : [];

      if (rawImages.length > MAX_IMAGES) {
        logger.warn("validation_too_many_images", { count: rawImages.length });
        writeEvent({
          type: "error",
          message: `Please upload at most ${MAX_IMAGES} images at a time`,
        });
        return;
      }

      let validatedImages: string[];
      try {
        validatedImages = rawImages.map(validateImage);
      } catch (err) {
        logger.warn("validation_invalid_image", {
          message: (err as Error).message,
        });
        writeEvent({ type: "error", message: (err as Error).message });
        return;
      }

      const totalB64 = validatedImages.reduce(
        (sum, img) => sum + (img.split(",")[1]?.length ?? 0),
        0,
      );
      if (totalB64 > MAX_TOTAL_B64_LENGTH) {
        logger.warn("validation_total_payload_too_large", { totalB64 });
        writeEvent({
          type: "error",
          message:
            "Total image size must be under 4 MB. Please use fewer or smaller photos.",
        });
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
        logger.warn("validation_question_too_long", {
          length: trimmedQuestion.length,
        });
        writeEvent({
          type: "error",
          message: "Question must be 2000 characters or fewer",
        });
        return;
      }

      const studentId = tokenSub;
      const batchId = uuidv4();

      logger.appendKeys({ batchId });
      logger.info("request_received", {
        imageCount: validatedImages.length,
        hasText: !!trimmedQuestion,
      });

      // ── Page analysis ───────────────────────────────────────────────────
      writeEvent({ type: "analyzing" });
      const analysis = await analyzePages(validatedImages, trimmedQuestion);

      if (analysis.questions.length === 0) {
        logger.warn("analyzer_no_questions_found");
        writeEvent({
          type: "error",
          message:
            "No questions were found in your submission. Please try a clearer photo.",
        });
        return;
      }

      logger.info("analyzer_questions_found", {
        count: analysis.questions.length,
      });

      // Optimistic placeholders: emit one packet_start per identified question
      // up front so the UI can render skeleton cards before the big call returns.
      const total = analysis.questions.length;
      for (const q of analysis.questions) {
        writeEvent({
          type: "packet_start",
          batchId,
          questionId: q.id,
          total,
          text: q.text,
        });
      }

      // Upload images once for the whole batch.
      let batchImageKeys: string[] = [];
      try {
        batchImageKeys = await uploadSessionImages(
          studentId,
          batchId,
          validatedImages,
        );
      } catch (uploadErr) {
        logger.error(
          "upload_images_failed",
          uploadErr instanceof Error ? uploadErr : String(uploadErr),
        );
      }

      // ── Coaching-packet generation (chunked, parallel) ──────────────────
      // Splits questions into chunks (by source page, then by size cap) so
      // that each Bedrock call stays under the output-token ceiling. All
      // chunks share the same article context.
      const chunks = chunkQuestionsForPacketCall(
        analysis.questions,
        validatedImages,
      );
      logger.info("packet_chunks", {
        chunkCount: chunks.length,
        chunkSizes: chunks.map((c) => c.questions.length),
      });

      const chunkResults = await Promise.all(
        chunks.map((chunk) =>
          generateCoachingPackets(
            chunk.images,
            chunk.questions,
            analysis.articleContext,
          ),
        ),
      );
      const packets = chunkResults.flat();

      // Index packets by questionId so we can join with the source question text.
      const packetsById = new Map(packets.map((p) => [p.questionId, p]));
      const allBatchPackets: BatchPacket[] = [];

      for (const q of analysis.questions) {
        const packet = packetsById.get(q.id);
        if (!packet) {
          logger.warn("missing_packet_for_question", { questionId: q.id });
          continue;
        }
        writeEvent({
          type: "packet_complete",
          questionId: q.id,
          packet,
        });
        allBatchPackets.push({
          questionId: q.id,
          questionText: q.text,
          packet,
        });
      }

      // Persist the batch.
      try {
        await saveSession(
          batchId,
          {
            timestamp: new Date().toISOString(),
            questions: allBatchPackets.map((p) => ({
              questionId: p.questionId,
              input: p.questionText,
              packet: p.packet,
            })),
          },
          studentId,
          batchImageKeys.length ? batchImageKeys : undefined,
        );
      } catch (saveErr) {
        logger.error(
          "save_session_failed",
          saveErr instanceof Error ? saveErr : String(saveErr),
        );
      }

      writeEvent({ type: "complete", batchId, packets: allBatchPackets });
      logger.info("request_complete", { packetCount: allBatchPackets.length });
    } catch (err) {
      logger.error(
        "unhandled_error",
        err instanceof Error ? err : String(err),
      );
      writeEvent({
        type: "error",
        message: err instanceof Error ? err.message : "Internal server error",
      });
    } finally {
      logger.resetKeys();
      httpStream.end();
    }
  },
);
