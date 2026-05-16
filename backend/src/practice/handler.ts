// ── Practice Lambda entry ────────────────────────────────────────────────────
// Three POST routes on one Function URL, dispatched by event.rawPath:
//   POST /practice/start  { originSessionId, questionId }
//   POST /practice/turn   { sessionId, parentMessage }
//   POST /practice/end    { sessionId }
//
// All routes:
//   - JWT-validated via Cognito (sub → studentId).
//   - NDJSON-streamed via the same awslambda.streamifyResponse pattern as
//     handler.ts.
//   - Persist the updated Practice session + sidecar to S3.
// ─────────────────────────────────────────────────────────────────────────────
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { runPracticeTurn } from "./practice";
import {
  createPracticeBundle,
  loadPracticeBundle,
  savePracticeBundle,
} from "./practiceStorage";
import type { PracticeBundle } from "./practiceStorage";
import type { PracticeStreamEvent } from "../shared/types";
import { logger } from "../shared/logger";

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

      let bundle: PracticeBundle;
      let forceEndSession = false;
      let parentMessage: string | undefined;

      if (path.endsWith("/practice/start")) {
        const originSessionId =
          typeof body.originSessionId === "string"
            ? body.originSessionId
            : typeof body.batchId === "string"
              ? body.batchId
              : "";
        const questionId =
          typeof body.questionId === "number" ? body.questionId : NaN;
        if (!originSessionId || Number.isNaN(questionId)) {
          writeEvent({
            type: "error",
            message: "originSessionId and questionId are required",
          });
          return;
        }
        try {
          bundle = await createPracticeBundle({
            studentId,
            originSessionId,
            originQuestionId: questionId,
          });
        } catch (err) {
          writeEvent({ type: "error", message: (err as Error).message });
          return;
        }
        logger.appendKeys({ practiceSessionId: bundle.session.sessionId });
      } else if (
        path.endsWith("/practice/turn") ||
        path.endsWith("/practice/end")
      ) {
        const sessionId =
          typeof body.sessionId === "string"
            ? body.sessionId
            : typeof body.practiceSessionId === "string"
              ? body.practiceSessionId
              : "";
        if (!sessionId) {
          writeEvent({
            type: "error",
            message: "sessionId is required",
          });
          return;
        }
        try {
          bundle = await loadPracticeBundle({ studentId, sessionId });
        } catch {
          writeEvent({
            type: "error",
            message: "Practice session not found.",
          });
          return;
        }
        logger.appendKeys({ practiceSessionId: bundle.session.sessionId });

        if (path.endsWith("/practice/end")) {
          forceEndSession = true;
        } else {
          parentMessage =
            typeof body.parentMessage === "string" ? body.parentMessage : "";
          if (bundle.session.status === "ended") {
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
      const result = await runPracticeTurn(bundle.session, bundle.sidecar, {
        parentMessage,
        forceEndSession,
        onEvent: writeEvent,
      });

      // Persist before emitting turn_complete so a client crash mid-write
      // doesn't lose the agent's work.
      await savePracticeBundle({ session: result.session, sidecar: bundle.sidecar });

      writeEvent({
        type: "turn_complete",
        agentMessage: result.agentMessage,
        problem: result.problem,
        isSessionEnded: result.isSessionEnded,
        // PracticeEndedReason now includes "tool_call_cap_reached" (ADR 0004)
        // which isn't yet in the wire PracticeStreamEvent.endedReason union.
        // Frontend update lands in a follow-up; cast until then.
        endedReason: result.endedReason as PracticeStreamEvent extends {
          type: "turn_complete";
          endedReason?: infer R;
        }
          ? R
          : never,
        finalSummary: result.finalSummary,
        turnUsage: result.turnUsage,
        sessionUsage: result.session.usage,
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
