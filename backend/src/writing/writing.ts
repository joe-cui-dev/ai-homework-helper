// ── Writing per-turn orchestration ───────────────────────────────────────────
// Three turn kinds, each a single forced-tool Converse call. No agentic loop
// inside a turn — the module is "agentic" at session level only (state lives
// in S3 and is restored on every HTTP request).
// ─────────────────────────────────────────────────────────────────────────────
import type { BedrockMessage, RawTokenUsage } from "../shared/bedrock";
import {
  buildUsage,
  converseWithTools,
  parseDataUrl,
  sumUsage,
} from "../shared/bedrock";
import type {
  CoachingNotePacket,
  DraftFeedbackPacket,
  WritingPlanPacket,
  WritingSessionRecord,
  YearLevel,
} from "../shared/types";
import {
  buildCoachingNoteSystemPrompt,
  buildDraftFeedbackSystemPrompt,
  buildPlanSystemPrompt,
} from "./prompts";
import {
  SUBMIT_COACHING_NOTE_TOOL,
  SUBMIT_DRAFT_FEEDBACK_TOOL,
  SUBMIT_WRITING_PLAN_TOOL,
} from "./tools";
import {
  normaliseCoachingNote,
  normaliseDraftFeedback,
  normalisePlan,
} from "./normalize";
import { logger } from "../shared/logger";

const buildImageBlocks = (images: string[]): Record<string, unknown>[] =>
  images.map((img) => {
    const { mediaType, base64Data } = parseDataUrl(img);
    const format = mediaType.split("/")[1] as "jpeg" | "png" | "gif" | "webp";
    return {
      image: { format, source: { bytes: Buffer.from(base64Data, "base64") } },
    };
  });

// Replace image blocks with a text placeholder before persisting to S3.
// Buffer doesn't survive JSON.stringify + JSON.parse — it round-trips to a
// plain object {type:"Buffer", data:[...]} that the AWS SDK can't base64-
// encode, so replaying it on the next turn throws "@smithy/util-base64:
// toBase64 encoder function only accepts string | Uint8Array". Subsequent
// turns don't need the original images anyway: the locked `plan` and the
// system-prompt context header already carry the relevant content.
export const redactImageBlocksForHistory = (
  message: BedrockMessage,
): BedrockMessage => {
  let imageCount = 0;
  const redacted = (message.content ?? []).map((block) => {
    const b = block as Record<string, unknown>;
    if (b.image) {
      imageCount += 1;
      return { text: "[image from earlier turn omitted from history]" };
    }
    // Defensive: catches sessions persisted before this redaction landed,
    // where image.source.bytes is a JSON-revived {type:"Buffer", data:[]}
    // object that fails base64 encoding.
    return block;
  });
  if (imageCount > 0) {
    logger.debug("writing_history_image_redacted", { imageCount });
  }
  return { role: message.role, content: redacted };
};

const extractToolUse = <T,>(
  message: BedrockMessage,
  toolName: string,
): T | null => {
  for (const block of message.content ?? []) {
    const toolUse = block.toolUse as
      | { name: string; input: unknown }
      | undefined;
    if (toolUse?.name === toolName) {
      return toolUse.input as T;
    }
  }
  return null;
};

const guardrailMessageOf = (message: BedrockMessage): string =>
  (message.content ?? [])
    .map((b) => (b as { text?: string }).text)
    .filter(Boolean)
    .join(" ") || "Your submission was blocked by the content filter.";

// ── Turn 1: /writing/start ───────────────────────────────────────────────────
export interface PlanTurnInput {
  promptText: string;
  promptImages: string[];
  // When the parent picked a year level on the landing page, it overrides
  // Claude's inference. Server defensively rewrites plan.yearLevel after the
  // call so a misbehaving model can't break downstream calibration.
  userYearLevel?: YearLevel;
}

export interface PlanTurnResult {
  plan: WritingPlanPacket;
  // The user message that produced the plan, for persisting in
  // _internal.messages for downstream turns.
  userMessage: BedrockMessage;
  // The assistant message containing the tool_use block, for persisting.
  assistantMessage: BedrockMessage;
  // Synthetic tool_result message we pair with the assistantMessage to keep
  // the Bedrock conversation valid for follow-up turns.
  toolResultMessage: BedrockMessage;
  usage: RawTokenUsage;
}

export const runPlanTurn = async (
  input: PlanTurnInput,
): Promise<PlanTurnResult> => {
  const userContent: Record<string, unknown>[] = [];
  if (input.promptImages.length > 0) {
    userContent.push(...buildImageBlocks(input.promptImages));
  }
  if (input.promptText.trim()) {
    userContent.push({
      text: `Writing assignment prompt:\n\n${input.promptText.trim()}`,
    });
  } else {
    userContent.push({
      text: `Writing assignment prompt is provided as image(s) above. Read it from the images.`,
    });
  }
  const userMessage: BedrockMessage = { role: "user", content: userContent };

  logger.info("writing_plan_start", {
    imageCount: input.promptImages.length,
    hasText: input.promptText.trim().length > 0,
  });

  const response = await converseWithTools(
    [userMessage],
    [SUBMIT_WRITING_PLAN_TOOL],
    buildPlanSystemPrompt(input.userYearLevel),
    { tool: { name: "submit_writing_plan" } },
    8192,
  );

  if (response.stopReason === "guardrail_intervened") {
    const msg = guardrailMessageOf(response.message);
    logger.warn("writing_plan_guardrail", { msg });
    throw new Error(msg);
  }

  const rawPlan = extractToolUse<WritingPlanPacket>(
    response.message,
    "submit_writing_plan",
  );
  if (!rawPlan) {
    throw new Error(
      "The writing coach could not produce a plan for this prompt. Please try again.",
    );
  }
  const plan = normalisePlan(rawPlan);
  // Defensive overwrite: if the parent picked a year level, that's
  // authoritative regardless of what Claude echoed back.
  if (input.userYearLevel) {
    plan.yearLevel = input.userYearLevel;
    plan.yearLevelSource = "user";
  } else {
    plan.yearLevelSource = "inferred";
  }
  // Surface XML-leakage / missing-field anomalies in CloudWatch.
  const planAnomalies = describePlanAnomalies(plan);
  if (planAnomalies.length > 0) {
    logger.warn("writing_plan_field_anomalies", {
      missing: planAnomalies,
      stopReason: response.stopReason,
      outputTokens: response.usage.outputTokens,
    });
  }

  // Build the synthetic tool_result message. Required so future Converse calls
  // see a well-formed alternation of user / assistant turns with paired
  // tool_use / tool_result blocks.
  const toolUseId = findToolUseId(response.message, "submit_writing_plan");
  const toolResultMessage: BedrockMessage = {
    role: "user",
    content: [
      {
        toolResult: {
          toolUseId,
          content: [{ text: "Plan accepted." }],
          status: "success",
        },
      },
    ],
  };

  logger.info("writing_plan_complete", {
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    yearLevel: plan.yearLevel,
    yearLevelSource: plan.yearLevelSource,
    genre: plan.genre,
  });

  return {
    plan,
    userMessage,
    assistantMessage: response.message,
    toolResultMessage,
    usage: response.usage,
  };
};

// ── Turn N: /writing/draft ───────────────────────────────────────────────────
export interface DraftTurnInput {
  draftText: string;
  draftImages: string[];
}

export interface DraftTurnResult {
  packet: DraftFeedbackPacket;
  userMessage: BedrockMessage;
  assistantMessage: BedrockMessage;
  toolResultMessage: BedrockMessage;
  usage: RawTokenUsage;
}

export const runDraftTurn = async (
  session: WritingSessionRecord,
  input: DraftTurnInput,
): Promise<DraftTurnResult> => {
  const userContent: Record<string, unknown>[] = [];
  if (input.draftImages.length > 0) {
    userContent.push(...buildImageBlocks(input.draftImages));
  }
  if (input.draftText.trim()) {
    userContent.push({
      text: `Student draft (revision ${session.draftCount + 1}):\n\n${input.draftText.trim()}`,
    });
  } else {
    userContent.push({
      text: `Student draft (revision ${session.draftCount + 1}) is the image(s) above — handwritten. Transcribe verbatim into the transcription field, preserving misspellings.`,
    });
  }
  const userMessage: BedrockMessage = { role: "user", content: userContent };

  const messages: BedrockMessage[] = [
    ...session._internal.messages,
    userMessage,
  ];

  logger.info("writing_draft_start", {
    draftIndex: session.draftCount,
    imageCount: input.draftImages.length,
    hasText: input.draftText.trim().length > 0,
  });

  const response = await converseWithTools(
    messages,
    [SUBMIT_DRAFT_FEEDBACK_TOOL],
    buildDraftFeedbackSystemPrompt(session.plan),
    { tool: { name: "submit_draft_feedback" } },
    8192,
  );

  if (response.stopReason === "guardrail_intervened") {
    const msg = guardrailMessageOf(response.message);
    logger.warn("writing_draft_guardrail", { msg });
    throw new Error(msg);
  }

  const rawPacket = extractToolUse<DraftFeedbackPacket>(
    response.message,
    "submit_draft_feedback",
  );
  if (!rawPacket) {
    throw new Error(
      "The writing coach could not produce feedback for this draft. Please try again.",
    );
  }
  const packet = normaliseDraftFeedback(rawPacket);

  const toolUseId = findToolUseId(response.message, "submit_draft_feedback");
  const toolResultMessage: BedrockMessage = {
    role: "user",
    content: [
      {
        toolResult: {
          toolUseId,
          content: [{ text: "Feedback delivered." }],
          status: "success",
        },
      },
    ],
  };

  logger.info("writing_draft_complete", {
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    overallBand: packet.rubric.overallBand,
    nextStep: packet.nextStep,
  });

  return {
    packet,
    userMessage,
    assistantMessage: response.message,
    toolResultMessage,
    usage: response.usage,
  };
};

// ── Turn N: /writing/question ────────────────────────────────────────────────
export interface QuestionTurnInput {
  question: string;
}

export interface QuestionTurnResult {
  packet: CoachingNotePacket;
  userMessage: BedrockMessage;
  assistantMessage: BedrockMessage;
  toolResultMessage: BedrockMessage;
  usage: RawTokenUsage;
}

export const runQuestionTurn = async (
  session: WritingSessionRecord,
  input: QuestionTurnInput,
): Promise<QuestionTurnResult> => {
  const userMessage: BedrockMessage = {
    role: "user",
    content: [{ text: `Parent's clarifying question:\n\n${input.question.trim()}` }],
  };

  const messages: BedrockMessage[] = [
    ...session._internal.messages,
    userMessage,
  ];

  logger.info("writing_question_start", {
    questionIndex: session.questionCount,
  });

  const response = await converseWithTools(
    messages,
    [SUBMIT_COACHING_NOTE_TOOL],
    buildCoachingNoteSystemPrompt(session.plan),
    { tool: { name: "submit_coaching_note" } },
    2048,
  );

  if (response.stopReason === "guardrail_intervened") {
    const msg = guardrailMessageOf(response.message);
    logger.warn("writing_question_guardrail", { msg });
    throw new Error(msg);
  }

  const rawPacket = extractToolUse<CoachingNotePacket>(
    response.message,
    "submit_coaching_note",
  );
  if (!rawPacket) {
    throw new Error(
      "The writing coach could not answer that question. Please try rephrasing.",
    );
  }
  const packet = normaliseCoachingNote(rawPacket);

  const toolUseId = findToolUseId(response.message, "submit_coaching_note");
  const toolResultMessage: BedrockMessage = {
    role: "user",
    content: [
      {
        toolResult: {
          toolUseId,
          content: [{ text: "Note delivered." }],
          status: "success",
        },
      },
    ],
  };

  logger.info("writing_question_complete", {
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
  });

  return {
    packet,
    userMessage,
    assistantMessage: response.message,
    toolResultMessage,
    usage: response.usage,
  };
};

const findToolUseId = (
  message: BedrockMessage,
  toolName: string,
): string => {
  for (const block of message.content ?? []) {
    const toolUse = block.toolUse as
      | { toolUseId: string; name: string }
      | undefined;
    if (toolUse?.name === toolName) return toolUse.toolUseId;
  }
  // Fallback — Bedrock should always provide one, but never crash.
  return `${toolName}-fallback`;
};

// Identify any fields on a normalised WritingPlanPacket that came back empty —
// almost always a sign Claude emitted XML tool format that Bedrock couldn't
// reconstruct into the JSON schema. We log these as warnings so CloudWatch
// surfaces a metric we can alarm on.
const describePlanAnomalies = (plan: WritingPlanPacket): string[] => {
  const issues: string[] = [];
  if (!plan.assignmentSummary.trim()) issues.push("assignmentSummary");
  if (plan.successCriteria.length === 0) issues.push("successCriteria");
  if (plan.planningQuestions.length === 0) issues.push("planningQuestions");
  if (!plan.modelAnswer.trim()) issues.push("modelAnswer");
  if (plan.watchFor.length === 0) issues.push("watchFor");
  if (!plan.coachingScript.trim()) issues.push("coachingScript");
  // vocabularyToOffer is allowed to be empty — not an anomaly.
  return issues;
};

// Aggregate per-turn usage into the session's cumulative TokenUsage. Mutates
// the session in place.
export const accumulateTurnUsage = (
  session: WritingSessionRecord,
  turnIndex: number,
  usage: RawTokenUsage,
): void => {
  session._internal.usagePerTurn.push({
    turnIndex,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });
  session.usage = sumUsage(session.usage, usage);
};

// Convenience: build an initial empty TokenUsage for new sessions.
export const zeroUsage = (): RawTokenUsage => buildUsage(0, 0);
