// ── Practice Lambda entry ────────────────────────────────────────────────────
// Three POST routes on one Function URL, dispatched by event.rawPath:
//   POST /practice/start  { batchId, questionId }
//   POST /practice/turn   { practiceSessionId, parentMessage }
//   POST /practice/end    { practiceSessionId }
//
// All routes:
//   - JWT-validated via Cognito (sub → studentId).
//   - NDJSON-streamed via the same awslambda.streamifyResponse pattern as
//     handler.ts.
//   - Persist the updated PracticeSession to S3.
// ─────────────────────────────────────────────────────────────────────────────
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { runPracticeTurn } from "./practice";
import {
  createPracticeSession,
  loadPracticeSession,
  savePracticeSession,
} from "./practiceStorage";
import type { PracticeSession, PracticeStreamEvent } from "./types";
import { logger } from "./logger";

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID ?? "",
  clientId: process.env.COGNITO_APP_CLIENT_ID ?? "",
  tokenUse: "access",
});

const RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "application/x-ndjson",
};

const parseJsonBody = (event: APIGatewayProxyEventV2): Record<string, unknown> => {
  try {
    return JSON.parse(event.body ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
};

const parseLocator = (
  practiceSessionId: unknown,
): { batchId: string; questionId: number } | null => {
  if (typeof practiceSessionId !== "string") return null;
  const colon = practiceSessionId.indexOf(":");
  if (colon <= 0) return null;
  const batchId = practiceSessionId.slice(0, colon);
  const questionId = parseInt(practiceSessionId.slice(colon + 1), 10);
  if (!batchId || Number.isNaN(questionId)) return null;
  return { batchId, questionId };
};

export const handler = awslambda.streamifyResponse(
  async (event: APIGatewayProxyEventV2, responseStream, context) => {
    logger.addContext(context);
    const httpStream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: RESPONSE_HEADERS,
    });

    const writeEvent = (evt: PracticeStreamEvent): void => {
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

      // ── Route dispatch ──────────────────────────────────────────────────
      const path = event.rawPath ?? "";
      const body = parseJsonBody(event);

      let session: PracticeSession;
      let forceEndSession = false;
      let parentMessage: string | undefined;

      if (path.endsWith("/practice/start")) {
        const batchId = typeof body.batchId === "string" ? body.batchId : "";
        const questionId =
          typeof body.questionId === "number" ? body.questionId : NaN;
        if (!batchId || Number.isNaN(questionId)) {
          writeEvent({ type: "error", message: "batchId and questionId are required" });
          return;
        }
        try {
          session = await createPracticeSession({
            studentId,
            batchId,
            questionId,
          });
        } catch (err) {
          if ((err as { code?: string }).code === "ALREADY_ACTIVE") {
            writeEvent({ type: "error", message: (err as Error).message });
            return;
          }
          throw err;
        }
        logger.appendKeys({ practiceSessionId: session.practiceSessionId });
      } else if (
        path.endsWith("/practice/turn") ||
        path.endsWith("/practice/end")
      ) {
        const loc = parseLocator(body.practiceSessionId);
        if (!loc) {
          writeEvent({
            type: "error",
            message:
              "practiceSessionId must be a valid '{batchId}:{questionId}' string",
          });
          return;
        }
        try {
          session = await loadPracticeSession({
            studentId,
            batchId: loc.batchId,
            questionId: loc.questionId,
          });
        } catch {
          writeEvent({
            type: "error",
            message: "Practice session not found.",
          });
          return;
        }
        logger.appendKeys({ practiceSessionId: session.practiceSessionId });

        if (path.endsWith("/practice/end")) {
          forceEndSession = true;
        } else {
          parentMessage =
            typeof body.parentMessage === "string" ? body.parentMessage : "";
          if (session.status === "ended") {
            writeEvent({
              type: "error",
              message: "This practice session has already ended.",
            });
            return;
          }
        }
      } else {
        writeEvent({
          type: "error",
          message: `Unknown route: ${path}`,
        });
        return;
      }

      // ── Run the agent loop ──────────────────────────────────────────────
      const result = await runPracticeTurn(session, {
        parentMessage,
        forceEndSession,
        onEvent: writeEvent,
      });

      // Persist before emitting turn_complete so a client crash mid-write
      // doesn't lose the agent's work.
      await savePracticeSession(result.session);

      writeEvent({
        type: "turn_complete",
        agentMessage: result.agentMessage,
        problem: result.problem,
        isSessionEnded: result.isSessionEnded,
        endedReason: result.endedReason,
        finalSummary: result.finalSummary,
      });

      logger.info("practice_turn_complete", {
        isSessionEnded: result.isSessionEnded,
        problemCount: result.session.problemCount,
        toolCallCount: result.session.toolCallCount,
      });
    } catch (err) {
      logger.error(
        "practice_unhandled_error",
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
