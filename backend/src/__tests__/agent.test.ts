import { runAgent, dispatchTool } from "../agent";
import type { StreamEvent } from "../types";

jest.mock("../logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    addContext: jest.fn(),
    appendKeys: jest.fn(),
    resetKeys: jest.fn(),
  },
}));

jest.mock("../bedrock", () => ({
  converseWithTools: jest.fn(),
}));

jest.mock("../pipeline", () => ({
  solve: jest.fn(),
  explain: jest.fn(),
  generateHint: jest.fn(),
}));

jest.mock("../storage", () => ({
  getRecentSessions: jest.fn(),
  saveSession: jest.fn(),
}));

jest.mock("../curriculum", () => ({
  lookupCurriculum: jest.fn(),
}));

import { converseWithTools } from "../bedrock";
import { solve, explain, generateHint } from "../pipeline";
import { getRecentSessions } from "../storage";
import { lookupCurriculum } from "../curriculum";

const mockConverseWithTools = converseWithTools as jest.MockedFunction<
  typeof converseWithTools
>;
const mockSolve = solve as jest.MockedFunction<typeof solve>;
const mockExplain = explain as jest.MockedFunction<typeof explain>;
const mockGenerateHint = generateHint as jest.MockedFunction<
  typeof generateHint
>;

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const toolUseResponse = (
  toolCalls: Array<{ toolUseId: string; name: string; input: unknown }>,
) => ({
  stopReason: "tool_use",
  message: {
    role: "assistant" as const,
    content: toolCalls.map((t) => ({
      toolUse: { toolUseId: t.toolUseId, name: t.name, input: t.input },
    })),
  },
});

const SUBMIT_INPUT = {
  subject: "math",
  difficulty: "year-3",
  answer: "84",
  steps: ["Multiply 12 by 7", "Result is 84"],
  explanation: "Great work! 12 times 7 is 84.",
};

// ---------------------------------------------------------------------------
// runAgent — normal flow
// ---------------------------------------------------------------------------

describe("runAgent — normal flow", () => {
  it("calls solve_question then submit_answer and returns the result", async () => {
    mockSolve.mockResolvedValueOnce({ answer: "84", steps: ["12 × 7 = 84"] });
    mockConverseWithTools
      .mockResolvedValueOnce(
        toolUseResponse([
          {
            toolUseId: "t1",
            name: "solve_question",
            input: { question: "12*7", subject: "math", difficulty: "year-3" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        toolUseResponse([
          { toolUseId: "t2", name: "submit_answer", input: SUBMIT_INPUT },
        ]),
      );

    const result = await runAgent("What is 12 times 7?");

    expect(result).toEqual(SUBMIT_INPUT);
    expect(mockSolve).toHaveBeenCalledWith("12*7", "math", "year-3");
  });

  it("returns immediately when submit_answer is called in the same turn as other tools", async () => {
    mockSolve.mockResolvedValueOnce({ answer: "84", steps: ["12 × 7 = 84"] });
    mockConverseWithTools.mockResolvedValueOnce(
      toolUseResponse([
        {
          toolUseId: "t1",
          name: "solve_question",
          input: { question: "q", subject: "math", difficulty: "year-3" },
        },
        { toolUseId: "t2", name: "submit_answer", input: SUBMIT_INPUT },
      ]),
    );

    const result = await runAgent("What is 12 times 7?");

    expect(result).toEqual(SUBMIT_INPUT);
    expect(mockConverseWithTools).toHaveBeenCalledTimes(1);
  });

  it("does not embed studentId in the user message (IDOR prevention)", async () => {
    mockConverseWithTools.mockResolvedValueOnce(
      toolUseResponse([
        { toolUseId: "t1", name: "submit_answer", input: SUBMIT_INPUT },
      ]),
    );

    await runAgent("What is 12 times 7?", "student-123");

    const [messages] = mockConverseWithTools.mock.calls[0];
    const text = (messages[0].content?.[0] as { text: string }).text;
    expect(text).not.toContain("student-123");
    expect(text).toBe("What is 12 times 7?");
  });
});

// ---------------------------------------------------------------------------
// runAgent — tool visibility
// ---------------------------------------------------------------------------

describe("runAgent — tool visibility", () => {
  it("excludes fetch_session_history when no studentId provided", async () => {
    mockConverseWithTools.mockResolvedValueOnce(
      toolUseResponse([
        { toolUseId: "t1", name: "submit_answer", input: SUBMIT_INPUT },
      ]),
    );

    await runAgent("What is 12 times 7?");

    const [, tools] = mockConverseWithTools.mock.calls[0];
    const toolNames = (tools as { toolSpec?: { name?: string } }[]).map(
      (t) => t.toolSpec?.name,
    );
    expect(toolNames).not.toContain("fetch_session_history");
  });

  it("includes fetch_session_history when studentId is provided", async () => {
    mockConverseWithTools.mockResolvedValueOnce(
      toolUseResponse([
        { toolUseId: "t1", name: "submit_answer", input: SUBMIT_INPUT },
      ]),
    );

    await runAgent("What is 12 times 7?", "student-123");

    const [, tools] = mockConverseWithTools.mock.calls[0];
    const toolNames = (tools as { toolSpec?: { name?: string } }[]).map(
      (t) => t.toolSpec?.name,
    );
    expect(toolNames).toContain("fetch_session_history");
  });
});

// ---------------------------------------------------------------------------
// runAgent — max iterations guard
// ---------------------------------------------------------------------------

describe("runAgent — max iterations guard", () => {
  it("throws after MAX_ITERATIONS without submit_answer", async () => {
    mockSolve.mockResolvedValue({ answer: "84", steps: ["Step 1"] });
    mockConverseWithTools.mockResolvedValue(
      toolUseResponse([
        {
          toolUseId: "t1",
          name: "solve_question",
          input: { question: "q", subject: "math", difficulty: "year-3" },
        },
      ]),
    );

    await expect(runAgent("What is 2+2?")).rejects.toThrow("MAX_ITERATIONS");
    expect(mockConverseWithTools).toHaveBeenCalledTimes(5);
  });

  it("throws if stopReason is end_turn (agent forgot submit_answer)", async () => {
    mockConverseWithTools.mockResolvedValueOnce({
      stopReason: "end_turn",
      message: {
        role: "assistant",
        content: [{ text: "Here is the answer." }],
      },
    });

    await expect(runAgent("What is 2+2?")).rejects.toThrow(
      "Agent ended without calling submit_answer",
    );
  });
});

// ---------------------------------------------------------------------------
// dispatchTool — routing
// ---------------------------------------------------------------------------

describe("dispatchTool — routing", () => {
  it("routes solve_question to solve()", async () => {
    mockSolve.mockResolvedValueOnce({ answer: "84", steps: [] });
    await dispatchTool("solve_question", {
      question: "q",
      subject: "math",
      difficulty: "year-3",
    });
    expect(mockSolve).toHaveBeenCalledWith("q", "math", "year-3");
  });

  it("routes generate_hint to generateHint()", async () => {
    mockGenerateHint.mockResolvedValueOnce({ hints: ["Think about it"] });
    await dispatchTool("generate_hint", {
      question: "q",
      subject: "math",
      difficulty: "year-3",
    });
    expect(mockGenerateHint).toHaveBeenCalledWith("q", "math", "year-3");
  });

  it("routes explain_solution to explain()", async () => {
    mockExplain.mockResolvedValueOnce({ explanation: "Great!" });
    await dispatchTool("explain_solution", {
      answer: "84",
      steps: ["Step 1"],
      difficulty: "year-3",
    });
    expect(mockExplain).toHaveBeenCalledWith("84", ["Step 1"], "year-3");
  });

  it("routes lookup_curriculum to lookupCurriculum()", async () => {
    (lookupCurriculum as jest.Mock).mockReturnValueOnce(["outcome 1"]);
    const result = await dispatchTool("lookup_curriculum", {
      subject: "math",
      year: "year-3",
    });
    expect(result).toEqual(["outcome 1"]);
    expect(lookupCurriculum).toHaveBeenCalledWith("math", "year-3");
  });

  it("routes fetch_session_history to getRecentSessions() using authenticated studentId", async () => {
    (getRecentSessions as jest.Mock).mockResolvedValueOnce([
      { answer: "past session" },
    ]);
    // studentId must come from the third (authenticated) parameter, not from input
    const result = await dispatchTool(
      "fetch_session_history",
      { studentId: "injected-attacker-id" },
      "student-123",
    );
    expect(result).toEqual([{ answer: "past session" }]);
    expect(getRecentSessions).toHaveBeenCalledWith("student-123");
  });

  it("throws for unknown tool names", async () => {
    await expect(dispatchTool("unknown_tool", {})).rejects.toThrow(
      "Unknown tool",
    );
  });
});

// ---------------------------------------------------------------------------
// runAgent — tool error recovery
// ---------------------------------------------------------------------------

describe("runAgent — tool error recovery", () => {
  it("sends error status in tool result when dispatchTool throws", async () => {
    mockSolve.mockRejectedValueOnce(new Error("Bedrock timeout"));
    mockConverseWithTools
      .mockResolvedValueOnce(
        toolUseResponse([
          {
            toolUseId: "t1",
            name: "solve_question",
            input: { question: "q", subject: "math", difficulty: "year-3" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        toolUseResponse([
          { toolUseId: "t2", name: "submit_answer", input: SUBMIT_INPUT },
        ]),
      );

    const result = await runAgent("What is 12 times 7?");

    // Agent recovered and still returned a result via submit_answer
    expect(result).toEqual(SUBMIT_INPUT);

    // The second call to converseWithTools should have received an error tool
    // result for t1 (the failed solve_question call).
    // Note: mock.calls captures a reference to the mutable messages array, so
    // we search by toolUseId rather than relying on array length.
    const secondCallMessages = mockConverseWithTools.mock.calls[1][0] as Array<{
      role: string;
      content?: Array<{
        toolResult?: {
          toolUseId: string;
          status: string;
          content: { text: string }[];
        };
      }>;
    }>;
    const errorMsg = secondCallMessages.find(
      (msg) =>
        msg.role === "user" &&
        msg.content?.some((b) => b.toolResult?.toolUseId === "t1"),
    );
    expect(errorMsg).toBeDefined();
    const errorBlock = errorMsg!.content![0].toolResult!;
    expect(errorBlock.status).toBe("error");
    expect(errorBlock.content[0].text).toContain("Bedrock timeout");
  });
});

// ---------------------------------------------------------------------------
// runAgent — streaming events (onEvent callback)
// ---------------------------------------------------------------------------

describe("runAgent — streaming events", () => {
  it("emits tool_start and tool_end for each tool call including submit_answer", async () => {
    mockSolve.mockResolvedValueOnce({ answer: "84", steps: ["12 × 7 = 84"] });
    mockConverseWithTools
      .mockResolvedValueOnce(
        toolUseResponse([
          {
            toolUseId: "t1",
            name: "solve_question",
            input: { question: "12*7", subject: "math", difficulty: "year-3" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        toolUseResponse([
          { toolUseId: "t2", name: "submit_answer", input: SUBMIT_INPUT },
        ]),
      );

    const onEvent = jest.fn();
    await runAgent("What is 12 times 7?", undefined, onEvent);

    expect(onEvent).toHaveBeenCalledWith({
      type: "tool_start",
      tool: "solve_question",
    });
    expect(onEvent).toHaveBeenCalledWith({
      type: "tool_end",
      tool: "solve_question",
    });
    expect(onEvent).toHaveBeenCalledWith({
      type: "tool_start",
      tool: "submit_answer",
    });
    expect(onEvent).toHaveBeenCalledWith({
      type: "tool_end",
      tool: "submit_answer",
    });
  });

  it("emits events in correct start/end order across iterations", async () => {
    mockSolve.mockResolvedValueOnce({ answer: "84", steps: [] });
    mockConverseWithTools
      .mockResolvedValueOnce(
        toolUseResponse([
          {
            toolUseId: "t1",
            name: "solve_question",
            input: { question: "q", subject: "math", difficulty: "year-3" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        toolUseResponse([
          { toolUseId: "t2", name: "submit_answer", input: SUBMIT_INPUT },
        ]),
      );

    const events: string[] = [];
    const onEvent = (ev: StreamEvent) => {
      if (ev.type === "tool_start" || ev.type === "tool_end") {
        events.push(`${ev.type}:${ev.tool}`);
      }
    };
    await runAgent("What is 12 times 7?", undefined, onEvent);

    expect(events).toEqual([
      "tool_start:solve_question",
      "tool_end:solve_question",
      "tool_start:submit_answer",
      "tool_end:submit_answer",
    ]);
  });

  it("still emits tool_end when dispatchTool throws", async () => {
    mockSolve.mockRejectedValueOnce(new Error("Bedrock timeout"));
    mockConverseWithTools
      .mockResolvedValueOnce(
        toolUseResponse([
          {
            toolUseId: "t1",
            name: "solve_question",
            input: { question: "q", subject: "math", difficulty: "year-3" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        toolUseResponse([
          { toolUseId: "t2", name: "submit_answer", input: SUBMIT_INPUT },
        ]),
      );

    const events: string[] = [];
    const onEvent = (ev: StreamEvent) => {
      if (ev.type === "tool_start" || ev.type === "tool_end") {
        events.push(`${ev.type}:${ev.tool}`);
      }
    };
    await runAgent("What is 12 times 7?", undefined, onEvent);

    expect(events).toContain("tool_start:solve_question");
    expect(events).toContain("tool_end:solve_question");
  });

  it("works correctly when onEvent is omitted", async () => {
    mockSolve.mockResolvedValueOnce({ answer: "84", steps: [] });
    mockConverseWithTools.mockResolvedValueOnce(
      toolUseResponse([
        { toolUseId: "t1", name: "submit_answer", input: SUBMIT_INPUT },
      ]),
    );

    await expect(runAgent("What is 12 times 7?")).resolves.toEqual(
      SUBMIT_INPUT,
    );
  });
});
