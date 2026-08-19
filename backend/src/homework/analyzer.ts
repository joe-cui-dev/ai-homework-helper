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
import { buildUsage, converseWithTools, parseDataUrl, parseToolInput, sumUsage } from "../shared/bedrock";
import type { ModelChoice } from "../shared/modelChoice";
import type { PageAnalysis, IdentifiedQuestion } from "../shared/types";
import { logger } from "../shared/logger";
import type { HomeworkQuestion } from "../shared/session";
import type { SubmissionQuestionCandidate } from "./reconcileSubmission";
import type { StoredImage } from "../shared/sessionStore";

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

export interface HomeworkAnalysisPageInput {
  pageId: string;
  image: string;
}

export interface PriorPageContextInput {
  pageId: string;
  content: string;
}

export interface HomeworkSubmissionAnalysisResult {
  newPageContexts: Array<{ pageId: string; content: string }>;
  candidates: SubmissionQuestionCandidate[];
  usage: RawTokenUsage;
  fallbackPageIds: string[];
}

const APPEND_ANALYZER_SYSTEM_PROMPT = `You analyze Australian primary-school homework Page Submissions.
Return exactly one durable Page Context for every NEW image. Preserve verbatim text, LaTeX-style mathematics, Markdown tables, labels and layout relationships, and descriptions of diagrams and graphs.
For each complete Question, cite relevant stable page IDs and propose exactly one relation: new/high, update/high to an existing Question ID, or possible_duplicate/uncertain to an existing Question ID.
Assign the same non-empty overlapKey to candidates that are confidently the same Question within the NEW images, even when OCR wording differs slightly.
Use saved prior Page Context first. Request a prior page image only when its visual detail is essential and the saved semantic context is insufficient. Never invent page IDs or Question IDs.
Always call submit_homework_submission_analysis.`;

const SUBMIT_HOMEWORK_ANALYSIS_TOOL: Tool = {
  toolSpec: {
    name: "submit_homework_submission_analysis",
    description: "Submit Page Context and reconciliable Question candidates.",
    inputSchema: { json: {
      type: "object",
      properties: {
        pageContexts: { type: "array", items: { type: "object", properties: { pageId: { type: "string" }, content: { type: "string" } }, required: ["pageId", "content"] } },
        candidates: { type: "array", items: { type: "object", properties: {
          text: { type: "string" }, subject: { type: "string", enum: ["math", "science", "english", "other"] },
          yearLevel: { type: "string", enum: ["year-1", "year-2", "year-3", "year-4", "year-5", "year-6"] },
          sourcePageIds: { type: "array", items: { type: "string" } },
          overlapKey: { type: "string" },
          relation: { type: "object", properties: {
            kind: { type: "string", enum: ["new", "update", "possible_duplicate"] },
            confidence: { type: "string", enum: ["high", "uncertain"] },
            questionId: { type: "number" },
          }, required: ["kind", "confidence"] },
        }, required: ["text", "subject", "yearLevel", "sourcePageIds", "relation"] } },
        requestedPriorPageIds: { type: "array", items: { type: "string" } },
      },
      required: ["pageContexts", "candidates", "requestedPriorPageIds"],
    } },
  },
};

type HomeworkAnalysisToolInput = {
  pageContexts: Array<{ pageId: string; content: string }>;
  candidates: SubmissionQuestionCandidate[];
  requestedPriorPageIds: string[];
};

const imageBlockFromDataUrl = (image: string): Record<string, unknown> => {
  const { mediaType, base64Data } = parseDataUrl(image);
  return { image: { format: mediaType.split("/")[1], source: { bytes: Buffer.from(base64Data, "base64") } } };
};

const imageBlockFromStored = (image: StoredImage): Record<string, unknown> => ({
  image: { format: image.mediaType.split("/")[1], source: { bytes: image.data } },
});

const extractHomeworkAnalysis = (response: Awaited<ReturnType<typeof converseWithTools>>): HomeworkAnalysisToolInput => {
  for (const block of response.message.content ?? []) {
    const toolUse = block.toolUse as { name: string; input: unknown } | undefined;
    if (toolUse?.name === "submit_homework_submission_analysis") {
      return parseToolInput<HomeworkAnalysisToolInput>(toolUse.input);
    }
  }
  throw new Error("The analyzer did not return structured Page Context.");
};

const validateHomeworkAnalysis = (
  input: HomeworkAnalysisToolInput,
  newPageIds: Set<string>,
  priorPageIds: Set<string>,
  existingQuestionIds: Set<number>,
): void => {
  if (input.pageContexts.length !== newPageIds.size || new Set(input.pageContexts.map((p) => p.pageId)).size !== newPageIds.size || input.pageContexts.some((p) => !newPageIds.has(p.pageId) || !p.content.trim())) {
    throw new Error("Analyzer must return exactly one Page Context for every new page.");
  }
  const allowedPageIds = new Set([...newPageIds, ...priorPageIds]);
  for (const candidate of input.candidates) {
    if (!candidate.text?.trim() || !Array.isArray(candidate.sourcePageIds) || (newPageIds.size > 0 && candidate.sourcePageIds.length === 0) || candidate.sourcePageIds.some((id) => !allowedPageIds.has(id))) {
      throw new Error("Analyzer returned an invalid Question page reference.");
    }
    const relation = candidate.relation;
    const relationIsValid =
      (relation.kind === "new" && relation.confidence === "high") ||
      (relation.kind === "update" && relation.confidence === "high" && Number.isInteger(relation.questionId)) ||
      (relation.kind === "possible_duplicate" && relation.confidence === "uncertain" && Number.isInteger(relation.questionId));
    if (!relationIsValid) throw new Error("Analyzer returned an invalid Question relation.");
    if (candidate.relation.kind !== "new" && !existingQuestionIds.has(candidate.relation.questionId)) {
      throw new Error(`Analyzer related a candidate to unknown question ${candidate.relation.questionId}.`);
    }
  }
  for (const pageId of input.requestedPriorPageIds) {
    if (!priorPageIds.has(pageId)) throw new Error(`Analyzer requested unknown prior page ${pageId}.`);
  }
};

/** One semantic append pass plus at most one targeted old-image fallback. */
export const analyzeHomeworkSubmission = async (input: {
  newPages: HomeworkAnalysisPageInput[];
  priorPages: PriorPageContextInput[];
  existingQuestions: Array<Pick<HomeworkQuestion, "questionId" | "input" | "subject" | "yearLevel" | "sourcePageIds">>;
  questionText?: string;
  modelChoice: ModelChoice;
  loadPriorImage: (pageId: string) => Promise<StoredImage>;
}): Promise<HomeworkSubmissionAnalysisResult> => {
  const newPageIds = new Set(input.newPages.map((page) => page.pageId));
  const priorPageIds = new Set(input.priorPages.map((page) => page.pageId));
  const existingQuestionIds = new Set(input.existingQuestions.map((question) => question.questionId));
  const semanticPrompt = JSON.stringify({
    newPageIds: [...newPageIds], priorPageContexts: input.priorPages,
    existingQuestionSummaries: input.existingQuestions,
    typedQuestion: input.questionText?.trim() || undefined,
  });
  const runAnalysisPass = async (
    targetedImages: Array<{ pageId: string; image: StoredImage }> = [],
    firstPass?: HomeworkAnalysisToolInput,
  ) => {
    const content: Record<string, unknown>[] = firstPass
      ? []
      : input.newPages.map((page) => imageBlockFromDataUrl(page.image));
    for (const targeted of targetedImages) content.push(imageBlockFromStored(targeted.image));
    content.push({ text: `Submission context (stable IDs are authoritative):\n${semanticPrompt}\nTargeted prior images included: ${targetedImages.map((p) => p.pageId).join(", ") || "none"}${firstPass ? `\nThe first-pass Page Context below is final and must not be reinterpreted. Use the targeted old images only to resolve Question relations, and reproduce these contexts unchanged:\n${JSON.stringify(firstPass)}` : ""}` });
    const response = await converseWithTools(
      [{ role: "user", content }], [SUBMIT_HOMEWORK_ANALYSIS_TOOL], APPEND_ANALYZER_SYSTEM_PROMPT,
      { tool: { name: "submit_homework_submission_analysis" } }, 8192, true, input.modelChoice,
    );
    const extracted = extractHomeworkAnalysis(response);
    const analysis = firstPass ? { ...extracted, pageContexts: firstPass.pageContexts } : extracted;
    validateHomeworkAnalysis(analysis, newPageIds, priorPageIds, existingQuestionIds);
    return { analysis, usage: response.usage };
  };

  const first = await runAnalysisPass();
  if (first.analysis.requestedPriorPageIds.length === 0) {
    return { newPageContexts: first.analysis.pageContexts, candidates: first.analysis.candidates, usage: first.usage, fallbackPageIds: [] };
  }
  const requestedIds = [...new Set(first.analysis.requestedPriorPageIds)];
  const targeted = await Promise.all(requestedIds.map(async (pageId) => ({ pageId, image: await input.loadPriorImage(pageId) })));
  const fallback = await runAnalysisPass(targeted, first.analysis);
  if (fallback.analysis.requestedPriorPageIds.length > 0) {
    throw new Error("Homework analysis still needs visual context after the one fallback pass.");
  }
  return {
    newPageContexts: first.analysis.pageContexts,
    candidates: fallback.analysis.candidates,
    fallbackPageIds: requestedIds,
    usage: sumUsage(first.usage, fallback.usage),
  };
};
