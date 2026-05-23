// ── Homework Lambda entry point ───────────────────────────────────────────────
// Deterministic Coaching Packet generation for homework submissions.
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
import { sumUsage } from "../shared/bedrock";
import { analyzePages } from "./analyzer";
import {
  chunkQuestionsForPacketCall,
  generateCoachingPackets,
} from "./coachingPacket";
import { saveSession, uploadSessionImages } from "../shared/sessionStore";
import type { HomeworkSession } from "../shared/session";
import type { BatchPacket, StreamEvent } from "../shared/types";
import { logger } from "../shared/logger";

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
      let body: {
        question?: unknown;
        image?: unknown;
        images?: unknown;
      };
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
      const sessionId = uuidv4();

      logger.appendKeys({ sessionId });
      logger.info("request_received", {
        imageCount: validatedImages.length,
        hasText: !!trimmedQuestion,
      });

      // ── Page analysis ───────────────────────────────────────────────────
      writeEvent({ type: "analyzing" });
      const { analysis, usage: analyzeUsage } = await analyzePages(
        validatedImages,
        trimmedQuestion,
      );

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
          sessionId,
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
          "homework",
          sessionId,
          validatedImages,
        );
      } catch (uploadErr) {
        logger.error(
          "upload_images_failed",
          uploadErr instanceof Error ? uploadErr : String(uploadErr),
        );
      }

      // ── Coaching-packet generation (chunked, parallel) ──────────────────
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
      const packets = chunkResults.flatMap((r) => r.packets);
      const batchUsage = sumUsage(
        analyzeUsage,
        ...chunkResults.map((r) => r.usage),
      );
      logger.info("batch_usage", {
        inputTokens: batchUsage.inputTokens,
        outputTokens: batchUsage.outputTokens,
        costUsd: batchUsage.costUsd,
      });

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
          subject: q.subject,
          yearLevel: q.yearLevel,
          packet,
        });
        allBatchPackets.push({
          questionId: q.id,
          questionText: q.text,
          subject: q.subject,
          yearLevel: q.yearLevel,
          packet,
        });
      }

      // Persist the batch.
      try {
        const now = new Date().toISOString();
        const session: HomeworkSession = {
          sessionType: "homework",
          sessionId,
          studentId,
          timestamp: now,
          updatedAt: now,
          usage: batchUsage,
          imageKeys: batchImageKeys,
          questions: allBatchPackets.map((p) => ({
            questionId: p.questionId,
            input: p.questionText,
            subject: p.subject,
            yearLevel: p.yearLevel,
            packet: p.packet,
          })),
        };
        await saveSession(session);
      } catch (saveErr) {
        logger.error(
          "save_session_failed",
          saveErr instanceof Error ? saveErr : String(saveErr),
        );
      }

      writeEvent({
        type: "complete",
        sessionId,
        packets: allBatchPackets,
        usage: batchUsage,
      });
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
