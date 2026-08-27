// ── Reading Lambda entry point ────────────────────────────────────────────────
// Two-step reading-comprehension packet generation.
//
// Request flow:
//   1. Verify Cognito Bearer token.
//   2. Validate uploaded images (cover + pages, max 8).
//   3. Emit `book_analyzing` → call analyzeBook() to judge sufficiency + year level.
//      If insufficient, stream `needs_more_pages` and exit without saving.
//   4. Emit `book_analyzed` → call generateReadingPackets() → 5 grounded packets.
//   5. Emit `reading_packet_complete` per packet, then `reading_complete`.
//   6. Persist the batch session to S3 with sessionType: "reading".
// ─────────────────────────────────────────────────────────────────────────────
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { v4 as uuidv4 } from "uuid";
import { sumUsage } from "../shared/bedrock";
import { analyzeBook } from "./bookAnalyzer";
import { generateReadingPackets } from "./readingPacket";
import { saveSession, uploadSessionImages } from "../shared/sessionStore";
import type { ReadingSession } from "../shared/session";
import type { ReadingBatchPacket, StreamEvent } from "../shared/types";
import { parseOptionalModelChoice, resolveBedrockModel } from "../shared/modelChoice";
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
const MAX_IMAGES = 8;
// Lambda Function URL request payload limit is ~6 MB; keep 5.5 MB margin for
// JSON envelope and headers.
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
      let body: { image?: unknown; images?: unknown; modelChoice?: unknown };
      try {
        body = JSON.parse(event.body ?? "{}") as {
          image?: unknown;
          images?: unknown;
          modelChoice?: unknown;
        };
      } catch {
        logger.warn("validation_invalid_json");
        writeEvent({ type: "error", message: "Invalid JSON body" });
        return;
      }

      const { image, images } = body;
      let modelChoice;
      try {
        modelChoice = parseOptionalModelChoice(body.modelChoice);
      } catch (err) {
        logger.warn("validation_invalid_model_choice", {
          message: (err as Error).message,
        });
        writeEvent({ type: "error", message: (err as Error).message });
        return;
      }

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

      if (validatedImages.length === 0) {
        logger.warn("validation_reading_missing_images");
        writeEvent({
          type: "error",
          message:
            "Please upload the book cover and a few pages of content to start a reading session.",
        });
        return;
      }

      const studentId = tokenSub;
      const sessionId = uuidv4();

      logger.appendKeys({ sessionId });
      logger.info("request_received", {
        imageCount: validatedImages.length,
        modelChoice,
      });

      // ── Book analysis ───────────────────────────────────────────────────
      writeEvent({ type: "book_analyzing" });
      const { analysis, usage: analyzeUsage } = await analyzeBook(
        validatedImages,
        modelChoice,
      );

      if (!analysis.pagesAreSufficient) {
        const message =
          analysis.insufficientReason ??
          "Please upload a few more pages of the book content so I can write good questions.";
        logger.info("reading_needs_more_pages", { message });
        writeEvent({ type: "needs_more_pages", message });
        return;
      }

      writeEvent({
        type: "book_analyzed",
        bookContext: analysis.bookContext,
        yearLevel: analysis.yearLevel,
      });

      // Upload images once for the whole batch.
      let batchImageKeys: string[] = [];
      try {
        batchImageKeys = await uploadSessionImages(
          studentId,
          "reading",
          sessionId,
          validatedImages,
        );
      } catch (uploadErr) {
        logger.error(
          "reading_upload_images_failed",
          uploadErr instanceof Error ? uploadErr : String(uploadErr),
        );
      }

      const { packets, usage: packetUsage } = await generateReadingPackets(
        validatedImages,
        analysis.bookContext,
        analysis.yearLevel,
        modelChoice,
      );

      if (packets.length === 0) {
        logger.warn("reading_no_packets_generated");
        writeEvent({
          type: "error",
          message:
            "I couldn't write reading questions for this book. Please try again or upload different pages.",
        });
        return;
      }

      const batchUsage = sumUsage(analyzeUsage, packetUsage);
      const readingBatchPackets: ReadingBatchPacket[] = [];

      for (const packet of packets) {
        writeEvent({
          type: "reading_packet_complete",
          questionId: packet.questionId,
          packet,
        });
        readingBatchPackets.push({ questionId: packet.questionId, packet });
      }

      try {
        const now = new Date().toISOString();
        const session: ReadingSession = {
          sessionType: "reading",
          sessionId,
          studentId,
          modelChoice,
          modelId: resolveBedrockModel(modelChoice).modelId,
          timestamp: now,
          updatedAt: now,
          usage: batchUsage,
          imageKeys: batchImageKeys,
          bookContext: analysis.bookContext,
          readingPackets: packets,
        };
        await saveSession(session);
      } catch (saveErr) {
        logger.error(
          "reading_save_session_failed",
          saveErr instanceof Error ? saveErr : String(saveErr),
        );
      }

      writeEvent({
        type: "reading_complete",
        sessionId,
        bookContext: analysis.bookContext,
        packets: readingBatchPackets,
        usage: batchUsage,
        modelChoice,
      });
      logger.info("reading_request_complete", {
        packetCount: packets.length,
      });
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
