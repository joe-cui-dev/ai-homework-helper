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
import type { CoachingPacket, IdentifiedQuestion } from "../shared/types";
import { logger } from "../shared/logger";

export interface GenerateCoachingPacketsResult {
  packets: CoachingPacket[];
  usage: RawTokenUsage;
}

// Per-call cap on identified questions. Each packet is bounded by the schema
// at ~600 output tokens (tldrAnswer + whyItWorks + howToCoach + watchFor +
// childHint + JSON framing). 7 packets ≈ 4200 tokens, comfortably under the
// 8192-token output ceiling with margin for the model's own slack. Larger
// batches (e.g. a 21-question worksheet) are chunked by chunkQuestionsForPacketCall
// below into multiple parallel calls.
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

Tone rules — these are non-negotiable:
- whyItWorks, howToCoach, watchFor are ADULT-TO-ADULT prose. No emojis. No "great job!". No second-person addressed to a child. The parent is the reader.
- Only childHint is calibrated to the child's year level. The parent reads it aloud verbatim if the child needs a Socratic prompt.
- tldrAnswer is one short sentence answering the question directly.

Per-question routing — classify each question's subject and yearLevel from the question content, then apply the matching guidance below when constructing whyItWorks, howToCoach, watchFor, and childHint.

SUBJECT GUIDANCE
math: Show every algebraic or arithmetic step explicitly in whyItWorks. Label each step (e.g. "expand brackets", "divide both sides"). Use plain-text notation (x^2, sqrt(x)) — no LaTeX.
science: State the underlying principle or law in whyItWorks. Walk through the calculation or reasoning. Include units in every step and call out assumptions.
english: Identify the grammatical rule, literary device, or comprehension strategy at play in whyItWorks. Explain why it applies before giving the corrected or annotated answer. Keep terminology accessible to a non-specialist parent.
other: Break the problem into clear logical steps in whyItWorks. Explain the reasoning behind each step.

YEAR-LEVEL CALIBRATION (applies to childHint only)
year-1 (~age 6): Very short sentences, everyday words, counting/objects/patterns as analogies.
year-2 (~age 7): Short concrete sentences, familiar-object examples.
year-3 (~age 8): Simple subject terms allowed but always explained in plain language. Relatable real-world examples.
year-4 (~age 9): Clear friendly language. Correct terminology paired with plain-English explanation. Short age-appropriate analogies.
year-5 (~age 10): Correct subject vocabulary used confidently, new terms explained once.
year-6 (~age 11): Accurate subject terminology throughout. Multi-stage reasoning permitted.

FIELD CONTRACTS
- tldrAnswer: ≤200 chars. One sentence. The direct answer.
- whyItWorks: ≤600 chars. Adult prose. The underlying concept and how the answer follows.
- howToCoach: ≤600 chars. Adult prose. Concrete instructions for what the parent should do or say with the child to teach this. Action-oriented.
- watchFor: 2–3 items, each ≤200 chars. Adult prose. Common wrong answers / misconceptions a child of this year level typically falls into on this exact question.
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
                subject: {
                  type: "string",
                  enum: ["math", "science", "english", "other"],
                },
                yearLevel: {
                  type: "string",
                  enum: [
                    "year-1",
                    "year-2",
                    "year-3",
                    "year-4",
                    "year-5",
                    "year-6",
                  ],
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
                howToCoach: {
                  type: "string",
                  maxLength: 600,
                  description:
                    "Adult-to-adult prose. Concrete actions/words the parent should use to teach the child this question.",
                },
                watchFor: {
                  type: "array",
                  description:
                    "2–3 common wrong answers or misconceptions a child of this year level typically falls into on this question. Adult prose.",
                  items: { type: "string", maxLength: 200 },
                  minItems: 1,
                  maxItems: 4,
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
                "subject",
                "yearLevel",
                "tldrAnswer",
                "whyItWorks",
                "howToCoach",
                "watchFor",
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
): Promise<GenerateCoachingPacketsResult> => {
  if (questions.length === 0) {
    return { packets: [], usage: buildUsage(0, 0) };
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
        `[questionId=${q.id}${q.sourcePage !== undefined ? `, sourcePage=${q.sourcePage}` : ""}] ${q.text}`,
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
