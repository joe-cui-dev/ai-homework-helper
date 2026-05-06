// ── Practice Tutor Loop ──────────────────────────────────────────────────────
// Multi-turn agentic loop. Tool choice on every turn depends on the kid's
// attempt outcome — the iteration count is variable, the same input can
// legitimately lead to four different recovery strategies depending on the
// diagnosis.
//
// Per-turn flow:
//   1. handler appends the parent's message to session.messages.
//   2. runPracticeTurn calls converseWithTools repeatedly (up to MAX_ITERATIONS_PER_TURN).
//   3. Each iteration the agent picks tools; we dispatch them, append results.
//   4. Loop ends when the agent calls end_turn (terminal tool).
//   5. handler persists the updated session and emits turn_complete.
//
// Cost guardrails are enforced in the dispatcher (not just the prompt).
// ─────────────────────────────────────────────────────────────────────────────
import type { RawTokenUsage, Tool, BedrockMessage } from "../shared/bedrock";
import { buildUsage, callClaude, converseWithTools, sumUsage } from "../shared/bedrock";
import type {
  CoachingPacket,
  PracticeProblem,
  PracticeSession,
  PracticeStreamEvent,
  TeachingStyle,
  Verdict,
} from "../shared/types";
import { logger } from "../shared/logger";

export const MAX_ITERATIONS_PER_TURN = 5;
export const MAX_PROBLEMS_PER_SESSION = 10;
export const MAX_TOOL_CALLS_PER_SESSION = 40;

// Result of a single turn — handler persists the updated session and emits
// turn_complete to the client.
export interface TurnResult {
  session: PracticeSession;
  agentMessage: string;
  problem?: string;
  isSessionEnded: boolean;
  endedReason?: PracticeSession["endedReason"];
  finalSummary?: string;
  // Usage incurred during this turn only (sum of all Bedrock calls inside the
  // agent loop + any inner tool dispatches).
  turnUsage: RawTokenUsage;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const buildSystemPrompt = (packet: CoachingPacket): string => `You are a Practice Tutor agent. The reader of your messages is the PARENT, who will read problems aloud to their child and report what the child says.

Source homework question this practice session is anchored to:
- Subject: ${packet.subject}
- Year level: ${packet.yearLevel}
- Concept being practised (whyItWorks): ${packet.whyItWorks}
- Common misconceptions to test for (watchFor): ${packet.watchFor.join("; ")}

Your job is to run a focused practice session of 3–5 problems. Each turn:
1. If this is the very first turn, call generate_problem(difficulty="easier") to start with a warm-up.
2. If the parent has reported a child's attempt, call evaluate_attempt first, then choose a follow-up tool based on the verdict (see strategy below), then call end_turn.
3. Always finish a turn by calling end_turn exactly once.

VERDICT-DRIVEN STRATEGY (after evaluate_attempt):
- verdict="correct" → if you have 2–3 consecutive corrects without recovery tools used, call end_turn with isSessionEnded=true and endedReason="mastered". Otherwise call generate_problem with difficulty="same" or "harder" depending on the kid's track record, then end_turn.
- verdict="careless_slip" → call give_hint and ask the parent to have the kid recheck the same problem. Don't generate a new problem yet.
- verdict="concept_gap" → call worked_example OR change_teaching_style (pick whichever fits — change_teaching_style if a previous explanation already failed; worked_example if this is the first failure on this concept). Then generate_problem(difficulty="easier") and end_turn.
- verdict="different_concept" → call lookup_prerequisite_skill to name the foundational skill the child is missing. Then generate_problem(difficulty="easier", focus=<that skill>) and end_turn.
- verdict="stuck" (kid froze, no answer) → call give_hint and end_turn without generating a new problem.

PARENT-FACING TONE:
- agentMessage is read by the parent; use adult prose, no emojis, no second-person addressed to a child.
- Any text the parent will read aloud (problem text, hint, worked_example, altExplanation) must be calibrated to the child's year level (${packet.yearLevel}).

ENDING THE SESSION:
- Mastery: 2–3 consecutive corrects without recovery tools used → end_turn(isSessionEnded=true, endedReason="mastered").
- Partial: persistent struggle through 3 problems despite multiple recovery tools → end_turn(isSessionEnded=true, endedReason="partial").
- Hard cap: never exceed 10 problems in a session.
- If the parent indicates they want to stop, end gracefully.

Always finish every turn with exactly one end_turn call.`;

// ---------------------------------------------------------------------------
// Tool schema (7 tools)
// ---------------------------------------------------------------------------

export const TOOL_SCHEMA: Tool[] = [
  {
    toolSpec: {
      name: "generate_problem",
      description:
        "Generate the next practice problem at the requested difficulty. Use difficulty='easier' for warm-ups and after concept gaps; 'same' to consolidate; 'harder' to extend mastery. Returns the problem text and the expected answer (cached server-side).",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            difficulty: { type: "string", enum: ["easier", "same", "harder"] },
            focus: {
              type: "string",
              description:
                "Optional sub-skill or concept to focus on (e.g. 'place value', 'subject-verb agreement').",
            },
          },
          required: ["difficulty"],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "evaluate_attempt",
      description:
        "Diagnose the child's most recent attempt as reported by the parent. Returns a verdict that drives your next tool choice.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            childResponse: {
              type: "string",
              description:
                "Verbatim or paraphrased version of what the child said or wrote, as reported by the parent.",
            },
          },
          required: ["childResponse"],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "give_hint",
      description:
        "Produce a short Socratic prompt the parent can read aloud to nudge the child without giving the answer away.",
      inputSchema: {
        json: { type: "object", properties: {}, required: [] },
      },
    },
  },
  {
    toolSpec: {
      name: "worked_example",
      description:
        "Produce a fully-worked example of the same concept as the current problem, to be read aloud to a child of this year level.",
      inputSchema: {
        json: { type: "object", properties: {}, required: [] },
      },
    },
  },
  {
    toolSpec: {
      name: "change_teaching_style",
      description:
        "Re-explain the current concept using a different teaching style. Pick this when a previous explanation isn't landing.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            style: {
              type: "string",
              enum: ["visual", "story", "manipulatives", "number_line", "real_world"],
            },
          },
          required: ["style"],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "lookup_prerequisite_skill",
      description:
        "Name the foundational skill the child seems to be missing, with a one-sentence rationale. Use this on verdict='different_concept'.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            concept: {
              type: "string",
              description:
                "The current problem's concept that the child is failing on.",
            },
          },
          required: ["concept"],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "end_turn",
      description:
        "Finish this turn. Always call this exactly once per turn, last. agentMessage is what the parent reads. Set isSessionEnded=true only when the session itself should end (mastery, partial, or abandonment).",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            agentMessage: {
              type: "string",
              description:
                "The parent-facing message for this turn. Adult tone. May reference the new problem or the recovery action.",
            },
            problem: {
              type: "string",
              description:
                "If a new problem was generated this turn, repeat its text here so the client can render it. Omit on hint-only or session-end turns without a new problem.",
            },
            isSessionEnded: { type: "boolean" },
            endedReason: {
              type: "string",
              enum: ["mastered", "partial", "abandoned"],
              description: "Required when isSessionEnded=true.",
            },
            finalSummary: {
              type: "string",
              description:
                "Required when isSessionEnded=true. A short adult-tone summary of how the session went, suitable for showing on a history card.",
            },
          },
          required: ["agentMessage", "isSessionEnded"],
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool implementations — most are single Bedrock InvokeModel calls.
// Each implementation also mutates `session` (counters, problem cache, log).
// ---------------------------------------------------------------------------

const stripJsonFences = (raw: string): string => {
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (match ? match[1] : raw).trim();
};

const safeJsonParse = <T>(raw: string, fallback: T): T => {
  try {
    return JSON.parse(stripJsonFences(raw)) as T;
  } catch {
    return fallback;
  }
};

const currentProblem = (session: PracticeSession): PracticeProblem | undefined =>
  session.problems[session.problems.length - 1];

type AccumulateUsage = (usage: RawTokenUsage) => void;

const generateProblem = async (
  session: PracticeSession,
  input: { difficulty: "easier" | "same" | "harder"; focus?: string },
  accumulateUsage: AccumulateUsage,
): Promise<{ problem: string; difficulty: string }> => {
  if (session.problemCount >= MAX_PROBLEMS_PER_SESSION) {
    throw new Error(
      `Session has reached the problem cap (${MAX_PROBLEMS_PER_SESSION}). Please call end_turn now.`,
    );
  }
  const packet = session.sourceCoachingPacket;
  const previousProblems = session.problems
    .map((p, i) => `${i + 1}. ${p.problem}`)
    .join("\n");

  const prompt = `Generate ONE practice problem at difficulty "${input.difficulty}" for a ${packet.yearLevel} student practising ${packet.subject}.
The original homework question's concept: ${packet.whyItWorks}
${input.focus ? `Focus this problem on: ${input.focus}\n` : ""}${previousProblems ? `Previously generated problems (do not duplicate):\n${previousProblems}\n` : ""}
Return ONLY valid JSON with no markdown fences:
{ "problem": "<problem text the parent will read to the child>", "expectedAnswer": "<the correct answer in concise form>" }`;

  const { text: raw, usage } = await callClaude(prompt, 0.4);
  accumulateUsage(usage);
  const parsed = safeJsonParse(raw, { problem: "", expectedAnswer: "" });
  if (!parsed.problem || !parsed.expectedAnswer) {
    throw new Error("Failed to generate a practice problem. Please try again.");
  }

  session.problems.push({
    problemIndex: session.problems.length,
    problem: parsed.problem,
    expectedAnswer: parsed.expectedAnswer,
    difficulty: input.difficulty,
  });
  session.problemCount += 1;

  return { problem: parsed.problem, difficulty: input.difficulty };
};

const evaluateAttempt = async (
  session: PracticeSession,
  input: { childResponse: string },
  accumulateUsage: AccumulateUsage,
): Promise<{ verdict: Verdict; explanation: string; suggestedNext?: string }> => {
  const cur = currentProblem(session);
  if (!cur) {
    throw new Error(
      "No active problem to evaluate. Call generate_problem before evaluate_attempt.",
    );
  }
  const packet = session.sourceCoachingPacket;
  const prompt = `You are diagnosing a child's attempt on a practice problem.

Year level: ${packet.yearLevel}
Subject: ${packet.subject}
Concept being practised: ${packet.whyItWorks}
Common misconceptions: ${packet.watchFor.join("; ")}

Problem: ${cur.problem}
Expected answer: ${cur.expectedAnswer}
Child's reported response: ${input.childResponse}

Classify the attempt as ONE of:
- "correct": matches expected answer (allowing for minor formatting differences)
- "careless_slip": method is right but a small arithmetic/transcription mistake; child likely knows the concept
- "concept_gap": child applied the wrong method for THIS concept (e.g. used addition when subtraction was needed within the same domain)
- "different_concept": child's error reveals a foundational/prerequisite skill is missing (not just this concept)
- "stuck": child gave no answer or said they don't know

Return ONLY valid JSON with no markdown fences:
{ "verdict": "<one of the above>", "explanation": "<one short adult-tone sentence explaining the diagnosis>", "suggestedNext": "<optional one-line non-binding suggestion>" }`;

  const { text: raw, usage } = await callClaude(prompt, 0.2);
  accumulateUsage(usage);
  const parsed = safeJsonParse(raw, {
    verdict: "stuck" as Verdict,
    explanation: "Could not parse the diagnosis.",
  });
  return parsed;
};

const giveHint = async (
  session: PracticeSession,
  accumulateUsage: AccumulateUsage,
): Promise<{ hint: string }> => {
  const cur = currentProblem(session);
  if (!cur) {
    throw new Error("No active problem; cannot generate a hint.");
  }
  const packet = session.sourceCoachingPacket;
  const prompt = `Generate ONE short Socratic hint the parent can read aloud to a ${packet.yearLevel} child working on this problem. Do NOT give the answer.

Problem: ${cur.problem}
Concept: ${packet.whyItWorks}

Return ONLY valid JSON: { "hint": "<one short year-level-appropriate Socratic prompt>" }`;
  const { text: raw, usage } = await callClaude(prompt, 0.4);
  accumulateUsage(usage);
  const parsed = safeJsonParse(raw, { hint: "" });
  if (!parsed.hint) throw new Error("Failed to generate a hint.");
  return parsed;
};

const workedExample = async (
  session: PracticeSession,
  accumulateUsage: AccumulateUsage,
): Promise<{ example: string }> => {
  const cur = currentProblem(session);
  if (!cur) {
    throw new Error("No active problem; cannot show a worked example.");
  }
  const packet = session.sourceCoachingPacket;
  const prompt = `Produce a fully-worked example of the same concept as the current practice problem, calibrated to a ${packet.yearLevel} child. Use a DIFFERENT problem (not the current one). Walk through every step in plain language the parent will read aloud.

Current problem (do not solve this; show a similar one): ${cur.problem}
Concept: ${packet.whyItWorks}

Return ONLY valid JSON: { "example": "<the worked example, multi-line plain text>" }`;
  const { text: raw, usage } = await callClaude(prompt, 0.3);
  accumulateUsage(usage);
  const parsed = safeJsonParse(raw, { example: "" });
  if (!parsed.example) throw new Error("Failed to produce a worked example.");
  return parsed;
};

const changeTeachingStyle = async (
  session: PracticeSession,
  input: { style: TeachingStyle },
  accumulateUsage: AccumulateUsage,
): Promise<{ altExplanation: string }> => {
  const cur = currentProblem(session);
  if (!cur) {
    throw new Error("No active problem; cannot change teaching style.");
  }
  const packet = session.sourceCoachingPacket;
  const prompt = `Re-explain the concept of the current practice problem using the "${input.style}" teaching style, calibrated to a ${packet.yearLevel} child. The parent will read this aloud or use it to guide the child.

Problem: ${cur.problem}
Concept: ${packet.whyItWorks}

Style guidance:
- visual: describe a picture/diagram the parent can sketch.
- story: embed the concept in a short story.
- manipulatives: instruct the parent to use household objects (counters, blocks, fruit).
- number_line: use a number line representation.
- real_world: use a concrete real-world scenario the child can relate to.

Return ONLY valid JSON: { "altExplanation": "<the alternative explanation, plain text>" }`;
  const { text: raw, usage } = await callClaude(prompt, 0.4);
  accumulateUsage(usage);
  const parsed = safeJsonParse(raw, { altExplanation: "" });
  if (!parsed.altExplanation) {
    throw new Error("Failed to produce an alternative explanation.");
  }
  return parsed;
};

const lookupPrerequisiteSkill = async (
  session: PracticeSession,
  input: { concept: string },
  accumulateUsage: AccumulateUsage,
): Promise<{ prerequisite: string; why: string }> => {
  const packet = session.sourceCoachingPacket;
  const prompt = `Identify the single foundational/prerequisite skill a ${packet.yearLevel} child needs in order to master "${input.concept}". The child has shown they're missing it.

Subject: ${packet.subject}

Return ONLY valid JSON: { "prerequisite": "<short name of the prerequisite skill>", "why": "<one short adult-tone sentence explaining why mastering this prerequisite unblocks the current concept>" }`;
  const { text: raw, usage } = await callClaude(prompt, 0.2);
  accumulateUsage(usage);
  const parsed = safeJsonParse(raw, { prerequisite: "", why: "" });
  if (!parsed.prerequisite) {
    throw new Error("Failed to look up the prerequisite skill.");
  }
  return parsed;
};

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export const dispatchPracticeTool = async (
  session: PracticeSession,
  name: string,
  input: Record<string, unknown>,
  turnIndex: number,
  accumulateUsage: AccumulateUsage = () => undefined,
): Promise<unknown> => {
  // end_turn is captured by the loop, never reaches here.
  // All other tools count toward the per-session cap.
  if (session.toolCallCount >= MAX_TOOL_CALLS_PER_SESSION) {
    throw new Error(
      `Session has reached the tool-call cap (${MAX_TOOL_CALLS_PER_SESSION}). Please call end_turn now.`,
    );
  }
  session.toolCallCount += 1;
  session.toolLog.push({ turn: turnIndex, tool: name, ts: new Date().toISOString() });

  switch (name) {
    case "generate_problem":
      return generateProblem(
        session,
        input as { difficulty: "easier" | "same" | "harder"; focus?: string },
        accumulateUsage,
      );
    case "evaluate_attempt":
      return evaluateAttempt(
        session,
        input as { childResponse: string },
        accumulateUsage,
      );
    case "give_hint":
      return giveHint(session, accumulateUsage);
    case "worked_example":
      return workedExample(session, accumulateUsage);
    case "change_teaching_style":
      return changeTeachingStyle(
        session,
        input as { style: TeachingStyle },
        accumulateUsage,
      );
    case "lookup_prerequisite_skill":
      return lookupPrerequisiteSkill(
        session,
        input as { concept: string },
        accumulateUsage,
      );
    default:
      throw new Error(`Unknown practice tool: ${name}`);
  }
};

// ---------------------------------------------------------------------------
// Per-turn agent loop
// ---------------------------------------------------------------------------

export interface RunTurnOptions {
  // If set, this is appended to messages as a parent message before the loop runs.
  // Used by /practice/turn. /practice/start passes undefined.
  parentMessage?: string;
  // If set, the agent is forced to call end_turn(isSessionEnded=true) on its
  // first iteration. Used by /practice/end.
  forceEndSession?: boolean;
  onEvent?: (event: PracticeStreamEvent) => void;
}

export const runPracticeTurn = async (
  session: PracticeSession,
  options: RunTurnOptions = {},
): Promise<TurnResult> => {
  const { parentMessage, forceEndSession, onEvent } = options;

  // Append parent input (if any) BEFORE the loop, so the agent sees it on its
  // first iteration.
  if (parentMessage !== undefined) {
    const text = forceEndSession
      ? `[The parent has clicked End practice. Produce a recap and call end_turn with isSessionEnded=true and endedReason="abandoned".]${parentMessage ? `\n\nParent note: ${parentMessage}` : ""}`
      : parentMessage;
    session.messages.push({ role: "user", content: [{ text }] });
  } else if (forceEndSession) {
    session.messages.push({
      role: "user",
      content: [
        {
          text: `[The parent has clicked End practice. Produce a recap and call end_turn with isSessionEnded=true and endedReason="abandoned".]`,
        },
      ],
    });
  } else if (session.messages.length === 0) {
    // Cold start of a session — seed with a synthetic kickoff message.
    session.messages.push({
      role: "user",
      content: [{ text: "[Start the session. Produce a warm-up problem.]" }],
    });
  }

  const turnIndex = session.toolLog.reduce(
    (max, e) => Math.max(max, e.turn),
    -1,
  ) + 1;

  const systemPrompt = buildSystemPrompt(session.sourceCoachingPacket);

  // Accumulator for every Bedrock call inside this turn (the converseWithTools
  // calls in the loop below + every tool implementation that calls callClaude).
  let turnInput = 0;
  let turnOutput = 0;
  const accumulateUsage: AccumulateUsage = (u) => {
    turnInput += u.inputTokens;
    turnOutput += u.outputTokens;
  };

  for (let iteration = 0; iteration < MAX_ITERATIONS_PER_TURN; iteration++) {
    logger.debug("practice_iteration", {
      iteration,
      turnIndex,
      problemCount: session.problemCount,
      toolCallCount: session.toolCallCount,
    });

    const toolChoice = forceEndSession && iteration === 0
      ? { tool: { name: "end_turn" } }
      : { any: {} };

    const response = await converseWithTools(
      session.messages,
      TOOL_SCHEMA,
      systemPrompt,
      toolChoice,
      4096,
    );
    accumulateUsage(response.usage);

    session.messages.push(response.message);

    if (response.stopReason === "guardrail_intervened") {
      const guardrailMessage =
        (response.message.content ?? [])
          .map((b) => (b as { text?: string }).text)
          .filter(Boolean)
          .join(" ") ||
        "Your message was blocked by the content filter.";
      logger.warn("practice_guardrail_intervened", { message: guardrailMessage });
      throw new Error(guardrailMessage);
    }

    if (response.stopReason !== "tool_use") {
      logger.error("practice_unexpected_stop", {
        stopReason: response.stopReason,
      });
      throw new Error(
        `Practice agent ended unexpectedly (stopReason=${response.stopReason}).`,
      );
    }

    const toolResultBlocks: Record<string, unknown>[] = [];
    interface EndTurnInput {
      agentMessage: string;
      problem?: string;
      isSessionEnded: boolean;
      endedReason?: PracticeSession["endedReason"];
      finalSummary?: string;
    }
    let endTurnInput: EndTurnInput | null = null;

    for (const block of response.message.content ?? []) {
      const toolUse = block.toolUse as
        | { toolUseId: string; name: string; input: unknown }
        | undefined;
      if (!toolUse) continue;
      const { toolUseId, name, input } = toolUse;

      onEvent?.({ type: "tool_start", tool: name });

      if (name === "end_turn") {
        endTurnInput = input as EndTurnInput;
        toolResultBlocks.push({
          toolResult: {
            toolUseId,
            content: [{ text: "Turn ended." }],
            status: "success",
          },
        });
        onEvent?.({ type: "tool_end", tool: name });
      } else {
        try {
          const result = await dispatchPracticeTool(
            session,
            name,
            input as Record<string, unknown>,
            turnIndex,
            accumulateUsage,
          );
          toolResultBlocks.push({
            toolResult: {
              toolUseId,
              content: [{ text: JSON.stringify(result) }],
              status: "success",
            },
          });
        } catch (err) {
          logger.warn("practice_tool_error", {
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

    session.messages.push({ role: "user", content: toolResultBlocks });

    if (endTurnInput) {
      session.updatedAt = new Date().toISOString();
      if (endTurnInput.isSessionEnded) {
        session.status = "ended";
        session.endedReason = endTurnInput.endedReason;
        session.finalSummary = endTurnInput.finalSummary;
      }
      const turnUsage = buildUsage(turnInput, turnOutput);
      session.totalUsage = sumUsage(session.totalUsage, turnUsage);
      return {
        session,
        agentMessage: endTurnInput.agentMessage,
        problem: endTurnInput.problem,
        isSessionEnded: endTurnInput.isSessionEnded,
        endedReason: endTurnInput.endedReason,
        finalSummary: endTurnInput.finalSummary,
        turnUsage,
      };
    }
  }

  logger.error("practice_max_iterations_exceeded", { turnIndex });
  throw new Error(
    `Practice agent exceeded MAX_ITERATIONS_PER_TURN (${MAX_ITERATIONS_PER_TURN}) without calling end_turn`,
  );
};
