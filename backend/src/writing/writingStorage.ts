// ── Writing Session storage ──────────────────────────────────────────────────
// User-facing WritingSession at sessions/{studentId}/writing/{sessionId}.json
// and the Bedrock conversation sidecar at .agent.json (same prefix).
// The bundle API is the only surface the handler uses. Lazy stale-flip applied
// on read. See ADR 0005 (supersedes the key layout in ADR 0004).
// ─────────────────────────────────────────────────────────────────────────────
import type { BedrockMessage } from "../shared/bedrock";
import type { WritingSession } from "../shared/session";
import {
  loadSession,
  loadAgentSidecar,
  saveSession,
  saveAgentSidecar,
} from "../shared/sessionStore";
import type { AgentSidecar } from "../shared/sessionStore";
import { logger } from "../shared/logger";

export const WRITING_SESSION_MAX_AGE_HOURS = 7 * 24;
export const MAX_DRAFT_TURNS = 5;
export const MAX_QUESTION_TURNS = 3;

export interface WritingBundle {
  session: WritingSession;
  sidecar: AgentSidecar;
}

export interface WritingSessionLocator {
  studentId: string;
  sessionId: string;
}

// Heal image content blocks that no longer carry usable bytes. Bedrock images
// arrive as Buffer/Uint8Array but the JSON.stringify round-trip turns Buffer
// into {type:"Buffer", data:[...]} which the AWS SDK's base64 encoder rejects
// on replay ("@smithy/util-base64: toBase64 encoder function only accepts
// string | Uint8Array"). Replace any such block with a text placeholder.
const sanitiseHistoryMessages = (
  messages: BedrockMessage[],
): BedrockMessage[] => {
  let healedCount = 0;
  const out = messages.map((msg) => {
    const content = (msg.content ?? []).map((block) => {
      const b = block as Record<string, unknown>;
      const image = b.image as
        | { source?: { bytes?: unknown } }
        | undefined;
      if (image) {
        const bytes = image.source?.bytes;
        const isUsable =
          bytes instanceof Uint8Array || typeof bytes === "string";
        if (!isUsable) {
          healedCount += 1;
          return { text: "[image from earlier turn omitted from history]" };
        }
      }
      return block;
    });
    return { role: msg.role, content };
  });
  if (healedCount > 0) {
    logger.warn("writing_history_sanitised", { healedImages: healedCount });
  }
  return out;
};

export const loadWritingBundle = async (
  loc: WritingSessionLocator,
): Promise<WritingBundle> => {
  const session = await loadSession(loc.studentId, "writing", loc.sessionId);
  if (!session) {
    const error = new Error("Writing session not found.");
    (error as { code?: string }).code = "NOT_FOUND";
    throw error;
  }
  if (session.sessionType !== "writing") {
    const error = new Error("This session is not a writing session.");
    (error as { code?: string }).code = "WRONG_TYPE";
    throw error;
  }
  if (session.studentId !== loc.studentId) {
    const error = new Error("Writing session not found.");
    (error as { code?: string }).code = "NOT_FOUND";
    throw error;
  }

  const sidecar: AgentSidecar = (await loadAgentSidecar(
    loc.studentId,
    "writing",
    loc.sessionId,
  )) ?? { bedrockMessages: [], usagePerTurn: [] };

  if (sidecar.bedrockMessages.length) {
    sidecar.bedrockMessages = sanitiseHistoryMessages(sidecar.bedrockMessages);
  }

  const ageMs = Date.now() - new Date(session.updatedAt).getTime();
  const stale =
    session.status === "active" &&
    ageMs > WRITING_SESSION_MAX_AGE_HOURS * 3600 * 1000;
  if (stale) {
    session.status = "ended";
    session.endedReason = "abandoned";
    await saveSession(session);
    logger.info("writing_session_auto_abandoned", {
      sessionId: session.sessionId,
    });
  }

  return { session, sidecar };
};

export const saveWritingBundle = async (
  bundle: WritingBundle,
): Promise<void> => {
  // Write order: user-facing session first, then Bedrock sidecar. If the
  // sidecar write fails on an active session, the next turn can detect the
  // mismatch and either re-derive or refuse — never silently corrupt.
  await saveSession(bundle.session);
  await saveAgentSidecar(
    bundle.session.studentId,
    "writing",
    bundle.session.sessionId,
    bundle.sidecar,
  );
  logger.info("writing_bundle_save", {
    sessionId: bundle.session.sessionId,
    status: bundle.session.status,
    draftCount: bundle.session.draftCount,
    questionCount: bundle.session.questionCount,
  });
};
