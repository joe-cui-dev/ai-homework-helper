import {
  runPracticeTurn,
  TOOL_SCHEMA,
  MAX_PROBLEMS_PER_SESSION,
  MAX_TOOL_CALLS_PER_SESSION,
} from "../practice";
import type { CoachingPacket, PracticeSession } from "../types";

jest.mock("../bedrock", () => ({
  converseWithTools: jest.fn(),
  callClaude: jest.fn(),
}));

jest.mock("../logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { converseWithTools, callClaude } = jest.requireMock("../bedrock") as {
  converseWithTools: jest.Mock;
  callClaude: jest.Mock;
};

const PACKET: CoachingPacket = {
  questionId: 1,
  subject: "math",
  yearLevel: "year-3",
  tldrAnswer: "12",
  whyItWorks: "Two-digit addition with no regrouping.",
  howToCoach: "Use base-ten blocks.",
  watchFor: ["Forgetting place value", "Adding tens to ones"],
  childHint: "What's 5 plus 7?",
};

const blankSession = (overrides: Partial<PracticeSession> = {}): PracticeSession => ({
  practiceSessionId: "batch-1:1",
  studentId: "student-1",
  sourceBatchId: "batch-1",
  sourceQuestionId: 1,
  sourceCoachingPacket: PACKET,
  createdAt: "2026-05-01T00:00:00Z",
  updatedAt: "2026-05-01T00:00:00Z",
  status: "active",
  problemCount: 0,
  toolCallCount: 0,
  problems: [],
  messages: [],
  toolLog: [],
  ...overrides,
});

const toolUseResponse = (
  blocks: Array<{ name: string; input: unknown; toolUseId?: string }>,
) => ({
  stopReason: "tool_use",
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

// ── Cold start: agent generates a warm-up + ends turn ──────────────────────

describe("runPracticeTurn — cold start", () => {
  it("seeds messages with a kickoff and runs generate_problem → end_turn", async () => {
    callClaude.mockResolvedValueOnce(
      JSON.stringify({ problem: "What is 5 + 7?", expectedAnswer: "12" }),
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
    const events: string[] = [];
    const result = await runPracticeTurn(session, {
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

    callClaude
      .mockResolvedValueOnce(
        // evaluate_attempt
        JSON.stringify({
          verdict: "concept_gap",
          explanation: "Used subtraction instead of addition.",
        }),
      )
      .mockResolvedValueOnce(
        // worked_example
        JSON.stringify({ example: "Worked: 4+3=7. Add 4 and 3 together." }),
      )
      .mockResolvedValueOnce(
        // generate_problem
        JSON.stringify({ problem: "3+4", expectedAnswer: "7" }),
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

    const result = await runPracticeTurn(session, {
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

    callClaude.mockResolvedValueOnce(
      JSON.stringify({ verdict: "correct", explanation: "Right." }),
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

    const result = await runPracticeTurn(session, {
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

    const result = await runPracticeTurn(session, {
      parentMessage: "more please",
    });
    expect(result.isSessionEnded).toBe(true);

    // The dispatcher returns an error toolResult to the agent — verify by
    // checking that the conversation includes a status:"error" tool result.
    const hasError = session.messages.some((m) =>
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

    await runPracticeTurn(session, { parentMessage: "still stuck" });
    const hasError = session.messages.some((m) =>
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

    const result = await runPracticeTurn(session, { forceEndSession: true });

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
      message: {
        role: "assistant",
        content: [{ text: "Blocked by content filter." }],
      },
    });

    await expect(
      runPracticeTurn(blankSession(), { parentMessage: "bad" }),
    ).rejects.toThrow(/Blocked by content filter/);
  });
});
