// ── Agentic AI loop ──────────────────────────────────────────────────────────
// Drives a multi-turn conversation with Claude where the model autonomously
// decides which tools to call and in what order.
//
// Each iteration:
//   1. Send the current message history to Claude via the Converse API.
//   2. Claude responds with one or more tool_use blocks (never plain text,
//      because toolChoice: { any: {} } forces it to always pick a tool).
//   3. Execute each requested tool and collect the results.
//   4. Append all results to the conversation as a new "user" message.
//   5. Repeat — Claude sees the results and decides what to do next.
//
// The loop ends when Claude calls submit_answer, which is a synthetic tool
// that carries the final structured result as its input.
// ─────────────────────────────────────────────────────────────────────────────
import type { BedrockMessage, Tool } from "./bedrock";
import { converseWithTools, parseDataUrl } from "./bedrock";
import { solve, explain, generateHint } from "./pipeline";
import { lookupCurriculum } from "./curriculum";
import { getRecentSessions } from "./storage";
import type { AgentResult, StreamEvent } from "./types";
import { logger } from "./logger";

export type { AgentResult };

// Thrown after an error event has already been sent to the frontend via
// onEvent, so the handler knows not to emit a second duplicate error event.
export class AlreadyReportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlreadyReportedError";
  }
}

const MAX_ITERATIONS = 5;

const SYSTEM_PROMPT = `You are a homework tutor for Australian primary school students (Years 1-6).
Given a homework question, use the available tools to help the student. The student may provide text, a photo of the question, or both. If only a photo is provided, read the question directly from the image before proceeding. If a reading passage is included before the question, use it as the primary source when answering comprehension questions.
Follow this process:

1. Classify the subject (math, science, english, other) and year level (year-1 to year-6) from the question itself.
2. Optionally call lookup_curriculum to reference relevant Australian curriculum outcomes.
3. Optionally call fetch_session_history if a studentId was provided in the message, to personalise the response.
4. Call solve_question to work through the problem step by step.
5. Optionally call explain_solution to rewrite the answer in friendly, age-appropriate language.
6. Optionally call generate_hint if scaffolded hints would benefit the student.
7. Always finish by calling submit_answer with the complete final result.

Be cost-conscious: skip explain_solution for simple, single-step factual answers.
Only call fetch_session_history when a studentId is explicitly present in the message.
One call to solve_question is almost always sufficient.`;

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

export const TOOL_SCHEMA: Tool[] = [
  {
    toolSpec: {
      name: "solve_question",
      description:
        "Solve a homework question step by step using subject-specific and year-level-appropriate guidance. Returns { answer, steps }.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The homework question to solve",
            },
            subject: {
              type: "string",
              enum: ["math", "science", "english", "other"],
              description: "Subject area",
            },
            difficulty: {
              type: "string",
              enum: [
                "year-1",
                "year-2",
                "year-3",
                "year-4",
                "year-5",
                "year-6",
              ],
              description: "Australian curriculum year level",
            },
          },
          required: ["question", "subject", "difficulty"],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "generate_hint",
      description:
        "Generate Socratic hints that scaffold the student toward the answer without giving it away. Returns { hints: string[] }.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            question: { type: "string" },
            subject: {
              type: "string",
              enum: ["math", "science", "english", "other"],
            },
            difficulty: {
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
          },
          required: ["question", "subject", "difficulty"],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "explain_solution",
      description:
        "Rewrite a solution in friendly, encouraging language appropriate for the student's year level. Returns { explanation }.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            answer: { type: "string" },
            steps: { type: "array", items: { type: "string" } },
            difficulty: {
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
          },
          required: ["answer", "steps", "difficulty"],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "lookup_curriculum",
      description:
        "Look up Australian curriculum outcomes for a subject and year level. Returns an array of outcome strings. Zero AI cost — uses local data.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            subject: {
              type: "string",
              enum: ["math", "science", "english", "other"],
            },
            year: {
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
          },
          required: ["subject", "year"],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "fetch_session_history",
      description:
        "Fetch the current student's 3 most recent sessions to personalise the response. Zero AI cost — reads from S3.",
      inputSchema: {
        json: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "submit_answer",
      description:
        "Submit the final answer to the student. This MUST be the last tool call — it ends the agent loop.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            subject: { type: "string" },
            difficulty: { type: "string" },
            answer: { type: "string" },
            steps: { type: "array", items: { type: "string" } },
            explanation: { type: "string" },
            hints: { type: "array", items: { type: "string" } },
          },
          required: ["subject", "difficulty", "answer", "steps", "explanation"],
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool dispatcher — routes tool calls to pipeline / storage / curriculum
// ---------------------------------------------------------------------------

export const dispatchTool = async (
  name: string,
  input: Record<string, unknown>,
  studentId?: string,
): Promise<unknown> => {
  // Each tool implementation is responsible for validating its own input against the schema defined in TOOL_SCHEMA, and should throw an error if the input is invalid. The converseWithTools function ensures that the input adheres to the schema before invoking the tool, but it's good practice for each tool to defensively check its input as well.
  switch (name) {
    // solve_question is the core tool that performs the actual problem-solving. It receives the question along with the classified subject and difficulty level, so it can apply appropriate methods to arrive at the answer and the step-by-step solution.
    case "solve_question":
      return solve(
        input.question as string,
        input.subject as string,
        input.difficulty as string,
      );

    // generate_hint and explain_solution are optional tools that Claude can choose to call if it thinks the student would benefit from hints or a friendlier explanation. They receive the same subject and difficulty level as solve_question, along with the question for generate_hint, and the answer + steps for explain_solution, so they can tailor their output appropriately.
    case "generate_hint":
      return generateHint(
        input.question as string,
        input.subject as string,
        input.difficulty as string,
      );
    // explain_solution takes the answer and steps produced by solve_question and rewrites them in a more accessible way. This is especially useful for younger students or more complex problems where the raw solution might be hard to understand.
    case "explain_solution":
      return explain(
        input.answer as string,
        input.steps as string[],
        input.difficulty as string,
      );

    // lookup_curriculum and fetch_session_history are tools that provide additional context to Claude. lookup_curriculum allows Claude to reference specific curriculum outcomes, which can help it tailor its explanations to the relevant learning goals. fetch_session_history gives Claude insight into the student's recent interactions, allowing for a more personalized response based on the student's history and progress.
    case "lookup_curriculum":
      return lookupCurriculum(input.subject as string, input.year as string);

    // fetch_session_history is only included in the toolset if a studentId is provided, so we can be confident that studentId is defined when this tool is called. It retrieves the student's recent session history from storage, which can include information about past questions, performance, and interactions with the agent. This information can be invaluable for Claude to personalize its responses and provide continuity across sessions.
    case "fetch_session_history":
      return getRecentSessions(studentId!);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
};

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

export const runAgent = async (
  question: string,
  studentId?: string,
  onEvent?: (event: StreamEvent) => void,
  images?: string[],
  articleContext?: string,
): Promise<AgentResult> => {
  const initialContent: Record<string, unknown>[] = [];

  for (const image of images ?? []) {
    const { mediaType, base64Data } = parseDataUrl(image);
    const format = mediaType.split("/")[1] as "jpeg" | "png" | "gif" | "webp";
    initialContent.push({
      image: { format, source: { bytes: Buffer.from(base64Data, "base64") } },
    });
  }

  // Inject the article text so Claude can answer questions that reference it.
  if (articleContext) {
    initialContent.push({ text: `Reading passage:\n\n${articleContext}` });
  }

  // Only add a text block when there is actual text — Bedrock rejects empty text blocks.
  if (question) {
    initialContent.push({ text: question });
  }

  const messages: BedrockMessage[] = [
    { role: "user", content: initialContent },
  ];

  // exclude fetch_session_history from tools if no studentId is provided
  const tools = studentId
    ? TOOL_SCHEMA
    : TOOL_SCHEMA.filter((t) => t.toolSpec?.name !== "fetch_session_history");

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    logger.debug("agent_iteration", { iteration });

    // Ask Claude what to do next, given everything in the conversation so far.
    // toolChoice: { any: {} } (set in converseWithTools) forces it to always
    // pick a tool — it can never respond with plain text.
    const response = await converseWithTools(messages, tools, SYSTEM_PROMPT);
    messages.push(response.message);

    if (response.stopReason === "end_turn") {
      logger.error("end_turn_without_submit", { iteration });
      throw new Error("Agent ended without calling submit_answer");
    }

    if (response.stopReason === "guardrail_intervened") {
      // The guardrail blocked the request. The assistant message content holds
      // the configured blockedInputMessaging / blockedOutputsMessaging text.
      // Surface it directly to the frontend rather than throwing a generic error.
      const guardrailMessage =
        (response.message.content ?? [])
          .map((b) => (b as { text?: string }).text)
          .filter(Boolean)
          .join(" ") ||
        "Your question was blocked by the content filter. Please rephrase it.";
      logger.warn("guardrail_intervened", {
        iteration,
        message: guardrailMessage,
      });
      onEvent?.({ type: "error", message: guardrailMessage });
      throw new AlreadyReportedError(guardrailMessage);
    }

    if (response.stopReason !== "tool_use") {
      logger.error("unexpected_stop_reason", {
        stopReason: response.stopReason,
        iteration,
      });
      throw new Error(`Unexpected stopReason: ${response.stopReason}`);
    }

    const toolResultBlocks: Record<string, unknown>[] = [];
    let submitted: AgentResult | null = null;

    // Execute every tool Claude requested in this iteration.
    // Claude can request multiple tools in a single response; we run them all
    // and collect the results before sending them back in one go.
    for (const block of response.message.content ?? []) {
      const toolUse = block.toolUse as
        | { toolUseId: string; name: string; input: unknown }
        | undefined;
      if (!toolUse) continue;
      const { toolUseId, name, input } = toolUse;

      if (name === "submit_answer") {
        // submit_answer is a synthetic tool — no real function is invoked.
        // Claude uses it to deliver the final structured answer as its input.
        // Capturing the input here ends the loop after this iteration.
        onEvent?.({ type: "tool_start", tool: name });
        logger.info("tool_dispatch", { tool: name, iteration });
        submitted = input as unknown as AgentResult;
        toolResultBlocks.push({
          toolResult: {
            toolUseId,
            content: [{ text: "Answer submitted successfully." }],
            status: "success",
          },
        });
        onEvent?.({ type: "tool_end", tool: name });
      } else {
        onEvent?.({ type: "tool_start", tool: name });
        logger.info("tool_dispatch", { tool: name, iteration });
        try {
          const result = await dispatchTool(
            name,
            input as Record<string, unknown>,
            studentId,
          );
          logger.debug("tool_result", { tool: name, success: true });
          toolResultBlocks.push({
            toolResult: {
              toolUseId,
              content: [{ text: JSON.stringify(result) }],
              status: "success",
            },
          });
        } catch (err) {
          logger.warn("tool_error", {
            tool: name,
            error: (err as Error).message,
          });
          toolResultBlocks.push({
            toolResult: {
              toolUseId,
              content: [{ text: `Error: ${(err as Error).message}` }],
              status: "error",
            },
          });
        } finally {
          onEvent?.({ type: "tool_end", tool: name });
        }
      }
    }

    // Feed all tool outputs back into the conversation as a new user message.
    // On the next iteration, Claude will see what happened and decide what to do next.
    messages.push({ role: "user", content: toolResultBlocks });

    // If Claude called submit_answer this iteration, we have the final answer.
    if (submitted) return submitted;
  }

  logger.error("max_iterations_exceeded", { maxIterations: MAX_ITERATIONS });
  throw new Error(
    `Agent exceeded MAX_ITERATIONS (${MAX_ITERATIONS}) without submitting an answer`,
  );
};
