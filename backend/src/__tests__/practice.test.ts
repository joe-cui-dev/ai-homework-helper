import {
  runPracticeTurn,
  TOOL_SCHEMA,
  MAX_PROBLEMS_PER_SESSION,
  MAX_TOOL_CALLS_PER_SESSION,
} from "../practice/practice";
import type { CoachingPacket } from "../shared/types";
import type { PracticeSession } from "../shared/session";
import type { AgentSidecar } from "../shared/sessionStore";

jest.mock("../shared/bedrock", () => ({
  converseWithTools: jest.fn(),
  callClaude: jest.fn(),
  buildUsage: (i: number, o: number, _modelChoice = "fast") => ({
    inputTokens: i,
    outputTokens: o,
    costUsd: 0,
  }),
  sumUsage: (...usages: { inputTokens: number; outputTokens: number }[]) => {
    let i = 0;
    let o = 0;
    for (const u of usages) {
      i += u.inputTokens;
      o += u.outputTokens;
    }
    return { inputTokens: i, outputTokens: o, costUsd: 0 };
  },
}));

jest.mock("../shared/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { converseWithTools, callClaude } = jest.requireMock("../shared/bedrock") as {
  converseWithTools: jest.Mock;
  callClaude: jest.Mock;
};

const PACKET: CoachingPacket = {
  questionId: 1,
  tldrAnswer: "12",
  whyItWorks: "Two-digit addition with no regrouping.",
  childHint: "What's 5 plus 7?",
};

const blankSession = (overrides: Partial<PracticeSession> = {}): PracticeSession => ({
  sessionType: "practice",
  sessionId: "p-1",
  studentId: "student-1",
  modelChoice: "fast",
  timestamp: "2026-05-01T00:00:00Z",
  updatedAt: "2026-05-01T00:00:00Z",
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  status: "active",
  origin: { sessionId: "batch-1", questionId: 1 },
  subject: "math",
  yearLevel: "year-3",
  sourceCoachingPacket: PACKET,
  problemCount: 0,
  toolCallCount: 0,
  problems: [],
  toolLog: [],
  ...overrides,
});

const blankSidecar = (): AgentSidecar => ({
  bedrockMessages: [],
  usagePerTurn: [],
});

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

const toolUseResponse = (
  blocks: Array<{ name: string; input: unknown; toolUseId?: string }>,
) => ({
  stopReason: "tool_use",
  usage: ZERO_USAGE,
  message: {
    role: "assistant",
    content: blocks.map((b, i) => ({
      toolUse: {
        toolUseId: b.toolUseId ?? `t${i}`,
        name: b.name,
        input: b.input,
      },
    })),
  },
});

// Wrap a JSON-string Claude response in the new { text, usage } shape.
const claudeResult = (text: string) => ({ text, usage: ZERO_USAGE });

beforeEach(() => {
  converseWithTools.mockReset();
  callClaude.mockReset();
});

// ── Tool schema sanity ─────────────────────────────────────────────────────

describe("TOOL_SCHEMA", () => {
  it("has the 7 expected tools", () => {
    const names = TOOL_SCHEMA.map((t) => t.toolSpec?.name).sort();
    expect(names).toEqual([
      "change_teaching_style",
      "end_turn",
      "evaluate_attempt",
      "generate_problem",
      "give_hint",
      "lookup_prerequisite_skill",
      "worked_example",
    ]);
  });
});

// ── System prompt — sourced from session, not packet ──────────────────────

describe("runPracticeTurn — system prompt", () => {
  it("interpolates session.subject and session.yearLevel, and does not reference watchFor or hardcode 'primary-school'", async () => {
    callClaude.mockResolvedValueOnce(
      claudeResult(
        JSON.stringify({ problem: "What is 5 + 7?", expectedAnswer: "12" }),
      ),
    );
    converseWithTools
      .mockResolvedValueOnce(
        toolUseResponse([
          { name: "generate_problem", input: { difficulty: "easier" } },
        ]),
      )
      .mockResolvedValueOnce(
        toolUseResponse([
          {
            name: "end_turn",
            input: {
              agentMessage: "Let's start with: What is 5 + 7?",
              problem: "What is 5 + 7?",
              isSessionEnded: false,
            },
          },
        ]),
      );

    await runPracticeTurn(
      blankSession({ subject: "science", yearLevel: "year-5" }),
      blankSidecar(),
      { onEvent: () => {} },
    );

    // converseWithTools is called with (messages, tools, systemPrompt, ...).
    const systemPrompt = converseWithTools.mock.calls[0][2] as string;
    expect(systemPrompt).toContain("science");
    expect(systemPrompt).toContain("year-5");
    expect(systemPrompt).not.toContain("watchFor");
    expect(systemPrompt).not.toContain("primary-school");
  });
});

// ── Cold start: agent generates a warm-up + ends turn ──────────────────────

describe("runPracticeTurn — cold start", () => {
  it("seeds messages with a kickoff and runs generate_problem → end_turn", async () => {
    callClaude.mockResolvedValueOnce(
      claudeResult(
        JSON.stringify({ problem: "What is 5 + 7?", expectedAnswer: "12" }),
      ),
    );
    converseWithTools
      .mockResolvedValueOnce(
        toolUseResponse([
          { name: "generate_problem", input: { difficulty: "easier" } },
        ]),
      )
      .mockResolvedValueOnce(
        toolUseResponse([
          {
            name: "end_turn",
            input: {
              agentMessage: "Let's start with: What is 5 + 7?",
              problem: "What is 5 + 7?",
              isSessionEnded: false,
            },
          },
        ]),
      );

    const session = blankSession();
    const sidecar = blankSidecar();
    const events: string[] = [];
    const result = await runPracticeTurn(session, sidecar, {
      onEvent: (e) => events.push(`${e.type}:${"tool" in e ? e.tool : ""}`),
    });

    expect(result.problem).toBe("What is 5 + 7?");
    expect(result.isSessionEnded).toBe(false);
    expect(session.problemCount).toBe(1);
    expect(session.toolCallCount).toBe(1); // end_turn does not count
    expect(session.problems[0].expectedAnswer).toBe("12");
    expect(events).toContain("tool_start:generate_problem");
    expect(events).toContain("tool_end:generate_problem");
    expect(events).toContain("tool_start:end_turn");
  });
});

// ── Verdict-driven branching ───────────────────────────────────────────────

describe("runPracticeTurn — recovery branching", () => {
  it("on concept_gap, dispatches worked_example then generates an easier problem", async () => {
    // Two prior problems already.
    const session = blankSession({
      problemCount: 2,
      toolCallCount: 4,
      problems: [
        { problemIndex: 0, problem: "5+7", expectedAnswer: "12", difficulty: "easier" },
        { problemIndex: 1, problem: "8+6", expectedAnswer: "14", difficulty: "same" },
      ],
    });
    const sidecar = blankSidecar();

    callClaude
      .mockResolvedValueOnce(
        // evaluate_attempt
        claudeResult(
          JSON.stringify({
            verdict: "concept_gap",
            explanation: "Used subtraction instead of addition.",
          }),
        ),
      )
      .mockResolvedValueOnce(
        // worked_example
        claudeResult(
          JSON.stringify({ example: "Worked: 4+3=7. Add 4 and 3 together." }),
        ),
      )
      .mockResolvedValueOnce(
        // generate_problem
        claudeResult(JSON.stringify({ problem: "3+4", expectedAnswer: "7" })),
      );

    converseWithTools
      .mockResolvedValueOnce(
        toolUseResponse([
          { name: "evaluate_attempt", input: { childResponse: "2" } },
        ]),
      )
      .mockResolvedValueOnce(
        toolUseResponse([{ name: "worked_example", input: {} }]),
      )
      .mockResolvedValueOnce(
        toolUseResponse([
          { name: "generate_problem", input: { difficulty: "easier" } },
        ]),
      )
      .mockResolvedValueOnce(
        toolUseResponse([
          {
            name: "end_turn",
            input: {
              agentMessage: "Walked through a worked example. New problem: 3+4.",
              problem: "3+4",
              isSessionEnded: false,
            },
          },
        ]),
      );

    const result = await runPracticeTurn(session, sidecar, {
      parentMessage: "Kid said 2",
    });

    expect(result.isSessionEnded).toBe(false);
    expect(result.problem).toBe("3+4");
    const log = session.toolLog.map((e) => e.tool);
    expect(log).toContain("evaluate_attempt");
    expect(log).toContain("worked_example");
    expect(log).toContain("generate_problem");
  });
});

// ── Mastery exit ────────────────────────────────────────────────────────────

describe("runPracticeTurn — mastery", () => {
  it("agent calls end_turn(isSessionEnded=true, mastered) and status flips", async () => {
    const session = blankSession({
      problemCount: 3,
      problems: [
        { problemIndex: 0, problem: "p1", expectedAnswer: "a", difficulty: "easier" },
        { problemIndex: 1, problem: "p2", expectedAnswer: "b", difficulty: "same" },
        { problemIndex: 2, problem: "p3", expectedAnswer: "c", difficulty: "harder" },
      ],
    });
    const sidecar = blankSidecar();

    callClaude.mockResolvedValueOnce(
      claudeResult(
        JSON.stringify({ verdict: "correct", explanation: "Right." }),
      ),
    );
    converseWithTools
      .mockResolvedValueOnce(
        toolUseResponse([
          { name: "evaluate_attempt", input: { childResponse: "c" } },
        ]),
      )
      .mockResolvedValueOnce(
        toolUseResponse([
          {
            name: "end_turn",
            input: {
              agentMessage: "Looks like your kid's got it!",
              isSessionEnded: true,
              endedReason: "mastered",
              finalSummary: "3 problems, 3 correct. Concept mastered.",
            },
          },
        ]),
      );

    const result = await runPracticeTurn(session, sidecar, {
      parentMessage: "Kid said c",
    });

    expect(result.isSessionEnded).toBe(true);
    expect(result.endedReason).toBe("mastered");
    expect(session.status).toBe("ended");
    expect(session.endedReason).toBe("mastered");
    expect(session.finalSummary).toContain("mastered");
  });
});

// ── Cost guardrails ─────────────────────────────────────────────────────────

describe("runPracticeTurn — guardrails", () => {
  it("generate_problem refuses past MAX_PROBLEMS_PER_SESSION", async () => {
    const session = blankSession({
      problemCount: MAX_PROBLEMS_PER_SESSION,
      problems: Array.from({ length: MAX_PROBLEMS_PER_SESSION }, (_, i) => ({
        problemIndex: i,
        problem: `p${i}`,
        expectedAnswer: "x",
        difficulty: "same" as const,
      })),
    });
    const sidecar = blankSidecar();

    converseWithTools
      .mockResolvedValueOnce(
        toolUseResponse([
          { name: "generate_problem", input: { difficulty: "same" } },
        ]),
      )
      .mockResolvedValueOnce(
        toolUseResponse([
          {
            name: "end_turn",
            input: {
              agentMessage: "Reached the problem cap.",
              isSessionEnded: true,
              endedReason: "partial",
              finalSummary: "Reached cap.",
            },
          },
        ]),
      );

    const result = await runPracticeTurn(session, sidecar, {
      parentMessage: "more please",
    });
    expect(result.isSessionEnded).toBe(true);

    // The dispatcher returns an error toolResult to the agent — verify by
    // checking that the conversation includes a status:"error" tool result.
    const hasError = sidecar.bedrockMessages.some((m) =>
      (m.content ?? []).some((b) => {
        const tr = (b as Record<string, unknown>).toolResult as
          | { status?: string }
          | undefined;
        return tr?.status === "error";
      }),
    );
    expect(hasError).toBe(true);
    expect(session.problemCount).toBe(MAX_PROBLEMS_PER_SESSION); // not incremented
  });

  it("dispatcher refuses past MAX_TOOL_CALLS_PER_SESSION", async () => {
    const session = blankSession({
      toolCallCount: MAX_TOOL_CALLS_PER_SESSION,
    });
    const sidecar = blankSidecar();

    converseWithTools
      .mockResolvedValueOnce(
        toolUseResponse([{ name: "give_hint", input: {} }]),
      )
      .mockResolvedValueOnce(
        toolUseResponse([
          {
            name: "end_turn",
            input: {
              agentMessage: "Wrapping up.",
              isSessionEnded: true,
              endedReason: "abandoned",
              finalSummary: "Cap hit.",
            },
          },
        ]),
      );

    await runPracticeTurn(session, sidecar, { parentMessage: "still stuck" });
    const hasError = sidecar.bedrockMessages.some((m) =>
      (m.content ?? []).some((b) => {
        const tr = (b as Record<string, unknown>).toolResult as
          | { status?: string }
          | undefined;
        return tr?.status === "error";
      }),
    );
    expect(hasError).toBe(true);
  });
});

// ── forceEndSession ─────────────────────────────────────────────────────────

describe("runPracticeTurn — forceEndSession", () => {
  it("forces toolChoice to end_turn on the first iteration", async () => {
    const session = blankSession({
      problemCount: 2,
      problems: [
        { problemIndex: 0, problem: "p1", expectedAnswer: "a", difficulty: "easier" },
        { problemIndex: 1, problem: "p2", expectedAnswer: "b", difficulty: "same" },
      ],
    });
    const sidecar = blankSidecar();

    converseWithTools.mockResolvedValueOnce(
      toolUseResponse([
        {
          name: "end_turn",
          input: {
            agentMessage: "Recap of what we covered.",
            isSessionEnded: true,
            endedReason: "abandoned",
            finalSummary: "Parent ended early; 2 problems attempted.",
          },
        },
      ]),
    );

    const result = await runPracticeTurn(session, sidecar, { forceEndSession: true });

    expect(result.isSessionEnded).toBe(true);
    expect(result.endedReason).toBe("abandoned");
    const [, , , toolChoice] = converseWithTools.mock.calls[0];
    expect(toolChoice).toEqual({ tool: { name: "end_turn" } });
  });
});

// ── Guardrail intervention ─────────────────────────────────────────────────

describe("runPracticeTurn — guardrail", () => {
  it("throws with the guardrail message", async () => {
    converseWithTools.mockResolvedValueOnce({
      stopReason: "guardrail_intervened",
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      message: {
        role: "assistant",
        content: [{ text: "Blocked by content filter." }],
      },
    });

    await expect(
      runPracticeTurn(blankSession(), blankSidecar(), { parentMessage: "bad" }),
    ).rejects.toThrow(/Blocked by content filter/);
  });
});
