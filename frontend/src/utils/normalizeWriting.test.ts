import { describe, expect, it } from "vitest";
import type { DraftFeedbackPacket } from "../types";
import { normaliseDraftFeedback, normalisePlan } from "./normalizeWriting";
import type { WritingPlanPacket } from "../types";

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

describe("normalisePlan", () => {
  it("recovers planning-question objects from malformed JSON returned as a string", () => {
    const plan = {
      assignmentSummary: "Write two persuasive texts about koala hospitals.",
      genre: "persuasive",
      yearLevel: "year-4",
      yearLevelSource: "user",
      successCriteria: [],
      planningQuestions: `[
        {
          "question": "What is your position on the first text?",
          "suggestedAnswers": ["Hospitals help save koalas' lives"]
        },
        {
          "question": "Where will you place your strongest reason?"",
          "suggestedAnswers": ["Start strong to hook the reader"]
        }
      ]`,
      modelAnswers: {},
      vocabularyToOffer: [],
      watchFor: [],
      coachingScript: "",
    } as unknown as WritingPlanPacket;

    expect(normalisePlan(plan).planningQuestions).toEqual([
      {
        question: "What is your position on the first text?",
        suggestedAnswers: ["Hospitals help save koalas' lives"],
      },
      {
        question: "Where will you place your strongest reason?",
        suggestedAnswers: ["Start strong to hook the reader"],
      },
    ]);
  });
});
