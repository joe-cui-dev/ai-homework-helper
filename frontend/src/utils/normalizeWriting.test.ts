import { describe, expect, it } from "vitest";
import type { DraftFeedbackPacket } from "../types";
import { normaliseDraftFeedback } from "./normalizeWriting";

const basePacket = (): DraftFeedbackPacket =>
  ({
    transcription: "a draft",
    againstPrompt: "summary",
    twoStars: [
      { evidenceQuote: "q1", comment: "c1" },
      { evidenceQuote: "q2", comment: "c2" },
    ],
    oneWish: {
      evidenceQuote: "quote",
      comment: "comment",
      revisionSuggestion: "suggestion",
    },
    rubric: {
      dimensions: [
        {
          name: "Ideas & Content",
          score: "<answer>1</answer>" as never,
          rationale: "r",
        },
        {
          name: "Structure & Organisation",
          score: "<parameter>2</parameter>" as never,
          rationale: "r",
        },
        {
          name: "Language & Vocabulary",
          score: "<item>4</item>" as never,
          rationale: "r",
        },
        { name: "Mechanics", score: "1", rationale: "r" },
      ],
      overallBand: "Working towards",
    },
    mechanicsNotes: [],
    coachingScript: "script",
    nextStep: "revise_with_focus",
  }) as DraftFeedbackPacket;

describe("normaliseDraftFeedback", () => {
  it("keeps rubric scores when Bedrock wraps scalar values in tool XML", () => {
    const out = normaliseDraftFeedback(basePacket());

    expect(out.rubric.dimensions.map((d) => d.score)).toEqual([1, 2, 4, 1]);
  });
});
