import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { v4 as uuidv4 } from "uuid";
import { runAgent } from "./agent";
import { saveSession } from "./storage";
import type { StreamEvent } from "./types";
import { logger } from "./logger";

// Verifier is created once at cold-start; it caches JWKS automatically.
const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID ?? "",
  clientId: process.env.COGNITO_APP_CLIENT_ID ?? "",
  tokenUse: "access",
});

// CORS headers sent with every streaming response.
// Function URL CORS config (set in CDK) handles OPTIONS preflights before the
// Lambda is invoked, so we only need these headers on the actual response.
const CORS_HEADERS: Record<string, string> = {
  "Content-Type": "application/x-ndjson",
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN ?? "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export const handler = awslambda.streamifyResponse(
  async (event: APIGatewayProxyEventV2, responseStream, context) => {
    logger.addContext(context);
    // Attach HTTP metadata (status 200 + headers) before the first write.
    // For validation errors we still respond 200 and write an error event —
    // this is idiomatic for streaming APIs where the status code is fixed at
    // stream-open time.
    const httpStream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: CORS_HEADERS,
    });

    const writeEvent = (evt: StreamEvent): void => {
      httpStream.write(JSON.stringify(evt) + "\n");
    };

    try {
      // ── Authentication ──────────────────────────────────────────────────
      // Validate the Cognito access token from the Authorization header.
      // Any request without a valid token is rejected before touching Bedrock.
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
      let body: { question?: unknown };
      try {
        body = JSON.parse(event.body ?? "{}") as { question?: unknown };
      } catch {
        logger.warn("validation_invalid_json");
        writeEvent({ type: "error", message: "Invalid JSON body" });
        return;
      }

      const { question } = body;
      if (typeof question !== "string" || question.trim() === "") {
        logger.warn("validation_missing_question");
        writeEvent({
          type: "error",
          message: "'question' must be a non-empty string",
        });
        return;
      }

      const trimmedQuestion = question.trim();

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

      // studentId comes from the verified token sub — never trust client input.
      const resolvedStudentId = tokenSub;
      const sessionId = uuidv4();

      logger.appendKeys({ sessionId });
      logger.info("request_received");

      const result = await runAgent(
        trimmedQuestion,
        resolvedStudentId,
        writeEvent,
      );

      writeEvent({ type: "complete", result });
      logger.info("request_complete", {
        subject: result.subject,
        difficulty: result.difficulty,
      });

      // Awaited so the write completes before the stream closes.
      await saveSession(
        sessionId,
        {
          input: trimmedQuestion,
          subject: result.subject,
          difficulty: result.difficulty,
          answer: result.answer,
          steps: result.steps,
          explanation: result.explanation,
          hints: result.hints,
          timestamp: new Date().toISOString(),
        },
        resolvedStudentId,
      );
    } catch (err) {
      logger.error("unhandled_error", err instanceof Error ? err : String(err));
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
