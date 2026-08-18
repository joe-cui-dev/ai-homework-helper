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
import { loadSessionWithVersion, saveSession, saveSessionIfVersion, uploadHomeworkSubmissionImages, uploadSessionImages } from "../shared/sessionStore";
import type { HomeworkSession } from "../shared/session";
import { reconcileSubmission } from "./reconcileSubmission";
import { generateCoachingPacketsFromContext } from "./coachingPacket";
import type { BatchPacket, StreamEvent } from "../shared/types";
import { parseOptionalModelChoice } from "../shared/modelChoice";
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
        kind?: unknown;
        sessionId?: unknown;
        submissionId?: unknown;
        question?: unknown;
        image?: unknown;
        images?: unknown;
        modelChoice?: unknown;
      };
      try {
        body = JSON.parse(event.body ?? "{}") as {
          question?: unknown;
          image?: unknown;
          images?: unknown;
          modelChoice?: unknown;
        };
      } catch {
        logger.warn("validation_invalid_json");
        writeEvent({ type: "error", message: "Invalid JSON body" });
        return;
      }

      const { question, image, images } = body;
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

      // ── Append an immutable Page Submission to the current Session ──────
      if (body.kind === "append_pages") {
        const appendSessionId = typeof body.sessionId === "string" ? body.sessionId : "";
        const submissionId = typeof body.submissionId === "string" ? body.submissionId : "";
        if (!appendSessionId || !submissionId || trimmedQuestion || validatedImages.length === 0) {
          writeEvent({ type: "error", code: "validation", message: "Adding pages requires a session, submission ID, and one or more images." });
          return;
        }
        const loaded = await loadSessionWithVersion(tokenSub, "homework", appendSessionId);
        if (!loaded || loaded.session.sessionType !== "homework") {
          writeEvent({ type: "error", code: "not_found", message: "This homework session is no longer available." });
          return;
        }
        const session = loaded.session;
        const payloadHash = require("crypto").createHash("sha256").update(validatedImages.join("\n")).digest("hex");
        const established = session.submissions?.find((submission) => submission.submissionId === submissionId);
        if (established) {
          if (established.payloadHash !== payloadHash) {
            writeEvent({ type: "error", code: "validation", message: "This submission ID belongs to different pages." });
            return;
          }
          writeEvent({ type: "complete", sessionId: session.sessionId, packets: session.questions.map((q) => ({ questionId: q.questionId, questionText: q.input, subject: q.subject, yearLevel: q.yearLevel, packet: q.packet })), usage: session.usage, modelChoice: session.modelChoice, pageCount: session.pages?.length ?? session.imageKeys?.length ?? 0, updatedQuestionIds: established.updatedQuestionIds, possiblyRepeatedQuestionIds: established.possiblyRepeatedQuestionIds });
          return;
        }
        const pageCount = session.pages?.length ?? session.imageKeys?.length ?? 0;
        if (pageCount + validatedImages.length > 10) {
          writeEvent({ type: "error", code: "page_limit", message: "A homework session can contain at most 10 pages." });
          return;
        }
        writeEvent({ type: "analyzing" });
        const { analysis, usage: analysisUsage } = await analyzePages(validatedImages, undefined, session.modelChoice);
        const pageIds = validatedImages.map(() => uuidv4());
        const reconciliation = reconcileSubmission(session.questions, analysis.questions.map((q) => ({ text: q.text, subject: q.subject, yearLevel: q.yearLevel, sourcePageIds: q.sourcePage === undefined ? pageIds : [pageIds[q.sourcePage]], relation: { kind: "new" as const, confidence: "high" as const } })));
        const changedIds = new Set([...reconciliation.addedQuestionIds, ...reconciliation.updatedQuestionIds]);
        const changed = reconciliation.questions.filter((q) => changedIds.has(q.questionId));
        const contexts = [...(session.pages?.map((page) => page.context.content) ?? []), ...(analysis.pageContexts ?? validatedImages.map(() => "Page context was unavailable."))];
        const packetResult = await generateCoachingPacketsFromContext(changed.map((q) => ({ id: q.questionId, text: q.input, usesArticle: false, subject: q.subject, yearLevel: q.yearLevel })), contexts, session.modelChoice);
        const packets = new Map(packetResult.packets.map((packet) => [packet.questionId, packet]));
        if (changed.some((q) => !packets.has(q.questionId))) throw new Error("Could not produce every coaching packet; no pages were added.");
        const imageKeys = await uploadHomeworkSubmissionImages(tokenSub, session.sessionId, submissionId, validatedImages);
        const now = new Date().toISOString();
        const questions = reconciliation.questions.map((q) => ({ ...q, packet: packets.get(q.questionId) ?? q.packet! }));
        const usage = sumUsage(session.usage, analysisUsage, packetResult.usage);
        const next: HomeworkSession = { ...session, updatedAt: now, usage, questions, pages: [...(session.pages ?? (session.imageKeys ?? []).map((imageKey, index) => ({ pageId: `legacy-${index}`, imageKey, context: { content: "Legacy page; unavailable for append." } }))), ...imageKeys.map((imageKey, index) => ({ pageId: pageIds[index], imageKey, context: { content: contexts[index] ?? "" } }))], submissions: [...(session.submissions ?? []), { submissionId, payloadHash, timestamp: now, pageIds, addedQuestionIds: reconciliation.addedQuestionIds, updatedQuestionIds: reconciliation.updatedQuestionIds, possiblyRepeatedQuestionIds: reconciliation.possiblyRepeatedQuestionIds, usage: sumUsage(analysisUsage, packetResult.usage) }] };
        await saveSessionIfVersion(next, loaded.eTag);
        writeEvent({ type: "complete", sessionId: next.sessionId, packets: next.questions.map((q) => ({ questionId: q.questionId, questionText: q.input, subject: q.subject, yearLevel: q.yearLevel, packet: q.packet })), usage: next.usage, modelChoice: next.modelChoice, pageCount: next.pages?.length ?? 0, updatedQuestionIds: reconciliation.updatedQuestionIds, possiblyRepeatedQuestionIds: reconciliation.possiblyRepeatedQuestionIds });
        return;
      }

      const studentId = tokenSub;
      const sessionId = uuidv4();

      logger.appendKeys({ sessionId });
      logger.info("request_received", {
        imageCount: validatedImages.length,
        hasText: !!trimmedQuestion,
        modelChoice,
      });

      // ── Page analysis ───────────────────────────────────────────────────
      writeEvent({ type: "analyzing" });
      const { analysis, usage: analyzeUsage } = await analyzePages(
        validatedImages,
        trimmedQuestion,
        modelChoice,
      );

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
            modelChoice,
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
          modelChoice,
          timestamp: now,
          updatedAt: now,
          usage: batchUsage,
          imageKeys: batchImageKeys,
          pages: batchImageKeys.map((imageKey, index) => ({
            pageId: `initial-${index}`, imageKey, context: { content: analysis.pageContexts?.[index] ?? "" },
          })),
          questions: allBatchPackets.map((p) => ({
            questionId: p.questionId,
            input: p.questionText,
            subject: p.subject,
            yearLevel: p.yearLevel,
            packet: p.packet,
            sourcePageIds: (() => {
              const sourcePage = analysis.questions.find((q) => q.id === p.questionId)?.sourcePage;
              return sourcePage === undefined ? [] : [`initial-${sourcePage}`];
            })(),
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
        modelChoice,
        pageCount: batchImageKeys.length,
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
