// ── Coaching Packet generator ────────────────────────────────────────────────
// Single forced-tool Converse call that takes the original page images, the
// list of identified questions, and the optional article context, and returns
// one CoachingPacket per question.
//
// The reader of the output is the parent (Parent-as-Coach), not the child.
// Parent-facing fields stay in adult voice; only childHint is calibrated to
// the question's year level.
//
// Mirrors the shape of analyzer.ts: one Bedrock call, single tool,
// toolChoice forced. Per-field maxLength constraints in the schema
// structurally prevent the cross-contamination bug where Claude collapses
// multiple questions' answers into a single field.
// ─────────────────────────────────────────────────────────────────────────────
import type { RawTokenUsage, Tool, BedrockMessage } from "../shared/bedrock";
import { buildUsage, converseWithTools, parseDataUrl, parseToolInput } from "../shared/bedrock";
import type { ModelChoice } from "../shared/modelChoice";
import type { CoachingPacket, IdentifiedQuestion } from "../shared/types";
import { logger } from "../shared/logger";

export interface GenerateCoachingPacketsResult {
  packets: CoachingPacket[];
  usage: RawTokenUsage;
}

// Per-call cap on identified questions. Each packet is bounded by the schema
// at ~250 output tokens (tldrAnswer + whyItWorks + childHint + JSON framing).
// Larger batches are chunked by chunkQuestionsForPacketCall below into
// multiple parallel calls. See ADR 0006 for the field-trim rationale.
export const MAX_QUESTIONS_PER_PACKET_CALL = 7;

// ── Chunking helper ──────────────────────────────────────────────────────
// Two-stage:
//   1. Group by sourcePage so each chunk shares its page's image (cheaper
//      vision tokens, naturally cohesive — same article, same diagram).
//      Questions without a sourcePage fall into a single "all-images" group.
//   2. Sub-split any group that exceeds MAX_QUESTIONS_PER_PACKET_CALL.
// Article context is shared across all chunks (passed unchanged each call).
export interface PacketCallChunk {
  questions: IdentifiedQuestion[];
  images: string[];
}

const chunkArray = <T>(arr: T[], size: number): T[][] => {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

export const chunkQuestionsForPacketCall = (
  questions: IdentifiedQuestion[],
  allImages: string[],
): PacketCallChunk[] => {
  const byPage = new Map<number, IdentifiedQuestion[]>();
  for (const q of questions) {
    const key = q.sourcePage ?? -1;
    const existing = byPage.get(key);
    if (existing) existing.push(q);
    else byPage.set(key, [q]);
  }

  const chunks: PacketCallChunk[] = [];
  for (const [page, pageQuestions] of byPage) {
    // Per-chunk image selection: send only the relevant page's image when we
    // know which page the questions are on; otherwise fall back to all images.
    const chunkImages =
      page >= 0 && allImages[page] !== undefined
        ? [allImages[page]]
        : allImages;
    for (const sub of chunkArray(
      pageQuestions,
      MAX_QUESTIONS_PER_PACKET_CALL,
    )) {
      chunks.push({ questions: sub, images: chunkImages });
    }
  }
  return chunks;
};

const SYSTEM_PROMPT = `You are an Australian-curriculum homework tutor speaking to a PARENT who will then teach their child. The parent is the reader, not the child.

For every question identified on the homework page(s), produce one coaching packet. Submit them all together by calling submit_coaching_packets exactly once.

The subject and yearLevel for each question are supplied alongside the question text — use them to calibrate childHint and to shape whyItWorks. Do not echo them back in the packet.

Tone rules — these are non-negotiable:
- whyItWorks is ADULT-TO-ADULT prose. No emojis. No "great job!". No second-person addressed to a child.
- childHint is what the parent reads aloud to the child if the child is stuck. Calibrate to the supplied yearLevel.
- tldrAnswer is one short sentence answering the question directly.

SUBJECT GUIDANCE (applies to whyItWorks)
math: Show every step in plain-text notation (x^2, sqrt(x)) — no LaTeX.
science: State the principle and include units.
english: Name the grammatical rule or literary device and explain it.
other: Break the problem into clear logical steps.

FIELD CONTRACTS
- tldrAnswer: ≤200 chars. One sentence. The direct answer.
- whyItWorks: ≤600 chars. Adult prose. The underlying concept and how the answer follows.
- childHint: ≤300 chars. Year-calibrated. A Socratic prompt the parent reads aloud if the child is stuck.

PER-QUESTION ISOLATION
- Each packet's fields must address ONLY that packet's questionId.
- Never put answers or hints from one question into another packet's fields.
- If two questions share an underlying concept, repeat the concept in both packets in different words. Do not cross-reference packets.

If a reading passage is provided, use it as the primary source for comprehension questions. If only photos are provided, read the question text directly from the images.

Always call submit_coaching_packets — never respond with plain text.`;

const SUBMIT_TOOL: Tool = {
  toolSpec: {
    name: "submit_coaching_packets",
    description:
      "Submit one coaching packet per identified question. Always call this tool exactly once with all packets in one array.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          packets: {
            type: "array",
            description:
              "One coaching packet per identified question. Length must equal the number of identified questions; questionId must match.",
            items: {
              type: "object",
              properties: {
                questionId: {
                  type: "number",
                  description:
                    "Sequential question id matching the IdentifiedQuestion supplied in the user message.",
                },
                tldrAnswer: {
                  type: "string",
                  maxLength: 200,
                  description:
                    "One short sentence answering this specific question directly.",
                },
                whyItWorks: {
                  type: "string",
                  maxLength: 600,
                  description:
                    "Adult-to-adult prose. The underlying concept and how the answer follows from it.",
                },
                childHint: {
                  type: "string",
                  maxLength: 300,
                  description:
                    "Year-level-calibrated Socratic prompt the parent reads aloud verbatim if the child is stuck.",
                },
              },
              required: [
                "questionId",
                "tldrAnswer",
                "whyItWorks",
                "childHint",
              ],
            },
          },
        },
        required: ["packets"],
      },
    },
  },
};

export const generateCoachingPackets = async (
  images: string[],
  questions: IdentifiedQuestion[],
  articleContext?: string,
  modelChoice: ModelChoice = "fast",
): Promise<GenerateCoachingPacketsResult> => {
  if (questions.length === 0) {
    return { packets: [], usage: buildUsage(0, 0, modelChoice) };
  }

  // Build the user message: images first, then optional article, then the
  // structured question list as plain text so Claude can route per-id.
  const content: Record<string, unknown>[] = images.map((img, i) => {
    const { mediaType, base64Data } = parseDataUrl(img);
    const format = mediaType.split("/")[1] as "jpeg" | "png" | "gif" | "webp";
    logger.debug("packet_image", { page: i, format });
    return {
      image: { format, source: { bytes: Buffer.from(base64Data, "base64") } },
    };
  });

  if (articleContext?.trim()) {
    content.push({ text: `Reading passage:\n\n${articleContext.trim()}` });
  }

  const questionList = questions
    .map(
      (q) =>
        `[questionId=${q.id}, subject=${q.subject}, yearLevel=${q.yearLevel}${q.sourcePage !== undefined ? `, sourcePage=${q.sourcePage}` : ""}] ${q.text}`,
    )
    .join("\n");

  content.push({
    text: `Identified questions (one packet required per id):\n${questionList}`,
  });

  const messages: BedrockMessage[] = [{ role: "user", content }];

  logger.info("packet_generate_start", {
    imageCount: images.length,
    questionCount: questions.length,
    hasArticle: !!articleContext?.trim(),
  });

  // 8192 tokens to comfortably fit ~6 packets × 5 prose fields.
  const response = await converseWithTools(
    messages,
    [SUBMIT_TOOL],
    SYSTEM_PROMPT,
    { tool: { name: "submit_coaching_packets" } },
    8192,
    true,
    modelChoice,
  );

  if (response.stopReason === "guardrail_intervened") {
    const guardrailMessage =
      (response.message.content ?? [])
        .map((b) => (b as { text?: string }).text)
        .filter(Boolean)
        .join(" ") ||
      "Your submission was blocked by the content filter. Please rephrase it.";
    logger.warn("packet_guardrail_intervened", { message: guardrailMessage });
    throw new Error(guardrailMessage);
  }

  for (const block of response.message.content ?? []) {
    const toolUse = block.toolUse as
      | { name: string; input: unknown }
      | undefined;
    if (toolUse?.name === "submit_coaching_packets") {
      const input = parseToolInput<{ packets: CoachingPacket[] }>(toolUse.input);
      logger.info("packet_generate_complete", {
        packetCount: input.packets.length,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      });
      return { packets: input.packets, usage: response.usage };
    }
  }

  logger.warn("packet_no_tool_call");
  throw new Error(
    "The tutor could not produce a coaching packet for this submission. Please try again.",
  );
};

/** Generates packets from durable Page Context, avoiding old image re-reads. */
export const generateCoachingPacketsFromContext = async (
  questions: IdentifiedQuestion[],
  pageContexts: string[],
  modelChoice: ModelChoice = "fast",
): Promise<GenerateCoachingPacketsResult> => {
  if (questions.length === 0) return { packets: [], usage: buildUsage(0, 0, modelChoice) };
  const questionList = questions.map((q) => `[questionId=${q.id}, subject=${q.subject}, yearLevel=${q.yearLevel}] ${q.text}`).join("\n");
  const response = await converseWithTools(
    [{ role: "user", content: [{ text: `Relevant Page Context:\n\n${pageContexts.join("\n\n---\n\n")}\n\nIdentified questions:\n${questionList}` }] }],
    [SUBMIT_TOOL,], SYSTEM_PROMPT, { tool: { name: "submit_coaching_packets" } }, 8192, true, modelChoice,
  );
  for (const block of response.message.content ?? []) {
    const toolUse = block.toolUse as { name: string; input: unknown } | undefined;
    if (toolUse?.name === "submit_coaching_packets") {
      return { packets: parseToolInput<{ packets: CoachingPacket[] }>(toolUse.input).packets, usage: response.usage };
    }
  }
  throw new Error("The tutor could not produce a coaching packet for this submission. Please try again.");
};
