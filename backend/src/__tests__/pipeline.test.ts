import { solve, explain, generateHint } from "../pipeline";

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
  callClaude: jest.fn(),
}));

import { callClaude } from "../bedrock";
const mockCallClaude = callClaude as jest.MockedFunction<typeof callClaude>;

beforeEach(() => jest.clearAllMocks());

describe("solve — agentic skill routing", () => {
  it("parses answer and steps from Claude response", async () => {
    mockCallClaude.mockResolvedValueOnce(
      JSON.stringify({
        answer: "84",
        steps: ["Multiply 12 by 7", "Result is 84"],
      }),
    );

    const result = await solve("What is 12 times 7?", "math", "year-3");

    expect(result).toEqual({
      answer: "84",
      steps: ["Multiply 12 by 7", "Result is 84"],
    });
    expect(mockCallClaude).toHaveBeenCalledWith(
      expect.stringContaining("What is 12 times 7?"),
      0,
    );
  });

  it("selects the math domain skill for a math question", async () => {
    mockCallClaude.mockResolvedValueOnce(
      JSON.stringify({ answer: "4", steps: ["Add 2 and 2"] }),
    );

    await solve("What is 2 + 2?", "math", "year-2");

    expect(mockCallClaude).toHaveBeenCalledWith(
      expect.stringContaining("math tutor skill"),
      0,
    );
  });

  it("selects the science domain skill for a science question", async () => {
    mockCallClaude.mockResolvedValueOnce(
      JSON.stringify({ answer: "H2O", steps: ["Hydrogen + Oxygen"] }),
    );

    await solve("What is water made of?", "science", "year-5");

    expect(mockCallClaude).toHaveBeenCalledWith(
      expect.stringContaining("science tutor skill"),
      0,
    );
  });

  it("selects the english domain skill for an english question", async () => {
    mockCallClaude.mockResolvedValueOnce(
      JSON.stringify({
        answer: "ran",
        steps: ["'run' in past tense is 'ran'"],
      }),
    );

    await solve("What is the past tense of run?", "english", "year-4");

    expect(mockCallClaude).toHaveBeenCalledWith(
      expect.stringContaining("English tutor skill"),
      0,
    );
  });

  it("selects the year-level tone skill and injects it into the prompt", async () => {
    mockCallClaude.mockResolvedValueOnce(
      JSON.stringify({ answer: "H2O", steps: ["Hydrogen + Oxygen"] }),
    );

    await solve("What is water made of?", "science", "year-5");

    expect(mockCallClaude).toHaveBeenCalledWith(
      expect.stringContaining("Year 5"),
      0,
    );
  });

  it("falls back to the 'other' domain skill for unknown subjects", async () => {
    mockCallClaude.mockResolvedValueOnce(
      JSON.stringify({ answer: "42", steps: ["Step 1"] }),
    );

    await solve("What is the meaning of life?", "philosophy", "year-6");

    expect(mockCallClaude).toHaveBeenCalledWith(
      expect.stringContaining("general tutor skill"),
      0,
    );
  });
});

describe("explain — agentic tone routing", () => {
  it("parses and returns explanation from Claude response", async () => {
    mockCallClaude.mockResolvedValueOnce(
      JSON.stringify({ explanation: "Great job! 2 + 2 = 4 because..." }),
    );

    const result = await explain("4", ["Add 2 and 2", "Result is 4"], "year-3");

    expect(result).toEqual({ explanation: "Great job! 2 + 2 = 4 because..." });
  });

  it("selects the year-level tone skill for the explanation", async () => {
    mockCallClaude.mockResolvedValueOnce(
      JSON.stringify({ explanation: "Great job!" }),
    );

    await explain("4", ["Add 2 and 2", "Result is 4"], "year-3");

    expect(mockCallClaude).toHaveBeenCalledWith(
      expect.stringContaining("Year 3"),
      0.3,
    );
  });

  it("selects year-6 tone for older students", async () => {
    mockCallClaude.mockResolvedValueOnce(
      JSON.stringify({ explanation: "Here is how it works..." }),
    );

    await explain("42", ["Step 1"], "year-6");

    expect(mockCallClaude).toHaveBeenCalledWith(
      expect.stringContaining("Year 6"),
      0.3,
    );
  });

  it("includes numbered steps in the prompt", async () => {
    mockCallClaude.mockResolvedValueOnce(
      JSON.stringify({ explanation: "Here is how it works..." }),
    );

    await explain("4", ["Step A", "Step B"], "year-4");

    expect(mockCallClaude).toHaveBeenCalledWith(
      expect.stringContaining("1. Step A"),
      0.3,
    );
    expect(mockCallClaude).toHaveBeenCalledWith(
      expect.stringContaining("2. Step B"),
      0.3,
    );
  });
});

describe("generateHint — Socratic hints", () => {
  it("parses and returns hints from Claude response", async () => {
    mockCallClaude.mockResolvedValueOnce(
      JSON.stringify({
        hints: ["What do you know about multiplication?", "Try counting by 7s"],
      }),
    );

    const result = await generateHint("What is 12 times 7?", "math", "year-3");

    expect(result).toEqual({
      hints: ["What do you know about multiplication?", "Try counting by 7s"],
    });
  });

  it("includes the question in the prompt", async () => {
    mockCallClaude.mockResolvedValueOnce(
      JSON.stringify({ hints: ["Think about the water cycle"] }),
    );

    await generateHint("What causes rain?", "science", "year-4");

    expect(mockCallClaude).toHaveBeenCalledWith(
      expect.stringContaining("What causes rain?"),
      0.3,
    );
  });

  it("selects the correct domain skill for the subject", async () => {
    mockCallClaude.mockResolvedValueOnce(
      JSON.stringify({ hints: ["Think about verbs"] }),
    );

    await generateHint("What is the past tense of run?", "english", "year-3");

    expect(mockCallClaude).toHaveBeenCalledWith(
      expect.stringContaining("English tutor skill"),
      0.3,
    );
  });

  it("selects the correct year-level tone", async () => {
    mockCallClaude.mockResolvedValueOnce(
      JSON.stringify({ hints: ["Break it into steps"] }),
    );

    await generateHint("What is 2 + 2?", "math", "year-1");

    expect(mockCallClaude).toHaveBeenCalledWith(
      expect.stringContaining("Year 1"),
      0.3,
    );
  });

  it("throws if Claude returns invalid JSON", async () => {
    mockCallClaude.mockResolvedValueOnce("not json");

    await expect(
      generateHint("some question", "math", "year-3"),
    ).rejects.toThrow();
  });
});
