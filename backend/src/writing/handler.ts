// ── Writing Lambda entry ─────────────────────────────────────────────────────
// Four POST routes on one Function URL, dispatched by event.rawPath:
//   POST /writing/start     { prompt: { text, images? } }
//   POST /writing/draft     { sessionId, draft: { text?, images? } }
//   POST /writing/question  { sessionId, question: string }
//   POST /writing/end       { sessionId }
//
// All routes:
//   - JWT-validated via Cognito (sub → studentId).
//   - NDJSON-streamed via awslambda.streamifyResponse.
//   - Persist the updated WritingSessionRecord to S3 before emitting the
//     terminal event so a client crash mid-write doesn't lose work.
// ─────────────────────────────────────────────────────────────────────────────
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { v4 as uuidv4 } from "uuid";
import {
  accumulateTurnUsage,
  redactImageBlocksForHistory,
  runDraftTurn,
  runPlanTurn,
  runQuestionTurn,
} from "./writing";
import {
  MAX_DRAFT_TURNS,
  MAX_QUESTION_TURNS,
  loadWritingBundle,
  saveWritingBundle,
} from "./writingStorage";
import { uploadSessionImages } from "../shared/sessionStore";
import type {
  WritingStreamEvent,
  YearLevel,
} from "../shared/types";
import type { WritingSession, WritingTurn } from "../shared/session";
import type { AgentSidecar } from "../shared/sessionStore";
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
const MAX_IMAGES_PROMPT = 5;
const MAX_IMAGES_DRAFT = 5;
const MAX_TOTAL_B64_LENGTH = 5_500_000;
const MAX_TEXT_LENGTH = 4000;

interface UserFacingError extends Error {
  userFacing?: boolean;
}

const userError = (msg: string): UserFacingError => {
  const e: UserFacingError = new Error(msg);
  e.userFacing = true;
  return e;
};

const validateImage = (image: unknown, index: number): string => {
  if (typeof image !== "string" || !IMAGE_REGEX.test(image)) {
    throw userError(`Image ${index + 1}: invalid format`);
  }
  const base64Data = image.split(",")[1] ?? "";
  if (base64Data.length > MAX_IMAGE_B64_LENGTH) {
    throw userError(`Image ${index + 1} must be under 2 MB`);
  }
  return image;
};

const validateImages = (
  images: unknown,
  cap: number,
): string[] => {
  const raw: unknown[] = Array.isArray(images) ? images : [];
  if (raw.length > cap) {
    throw userError(`Please upload at most ${cap} images at a time`);
  }
  const valid = raw.map(validateImage);
  const total = valid.reduce(
    (s, img) => s + (img.split(",")[1]?.length ?? 0),
    0,
  );
  if (total > MAX_TOTAL_B64_LENGTH) {
    throw userError(
      "Total image size must be under 4 MB. Please use fewer or smaller photos.",
    );
  }
  return valid;
};

const VALID_YEAR_LEVELS: readonly YearLevel[] = [
  "year-1",
  "year-2",
  "year-3",
  "year-4",
  "year-5",
  "year-6",
];

const validateYearLevel = (v: unknown): YearLevel | undefined => {
  if (v == null || v === "") return undefined;
  if (typeof v !== "string" || !VALID_YEAR_LEVELS.includes(v as YearLevel)) {
    throw userError(
      `yearLevel must be one of ${VALID_YEAR_LEVELS.join(", ")} or omitted`,
    );
  }
  return v as YearLevel;
};

const validateText = (text: unknown, fieldName: string): string => {
  if (text == null) return "";
  if (typeof text !== "string") {
    throw userError(`${fieldName} must be a string`);
  }
  const trimmed = text.trim();
  if (trimmed.length > MAX_TEXT_LENGTH) {
    throw userError(`${fieldName} must be ${MAX_TEXT_LENGTH} characters or fewer`);
  }
  return trimmed;
};

export const handler = awslambda.streamifyResponse(
  async (event: APIGatewayProxyEventV2, responseStream, context) => {
    logger.addContext(context);
    const httpStream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: RESPONSE_HEADERS,
    });

    const writeEvent = (evt: WritingStreamEvent): void => {
      httpStream.write(JSON.stringify(evt) + "\n");
    };

    try {
      // ── Auth ────────────────────────────────────────────────────────────
      const authHeader =
        event.headers?.["authorization"] ??
        event.headers?.["Authorization"] ??
        "";
      const bearerToken = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : "";
      if (!bearerToken) {
        writeEvent({ type: "error", message: "Missing Authorization header" });
        return;
      }
      let studentId: string;
      try {
        const payload = await verifier.verify(bearerToken);
        studentId = payload.sub;
      } catch {
        writeEvent({ type: "error", message: "Invalid or expired token" });
        return;
      }
      logger.appendKeys({ studentId });

      const path = event.rawPath ?? "";
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(event.body ?? "{}") as Record<string, unknown>;
      } catch {
        writeEvent({ type: "error", message: "Invalid JSON body" });
        return;
      }

      if (path.endsWith("/writing/start")) {
        await handleStart(body, studentId, writeEvent);
      } else if (path.endsWith("/writing/draft")) {
        await handleDraft(body, studentId, writeEvent);
      } else if (path.endsWith("/writing/question")) {
        await handleQuestion(body, studentId, writeEvent);
      } else if (path.endsWith("/writing/end")) {
        await handleEnd(body, studentId, writeEvent);
      } else {
        writeEvent({ type: "error", message: `Unknown route: ${path}` });
      }
    } catch (err) {
      logger.error(
        "writing_unhandled_error",
        err instanceof Error ? err : String(err),
      );
      const userFacing =
        err instanceof Error && (err as UserFacingError).userFacing;
      writeEvent({
        type: "error",
        message:
          userFacing && err instanceof Error
            ? err.message
            : err instanceof Error
              ? err.message
              : "Internal server error",
      });
    } finally {
      logger.resetKeys();
      httpStream.end();
    }
  },
);

// ── /writing/start ──────────────────────────────────────────────────────────
const handleStart = async (
  body: Record<string, unknown>,
  studentId: string,
  writeEvent: (evt: WritingStreamEvent) => void,
): Promise<void> => {
  const promptObj = (body.prompt ?? {}) as Record<string, unknown>;
  const promptText = validateText(promptObj.text, "prompt.text");
  const promptImages = validateImages(promptObj.images, MAX_IMAGES_PROMPT);
  const userYearLevel = validateYearLevel(body.yearLevel);

  if (!promptText && promptImages.length === 0) {
    writeEvent({
      type: "error",
      message: "Please provide the writing prompt as text or an image.",
    });
    return;
  }

  const sessionId = uuidv4();
  logger.appendKeys({ sessionId });
  logger.info("writing_start_request", {
    imageCount: promptImages.length,
    hasText: !!promptText,
  });

  // Upload prompt images first so the SessionRecord references stable S3 keys.
  let promptImageKeys: string[] = [];
  if (promptImages.length > 0) {
    try {
      promptImageKeys = await uploadSessionImages(
        studentId,
        sessionId,
        promptImages,
        "prompt-image",
      );
    } catch (uploadErr) {
      logger.error(
        "writing_upload_prompt_images_failed",
        uploadErr instanceof Error ? uploadErr : String(uploadErr),
      );
    }
  }

  const result = await runPlanTurn({ promptText, promptImages, userYearLevel });

  const now = new Date().toISOString();
  const session: WritingSession = {
    sessionId,
    studentId,
    sessionType: "writing",
    timestamp: now,
    updatedAt: now,
    status: "active",
    prompt: { input: promptText, imageKeys: promptImageKeys },
    plan: result.plan,
    turns: [],
    draftCount: 0,
    questionCount: 0,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  };
  const sidecar: AgentSidecar = {
    bedrockMessages: [
      // Redact image blocks before persistence — Buffer doesn't survive
      // S3 round-trip and would break base64 encoding on the next turn.
      redactImageBlocksForHistory(result.userMessage),
      result.assistantMessage,
      result.toolResultMessage,
    ],
    usagePerTurn: [],
  };
  accumulateTurnUsage(session, sidecar, 0, result.usage);

  await saveWritingBundle({ session, sidecar });

  writeEvent({
    type: "plan_complete",
    sessionId,
    plan: result.plan,
    usage: session.usage,
  });
};

// ── /writing/draft ──────────────────────────────────────────────────────────
const handleDraft = async (
  body: Record<string, unknown>,
  studentId: string,
  writeEvent: (evt: WritingStreamEvent) => void,
): Promise<void> => {
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (!sessionId) {
    writeEvent({ type: "error", message: "sessionId is required" });
    return;
  }
  const draftObj = (body.draft ?? {}) as Record<string, unknown>;
  const draftText = validateText(draftObj.text, "draft.text");
  const draftImages = validateImages(draftObj.images, MAX_IMAGES_DRAFT);
  if (!draftText && draftImages.length === 0) {
    writeEvent({
      type: "error",
      message: "Please provide the draft as text or an image.",
    });
    return;
  }

  let session: WritingSession;
  let sidecar: AgentSidecar;
  try {
    const bundle = await loadWritingBundle({ studentId, sessionId });
    session = bundle.session;
    sidecar = bundle.sidecar;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "NOT_FOUND" || code === "WRONG_TYPE") {
      writeEvent({ type: "error", message: "Writing session not found." });
      return;
    }
    throw err;
  }
  logger.appendKeys({ sessionId });

  if (session.status === "ended") {
    writeEvent({ type: "error", message: "This writing session has ended." });
    return;
  }
  if (session.draftCount >= MAX_DRAFT_TURNS) {
    writeEvent({ type: "limit_reached", kind: "draft", remaining: 0 });
    return;
  }

  // Upload draft images BEFORE the Bedrock call so even on failure we have a
  // record of what was submitted.
  let draftImageKeys: string[] = [];
  const turnIndex =
    1 + session.turns.length; // turn 0 was the plan turn; turns array indexes from 1
  if (draftImages.length > 0) {
    writeEvent({ type: "transcribing" });
    try {
      draftImageKeys = await uploadSessionImages(
        studentId,
        sessionId,
        draftImages,
        `draft-${turnIndex}-image`,
      );
    } catch (uploadErr) {
      logger.error(
        "writing_upload_draft_images_failed",
        uploadErr instanceof Error ? uploadErr : String(uploadErr),
      );
    }
  }

  const result = await runDraftTurn(session, sidecar.bedrockMessages, {
    draftText,
    draftImages,
  });

  const turn: WritingTurn = {
    kind: "draft",
    turnIndex,
    ts: new Date().toISOString(),
    input: {
      text: draftText || undefined,
      imageKeys: draftImageKeys.length ? draftImageKeys : undefined,
    },
    packet: result.packet,
  };
  session.turns.push(turn);
  session.draftCount += 1;
  session.updatedAt = turn.ts;
  sidecar.bedrockMessages.push(
    redactImageBlocksForHistory(result.userMessage),
    result.assistantMessage,
    result.toolResultMessage,
  );
  accumulateTurnUsage(session, sidecar, turnIndex, result.usage);

  // Auto-end on reaching the cap to spare the next turn's UX.
  if (session.draftCount >= MAX_DRAFT_TURNS) {
    session.status = "ended";
    session.endedReason = "max_drafts";
  }

  await saveWritingBundle({ session, sidecar });

  writeEvent({
    type: "feedback_complete",
    turnIndex,
    packet: result.packet,
    draftCount: session.draftCount,
    questionCount: session.questionCount,
    usage: session.usage,
  });
};

// ── /writing/question ───────────────────────────────────────────────────────
const handleQuestion = async (
  body: Record<string, unknown>,
  studentId: string,
  writeEvent: (evt: WritingStreamEvent) => void,
): Promise<void> => {
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (!sessionId) {
    writeEvent({ type: "error", message: "sessionId is required" });
    return;
  }
  const question = validateText(body.question, "question");
  if (!question) {
    writeEvent({
      type: "error",
      message: "Please type your question for the coach.",
    });
    return;
  }

  let session: WritingSession;
  let sidecar: AgentSidecar;
  try {
    const bundle = await loadWritingBundle({ studentId, sessionId });
    session = bundle.session;
    sidecar = bundle.sidecar;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "NOT_FOUND" || code === "WRONG_TYPE") {
      writeEvent({ type: "error", message: "Writing session not found." });
      return;
    }
    throw err;
  }
  logger.appendKeys({ sessionId });

  if (session.status === "ended") {
    writeEvent({ type: "error", message: "This writing session has ended." });
    return;
  }
  if (session.questionCount >= MAX_QUESTION_TURNS) {
    writeEvent({ type: "limit_reached", kind: "question", remaining: 0 });
    return;
  }

  const turnIndex = 1 + session.turns.length;
  const result = await runQuestionTurn(session, sidecar.bedrockMessages, { question });

  const turn: WritingTurn = {
    kind: "question",
    turnIndex,
    ts: new Date().toISOString(),
    input: { text: question },
    packet: result.packet,
  };
  session.turns.push(turn);
  session.questionCount += 1;
  session.updatedAt = turn.ts;
  sidecar.bedrockMessages.push(
    result.userMessage,
    result.assistantMessage,
    result.toolResultMessage,
  );
  accumulateTurnUsage(session, sidecar, turnIndex, result.usage);

  if (session.questionCount >= MAX_QUESTION_TURNS) {
    // Don't auto-end the session for question cap — drafts are the main
    // workflow. Just stop allowing further questions.
  }

  await saveWritingBundle({ session, sidecar });

  writeEvent({
    type: "answer_complete",
    turnIndex,
    packet: result.packet,
    draftCount: session.draftCount,
    questionCount: session.questionCount,
    usage: session.usage,
  });
};

// ── /writing/end ────────────────────────────────────────────────────────────
const handleEnd = async (
  body: Record<string, unknown>,
  studentId: string,
  writeEvent: (evt: WritingStreamEvent) => void,
): Promise<void> => {
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (!sessionId) {
    writeEvent({ type: "error", message: "sessionId is required" });
    return;
  }
  let session: WritingSession;
  let sidecar: AgentSidecar;
  try {
    const bundle = await loadWritingBundle({ studentId, sessionId });
    session = bundle.session;
    sidecar = bundle.sidecar;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "NOT_FOUND" || code === "WRONG_TYPE") {
      writeEvent({ type: "error", message: "Writing session not found." });
      return;
    }
    throw err;
  }
  logger.appendKeys({ sessionId });
  if (session.status !== "ended") {
    session.status = "ended";
    session.endedReason = "completed";
    session.updatedAt = new Date().toISOString();
    await saveWritingBundle({ session, sidecar });
  }
  writeEvent({
    type: "session_ended",
    endedReason: session.endedReason ?? "completed",
  });
};
