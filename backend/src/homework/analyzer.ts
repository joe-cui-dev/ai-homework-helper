// ── Page analyzer ─────────────────────────────────────────────────────────────
// Single Claude call (no agentic loop) that reads one or more homework page
// images and returns a structured manifest:
//   - articleContext: full text of any reading passage found across all pages
//   - questions: every question identified, tagged with whether it needs the
//     article and which image page it appears on
//
// The analyzer is deliberately separate from the agent loop so that the handler
// can orchestrate sequential per-question solves using the existing runAgent().
// ─────────────────────────────────────────────────────────────────────────────
import type { RawTokenUsage, Tool, BedrockMessage } from "../shared/bedrock";
import { buildUsage, converseWithTools, parseDataUrl, parseToolInput } from "../shared/bedrock";
import type { ModelChoice } from "../shared/modelChoice";
import type { PageAnalysis, IdentifiedQuestion } from "../shared/types";
import { logger } from "../shared/logger";

export type { PageAnalysis };

export interface AnalyzePagesResult {
  analysis: PageAnalysis;
  usage: RawTokenUsage;
}

const ANALYZER_SYSTEM_PROMPT = `You are analyzing photos of Australian primary school homework pages.
Your job is to:
0. Produce durable Page Context for every image. It must preserve verbatim text, LaTex-style maths, Markdown tables, labels, layout relationships, and descriptions of diagrams/graphs.
1. Extract ALL questions visible across all provided images, numbering them sequentially from 1.
2. If any page contains a reading passage or article (not a question), extract its full text as articleContext.
3. For each question, decide whether it requires the article/passage to answer (usesArticle: true/false).
4. Record which image page (0-based index) each question appears on as sourcePage.
5. For each question, classify subject as one of math | science | english | other, and yearLevel as one of year-1 | year-2 | year-3 | year-4 | year-5 | year-6 based on the question content and complexity.

Rules:
- Number questions sequentially across all pages (1, 2, 3, ...).
- If a question is part of a numbered series on the page (e.g. "1.", "2a.", "Q3"), preserve that numbering in the question text but still use a sequential id.
- A standalone diagram label or page title is NOT a question — skip it.
- If the image is unreadable or contains no questions, return an empty questions array.
- Always call submit_page_analysis — never respond with plain text.`;

const SUBMIT_TOOL: Tool = {
  toolSpec: {
    name: "submit_page_analysis",
    description:
      "Submit the structured analysis of all homework pages. Always call this tool.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          pageContexts: {
            type: "array",
            description: "One durable semantic context string for each input image, in image order.",
            items: { type: "string" },
          },
          articleContext: {
            type: "string",
            description:
              "Full text of any reading passage or article found across all pages. Omit if there is no article.",
          },
          questions: {
            type: "array",
            description: "All questions found across all pages, in order.",
            items: {
              type: "object",
              properties: {
                id: { type: "number", description: "Sequential question number starting from 1" },
                text: { type: "string", description: "Full text of the question" },
                usesArticle: {
                  type: "boolean",
                  description: "True if answering this question requires reading the article/passage",
                },
                sourcePage: {
                  type: "number",
                  description: "0-based index of the image this question appears on",
                },
                subject: {
                  type: "string",
                  enum: ["math", "science", "english", "other"],
                  description: "Subject classification for this question.",
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
                    "Australian primary year level inferred from question content and complexity.",
                },
              },
              required: [
                "id",
                "text",
                "usesArticle",
                "sourcePage",
                "subject",
                "yearLevel",
              ],
            },
          },
        },
        required: ["pageContexts", "questions"],
      },
    },
  },
};

export const analyzePages = async (
  images: string[],
  questionText?: string,
  modelChoice: ModelChoice = "fast",
): Promise<AnalyzePagesResult> => {
  const zeroUsage = buildUsage(0, 0, modelChoice);
  // Fast path: no images, just a text question — skip the Claude call entirely.
  if (images.length === 0) {
    return {
      analysis: {
        questions: questionText?.trim()
          ? [
            {
              id: 1,
              text: questionText.trim(),
              usesArticle: false,
              subject: "other",
              yearLevel: "year-3",
            },
          ]
          : [],
      },
      usage: zeroUsage,
    };
  }

  // Build the initial message: one image block per page, then optional text.
  const content: Record<string, unknown>[] = images.map((img, i) => {
    const { mediaType, base64Data } = parseDataUrl(img);
    const format = mediaType.split("/")[1] as "jpeg" | "png" | "gif" | "webp";
    logger.debug("analyzer_image", { page: i, format });
    return { image: { format, source: { bytes: Buffer.from(base64Data, "base64") } } };
  });

  if (questionText?.trim()) {
    content.push({ text: questionText.trim() });
  }

  const messages: BedrockMessage[] = [{ role: "user", content }];

  logger.info("analyzer_start", { imageCount: images.length, hasText: !!questionText?.trim() });

  // 8192 tokens to accommodate long articles without truncation.
  const response = await converseWithTools(
    messages,
    [SUBMIT_TOOL],
    ANALYZER_SYSTEM_PROMPT,
    { tool: { name: "submit_page_analysis" } },
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
    logger.warn("analyzer_guardrail_intervened", { message: guardrailMessage });
    throw new Error(guardrailMessage);
  }

  // Extract the tool input from the response.
  for (const block of response.message.content ?? []) {
    const toolUse = block.toolUse as
      | { name: string; input: unknown }
      | undefined;
    if (toolUse?.name === "submit_page_analysis") {
      const input = parseToolInput<{
        pageContexts?: string[];
        articleContext?: string;
        questions: IdentifiedQuestion[];
      }>(toolUse.input);
      logger.info("analyzer_complete", {
        questionCount: input.questions.length,
        hasArticle: !!input.articleContext,
      });
      return {
        analysis: {
          articleContext: input.articleContext,
          pageContexts: input.pageContexts,
          questions: input.questions,
        },
        usage: response.usage,
      };
    }
  }

  // Fallback: Claude didn't call the tool — treat whole input as one question.
  logger.warn("analyzer_no_tool_call");
  return {
    analysis: {
      questions: questionText?.trim()
        ? [
            {
              id: 1,
              text: questionText.trim(),
              usesArticle: false,
              subject: "other",
              yearLevel: "year-3",
            },
          ]
        : [],
    },
    usage: response.usage,
  };
};
