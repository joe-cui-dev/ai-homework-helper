// ── Book analyzer ─────────────────────────────────────────────────────────────
// Reading-task counterpart to analyzer.ts. Single forced-tool Converse call
// that takes the uploaded book images (cover + pages) and returns:
//   - bookContext: title/author when the cover is recognisable
//   - yearLevel:   inferred from cover artwork + vocabulary + sentence complexity
//   - pagesAreSufficient: judge whether there's enough content in the pages
//                          to write 5 quality grounded comprehension questions
//   - insufficientReason: when not sufficient, a concrete request to the parent
//
// Per ADR 0002, questions are NEVER generated from cover-only knowledge — the
// AI is forbidden from relying on training-data familiarity with the book.
// This step is purely classification + sufficiency gating; question generation
// happens in readingPacket.ts only after this step approves the inputs.
// ─────────────────────────────────────────────────────────────────────────────
import type { RawTokenUsage, Tool, BedrockMessage } from "../shared/bedrock";
import { buildUsage, converseWithTools, parseDataUrl, parseToolInput } from "../shared/bedrock";
import type { ModelChoice } from "../shared/modelChoice";
import type { BookAnalysis } from "../shared/types";
import { logger } from "../shared/logger";

export interface AnalyzeBookResult {
  analysis: BookAnalysis;
  usage: RawTokenUsage;
}

const SYSTEM_PROMPT = `You are analysing photos a parent uploaded for an Australian primary school reading-comprehension task. The parent intends the AI to generate 5 comprehension questions a child can answer to check their understanding of the book.

Your job is ONLY classification and sufficiency gating. You are forbidden from generating questions in this step.

Inputs:
- Image 0 is usually the book cover.
- The remaining images are interior pages (story content, illustrations with captions, paragraphs).

Submit your analysis by calling submit_book_analysis exactly once.

Rules:
1. bookContext.title and bookContext.author: ONLY include if you can clearly read them from the cover image. Otherwise omit them. Do NOT guess.
2. yearLevel: infer from vocabulary on the page images, sentence length, illustration density, and cover style. Use the Australian Curriculum levels:
   - year-1 (~age 6): single-clause sentences, picture-book heavy, decoding-stage vocab
   - year-2 (~age 7): short sentences with simple connectives, mostly familiar words
   - year-3 (~age 8): early chapter books, multi-clause sentences, occasional adjectives
   - year-4 (~age 9): chapter books with paragraphs, similes, some figurative language
   - year-5 (~age 10): longer chapters, varied sentence types, richer vocab
   - year-6 (~age 11): novels, complex sentence structures, abstract themes
3. pagesAreSufficient: true ONLY if the interior pages give you enough concrete, readable text to ground 5 grounded comprehension questions across literal recall, inference, and vocabulary in context. If pages are mostly illustrations with little text, or you only have a cover, set false.
4. insufficientReason (REQUIRED when pagesAreSufficient is false): one short, friendly, specific sentence telling the parent what to upload next (e.g. "Please upload 3–5 pages from the middle of the book showing the story text.").

Always call submit_book_analysis — never respond with plain text.`;

const SUBMIT_TOOL: Tool = {
  toolSpec: {
    name: "submit_book_analysis",
    description:
      "Submit the structured book analysis. Always call this tool exactly once.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          bookContext: {
            type: "object",
            description:
              "Metadata extracted from the cover. Both fields optional — only include when clearly readable from the cover image.",
            properties: {
              title: { type: "string", maxLength: 200 },
              author: { type: "string", maxLength: 120 },
            },
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
            description:
              "Inferred Australian Curriculum year level the book is pitched at.",
          },
          pagesAreSufficient: {
            type: "boolean",
            description:
              "True only if the uploaded pages contain enough readable text to ground 5 quality comprehension questions.",
          },
          insufficientReason: {
            type: "string",
            maxLength: 300,
            description:
              "Required when pagesAreSufficient is false. One short, friendly, specific request to the parent describing what to upload next.",
          },
        },
        required: ["bookContext", "yearLevel", "pagesAreSufficient"],
      },
    },
  },
};

export const analyzeBook = async (
  images: string[],
  modelChoice: ModelChoice = "fast",
): Promise<AnalyzeBookResult> => {
  if (images.length === 0) {
    // No images at all — short-circuit to insufficient. Saves a Bedrock call.
    return {
      analysis: {
        bookContext: {},
        yearLevel: "year-3",
        pagesAreSufficient: false,
        insufficientReason:
          "Please upload the book cover and a few pages of content from inside the book.",
      },
      usage: buildUsage(0, 0, modelChoice),
    };
  }

  const content: Record<string, unknown>[] = images.map((img, i) => {
    const { mediaType, base64Data } = parseDataUrl(img);
    const format = mediaType.split("/")[1] as "jpeg" | "png" | "gif" | "webp";
    logger.debug("book_analyzer_image", { page: i, format });
    return {
      image: { format, source: { bytes: Buffer.from(base64Data, "base64") } },
    };
  });

  content.push({
    text: `Image 0 is the book cover. The remaining images (1..${images.length - 1}) are interior pages. Decide if these pages alone contain enough readable text to ground 5 comprehension questions.`,
  });

  const messages: BedrockMessage[] = [{ role: "user", content }];

  logger.info("book_analyzer_start", { imageCount: images.length });

  const response = await converseWithTools(
    messages,
    [SUBMIT_TOOL],
    SYSTEM_PROMPT,
    { tool: { name: "submit_book_analysis" } },
    1024,
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
    logger.warn("book_analyzer_guardrail_intervened", {
      message: guardrailMessage,
    });
    throw new Error(guardrailMessage);
  }

  for (const block of response.message.content ?? []) {
    const toolUse = block.toolUse as
      | { name: string; input: unknown }
      | undefined;
    if (toolUse?.name === "submit_book_analysis") {
      const input = parseToolInput<BookAnalysis>(toolUse.input);
      logger.info("book_analyzer_complete", {
        yearLevel: input.yearLevel,
        pagesAreSufficient: input.pagesAreSufficient,
        hasTitle: !!input.bookContext?.title,
      });
      return { analysis: input, usage: response.usage };
    }
  }

  logger.warn("book_analyzer_no_tool_call");
  throw new Error(
    "The tutor could not analyse this upload. Please try again with clearer photos of the cover and a few pages.",
  );
};
