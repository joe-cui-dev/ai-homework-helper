import { normaliseDraftFeedback } from "../writing/normalize";
import type { DraftFeedbackPacket } from "../shared/types";

const basePacket = (oneWish: unknown): DraftFeedbackPacket =>
  ({
    transcription: "a draft",
    againstPrompt: "summary",
    twoStars: [
      { evidenceQuote: "q1", comment: "c1" },
      { evidenceQuote: "q2", comment: "c2" },
    ],
    oneWish: oneWish as DraftFeedbackPacket["oneWish"],
    rubric: {
      dimensions: [
        { name: "Ideas & Content", score: 2, rationale: "r" },
        { name: "Structure & Organisation", score: 2, rationale: "r" },
        { name: "Language & Vocabulary", score: 2, rationale: "r" },
        { name: "Mechanics", score: 2, rationale: "r" },
      ],
      overallBand: "Working towards",
    },
    mechanicsNotes: [],
    coachingScript: "script",
    nextStep: "revise_with_focus",
  }) as DraftFeedbackPacket;

describe("normaliseDraftFeedback - oneWish", () => {
  it("keeps oneWish content when returned as an object (happy path)", () => {
    const packet = basePacket({
      evidenceQuote: "quote",
      comment: "comment",
      revisionSuggestion: "suggestion",
    });
    const out = normaliseDraftFeedback(packet);
    expect(out.oneWish).toEqual({
      evidenceQuote: "quote",
      comment: "comment",
      revisionSuggestion: "suggestion",
    });
  });

  it("parses oneWish when Bedrock returns it as a JSON-encoded string", () => {
    const packet = basePacket(
      JSON.stringify({
        evidenceQuote: "quote",
        comment: "comment",
        revisionSuggestion: "suggestion",
      }),
    );
    const out = normaliseDraftFeedback(packet);
    expect(out.oneWish).toEqual({
      evidenceQuote: "quote",
      comment: "comment",
      revisionSuggestion: "suggestion",
    });
  });

  it("falls back to empty strings when oneWish is unparseable", () => {
    const packet = basePacket("not json");
    const out = normaliseDraftFeedback(packet);
    expect(out.oneWish).toEqual({
      evidenceQuote: "",
      comment: "",
      revisionSuggestion: "",
    });
  });
});
