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
import { converseWithTools } from "./bedrock";
import { solve, explain, generateHint } from "./pipeline";
import { lookupCurriculum } from "./curriculum";
import { getRecentSessions } from "./storage";
import type { AgentResult, StreamEvent } from "./types";
import { logger } from "./logger";

export type { AgentResult };

const MAX_ITERATIONS = 5;

const SYSTEM_PROMPT = `You are a homework tutor for Australian primary school students (Years 1-6).
Given a homework question, use the available tools to help the student. Follow this process:

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
  switch (name) {
    case "solve_question":
      return solve(
        input.question as string,
        input.subject as string,
        input.difficulty as string,
      );

    case "generate_hint":
      return generateHint(
        input.question as string,
        input.subject as string,
        input.difficulty as string,
      );

    case "explain_solution":
      return explain(
        input.answer as string,
        input.steps as string[],
        input.difficulty as string,
      );

    case "lookup_curriculum":
      return lookupCurriculum(input.subject as string, input.year as string);

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
): Promise<AgentResult> => {
  const userContent = question;

  const messages: BedrockMessage[] = [
    { role: "user", content: [{ text: userContent }] },
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
