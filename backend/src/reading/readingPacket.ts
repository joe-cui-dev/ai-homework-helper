// ── Reading Packet generator ──────────────────────────────────────────────────
// Reading-task counterpart to coachingPacket.ts. Single forced-tool Converse
// call that takes the uploaded book images (cover + pages), the inferred
// BookContext + yearLevel, and the matching Australian Curriculum English
// outcomes, and returns exactly 5 grounded comprehension questions with
// model answers and parent coaching guidance.
//
// Reader is the parent. The questionText is phrased so the parent can read
// it aloud verbatim or paraphrase. Adult-to-adult fields stay in adult voice.
// Model answers MUST be grounded in the uploaded pages — relying on the
// model's training-data knowledge of the book is forbidden (see ADR 0002).
// ─────────────────────────────────────────────────────────────────────────────
import type { RawTokenUsage, Tool, BedrockMessage } from "../shared/bedrock";
import { buildUsage, converseWithTools, parseDataUrl, parseToolInput } from "../shared/bedrock";
import type { ModelChoice } from "../shared/modelChoice";
import { lookupCurriculum } from "../shared/curriculum";
import type { BookContext, ReadingPacket, YearLevel } from "../shared/types";
import { logger } from "../shared/logger";

export interface GenerateReadingPacketsResult {
  packets: ReadingPacket[];
  usage: RawTokenUsage;
}

// v1 generates a fixed count for predictable cost and parent UX.
// Target mix is ~2 literal, ~2 inference, ~1 vocabulary, but the model has
// some leeway depending on what the pages support.
export const READING_QUESTIONS_PER_SESSION = 5;

const SYSTEM_PROMPT = `You are an Australian-curriculum reading-comprehension tutor speaking to a PARENT who will then check their child's understanding of a book they've read together. The parent is the reader, not the child.

You will be given the book's cover and a few interior pages, plus the inferred year level and the matching Australian Curriculum English outcomes.

Your job: produce ${READING_QUESTIONS_PER_SESSION} comprehension questions, all grounded in the uploaded pages, balanced across these comprehension skills:
- literal recall (find-the-fact in the text) — aim for 2
- inference (read-between-the-lines, motivation, cause/effect) — aim for 2
- vocabulary in context (what does this word mean *here*) — aim for 1

Submit them all together by calling submit_reading_packets exactly once.

GROUNDING RULES — non-negotiable:
- Every modelAnswer MUST be supported by content visible in the uploaded pages.
- Do NOT generate questions about plot points, characters, or themes that don't appear in the uploaded pages, even if you recognise the book from training data.
- If you can't find enough material on the pages for a question of a given type, choose a different type. Better to have 3 literal + 2 inference and zero vocab than to fabricate.

QUESTION TEXT RULES:
- questionText is what the parent reads aloud or paraphrases for the child. Calibrate vocabulary and length to the year level.
- year-1 (~age 6): one short clause, everyday words, concrete focus.
- year-2 (~age 7): short concrete sentences.
- year-3 (~age 8): can use simple comprehension terms ("why does", "how does"); plain language.
- year-4 (~age 9): can ask about feelings/motivations; clear vocabulary.
- year-5 (~age 10): can use literary terms (character, setting); ask about author choices.
- year-6 (~age 11): can use abstract terms (theme, perspective); chains of reasoning OK.

PARENT-FACING FIELDS (adult-to-adult voice — no emojis, no "great job!", no second-person to a child):
- modelAnswer: what a strong answer looks like, in 1–3 sentences. Concrete, grounded in the pages.
- comprehensionSkill: name the sub-skill the question targets (e.g. "Inference — character motivation"), then one sentence explaining what the child has to do mentally to answer it. Reference the curriculum outcome if natural.
- coachingTip: concrete instructions for what the parent should do or say WITH the child. Action-oriented. Often: "Ask them to point to the part of the page where they see this" or "If they jump to a guess, ask them why."
- commonMisreadings: 2–3 specific wrong/partial answers a child of this year level often gives on a question like this.
- discussionPrompt: a Socratic prompt the parent reads aloud verbatim if the child is stuck. Calibrate to year level. Should NOT give the answer away.

OPTIONAL:
- pageReference: short pointer (e.g. "page 2, third paragraph" or "the picture on page 4") to where the answer is found. Omit if you genuinely can't tell from the uploaded images.

PER-QUESTION ISOLATION:
- Each packet's fields must address ONLY that packet's questionId.
- Sequential questionIds starting from 1.

Always call submit_reading_packets — never respond with plain text.`;

const SUBMIT_TOOL: Tool = {
  toolSpec: {
    name: "submit_reading_packets",
    description:
      "Submit the reading-comprehension packets. Always call this tool exactly once with all packets in one array.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          packets: {
            type: "array",
            description: `Reading-comprehension packets. Aim for ${READING_QUESTIONS_PER_SESSION} entries; never fewer than 3 nor more than ${READING_QUESTIONS_PER_SESSION + 1}.`,
            minItems: 3,
            maxItems: READING_QUESTIONS_PER_SESSION + 1,
            items: {
              type: "object",
              properties: {
                questionId: {
                  type: "number",
                  description:
                    "Sequential question id starting from 1.",
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
                questionType: {
                  type: "string",
                  enum: ["literal", "inference", "vocabulary"],
                },
                questionText: {
                  type: "string",
                  maxLength: 280,
                  description:
                    "The question phrased so the parent can read it aloud verbatim. Year-level calibrated.",
                },
                modelAnswer: {
                  type: "string",
                  maxLength: 300,
                  description:
                    "What a strong answer looks like — 1–3 sentences, grounded in the uploaded pages.",
                },
                comprehensionSkill: {
                  type: "string",
                  maxLength: 400,
                  description:
                    "Adult-to-adult: name the sub-skill the question targets and one sentence on what the child must do mentally.",
                },
                coachingTip: {
                  type: "string",
                  maxLength: 500,
                  description:
                    "Adult-to-adult action-oriented guidance for the parent.",
                },
                commonMisreadings: {
                  type: "array",
                  description:
                    "2–3 wrong/partial answers a child of this year level often gives.",
                  items: { type: "string", maxLength: 200 },
                  minItems: 1,
                  maxItems: 4,
                },
                discussionPrompt: {
                  type: "string",
                  maxLength: 300,
                  description:
                    "Year-calibrated Socratic prompt the parent reads aloud if the child is stuck. Must not give the answer away.",
                },
                pageReference: {
                  type: "string",
                  maxLength: 120,
                  description:
                    "Short pointer to where the answer is found in the uploaded pages. Omit if not determinable.",
                },
              },
              required: [
                "questionId",
                "yearLevel",
                "questionType",
                "questionText",
                "modelAnswer",
                "comprehensionSkill",
                "coachingTip",
                "commonMisreadings",
                "discussionPrompt",
              ],
            },
          },
        },
        required: ["packets"],
      },
    },
  },
};

const formatBookContext = (ctx: BookContext): string => {
  const parts: string[] = [];
  if (ctx.title) parts.push(`Title: ${ctx.title}`);
  if (ctx.author) parts.push(`Author: ${ctx.author}`);
  return parts.length ? parts.join("\n") : "Title and author: not legible from cover.";
};

export const generateReadingPackets = async (
  images: string[],
  bookContext: BookContext,
  yearLevel: YearLevel,
  modelChoice: ModelChoice = "fast",
): Promise<GenerateReadingPacketsResult> => {
  if (images.length === 0) {
    return { packets: [], usage: buildUsage(0, 0, modelChoice) };
  }

  const content: Record<string, unknown>[] = images.map((img, i) => {
    const { mediaType, base64Data } = parseDataUrl(img);
    const format = mediaType.split("/")[1] as "jpeg" | "png" | "gif" | "webp";
    logger.debug("reading_packet_image", { page: i, format });
    return {
      image: { format, source: { bytes: Buffer.from(base64Data, "base64") } },
    };
  });

  const curriculumOutcomes = lookupCurriculum("english", yearLevel);
  const curriculumBlock = curriculumOutcomes.length
    ? `Australian Curriculum (English, ${yearLevel}) outcomes for grounding:\n- ${curriculumOutcomes.join("\n- ")}`
    : "";

  content.push({
    text: `Book information:\n${formatBookContext(bookContext)}\nInferred year level: ${yearLevel}\n\n${curriculumBlock}\n\nGenerate ${READING_QUESTIONS_PER_SESSION} comprehension packets grounded in the uploaded pages. Sequential ids from 1.`,
  });

  const messages: BedrockMessage[] = [{ role: "user", content }];

  logger.info("reading_packet_generate_start", {
    imageCount: images.length,
    yearLevel,
    hasTitle: !!bookContext.title,
  });

  // 8192 tokens to comfortably fit 5 packets × 6 prose fields.
  const response = await converseWithTools(
    messages,
    [SUBMIT_TOOL],
    SYSTEM_PROMPT,
    { tool: { name: "submit_reading_packets" } },
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
      "Your submission was blocked by the content filter. Please try a different book.";
    logger.warn("reading_packet_guardrail_intervened", {
      message: guardrailMessage,
    });
    throw new Error(guardrailMessage);
  }

  for (const block of response.message.content ?? []) {
    const toolUse = block.toolUse as
      | { name: string; input: unknown }
      | undefined;
    if (toolUse?.name === "submit_reading_packets") {
      const input = parseToolInput<{ packets: ReadingPacket[] }>(toolUse.input);
      logger.info("reading_packet_generate_complete", {
        packetCount: input.packets.length,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      });
      return { packets: input.packets, usage: response.usage };
    }
  }

  logger.warn("reading_packet_no_tool_call");
  throw new Error(
    "The tutor could not produce reading questions for this submission. Please try again.",
  );
};
