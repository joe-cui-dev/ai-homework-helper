import { runDraftTurn } from "../writing/writing";
import type { WritingSession } from "../shared/session";
import type { DraftFeedbackPacket, WritingPlanPacket } from "../shared/types";

jest.mock("../shared/bedrock", () => ({
  converseWithTools: jest.fn(),
  parseDataUrl: (url: string) => {
    const match = url.match(/^data:(image\/(?:jpeg|png));base64,(.+)$/);
    return { mediaType: match![1], base64Data: match![2] };
  },
  buildUsage: (i: number, o: number) => ({
    inputTokens: i,
    outputTokens: o,
    costUsd: 0,
  }),
  sumUsage: jest.fn(),
  parseToolInput: <T,>(raw: unknown): T => raw as T,
}));

jest.mock("../shared/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { converseWithTools } = jest.requireMock("../shared/bedrock") as {
  converseWithTools: jest.Mock;
};

const plan: WritingPlanPacket = {
  assignmentSummary: "Write a narrative about Akira helping an injured seagull.",
  genre: "narrative",
  yearLevel: "year-3",
  yearLevelSource: "user",
  successCriteria: ["Clear sequence", "Sensory detail"],
  planningQuestions: [],
  modelAnswers: {
    atYearLevel: "Sample.",
    aboveYearLevel: "Stronger sample.",
    aboveYearLevelLabel: "Year 4",
    whyAboveIsBetter: "More precise detail.",
  },
  vocabularyToOffer: [],
  watchFor: [],
  coachingScript: "Coach the child.",
};

const session: WritingSession = {
  sessionId: "writing-1",
  studentId: "student-1",
  modelChoice: "fast",
  timestamp: "2026-06-10T00:00:00.000Z",
  updatedAt: "2026-06-10T00:00:00.000Z",
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  sessionType: "writing",
  status: "active",
  prompt: { input: "", imageKeys: [] },
  plan,
  turns: [],
  draftCount: 1,
  questionCount: 0,
};

const feedback: DraftFeedbackPacket = {
  transcription: "Flap! The seagull flew past Akira's head.",
  againstPrompt: "The draft follows the assignment.",
  twoStars: [
    { evidenceQuote: "Flap!", comment: "Strong opening sound." },
    { evidenceQuote: "seagull flew", comment: "Clear action." },
  ],
  oneWish: {
    evidenceQuote: "They became friends.",
    comment: "The ending is told quickly.",
    revisionSuggestion: "Ask for one moment that shows trust forming.",
  },
  rubric: {
    overallBand: "Working towards",
    dimensions: [
      { name: "Ideas & Content", score: 2, rationale: "Relevant but thin." },
      { name: "Structure & Organisation", score: 2, rationale: "Sequence is present." },
      { name: "Language & Vocabulary", score: 2, rationale: "Some precise verbs." },
      { name: "Mechanics", score: 2, rationale: "Punctuation needs work." },
    ],
  },
  mechanicsNotes: [],
  coachingScript: "Ask the child to show one moment of trust.",
  nextStep: "revise_with_focus",
};

beforeEach(() => {
  converseWithTools.mockReset();
  converseWithTools.mockResolvedValue({
    stopReason: "tool_use",
    usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.0001 },
    message: {
      role: "assistant",
      content: [
        {
          toolUse: {
            toolUseId: "tool-1",
            name: "submit_draft_feedback",
            input: feedback,
          },
        },
      ],
    },
  });
});

describe("runDraftTurn guardrail scoping", () => {
  it("guards the writing-feedback request framing without assessing the raw typed draft as off-topic", async () => {
    const draft =
      "Flap! The seagull flew past Akira's head. The ocean was blue and the sand was yellow.";

    await runDraftTurn(session, [], { draftText: draft, draftImages: [] });

    const [messages] = converseWithTools.mock.calls[0];
    const userMessage = messages[0];
    expect(userMessage.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          guardContent: {
            text: {
              text: expect.stringMatching(/writing homework draft feedback/i),
            },
          },
        }),
        { text: expect.stringContaining(draft) },
      ]),
    );

    const guardedText = userMessage.content
      .map((block: Record<string, unknown>) => {
        const guardContent = block.guardContent as
          | { text?: { text?: string } }
          | undefined;
        return guardContent?.text?.text ?? "";
      })
      .join("\n");
    expect(guardedText).not.toContain(draft);
  });
});
