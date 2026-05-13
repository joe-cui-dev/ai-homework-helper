import { normalisePlan } from "../writing/normalize";
import type { CriteriaJustification, WritingPlanPacket } from "../shared/types";

const VALID_PLAN: WritingPlanPacket = {
  assignmentSummary: "Write a short narrative about a lost dog.",
  genre: "narrative",
  yearLevel: "year-3",
  yearLevelSource: "user",
  successCriteria: ["Has a clear beginning", "Uses descriptive language", "Ends with resolution"],
  planningQuestions: ["Who is the main character?", "What goes wrong?", "How is it resolved?"],
  modelAnswers: {
    atYearLevel: "My dog Rex ran away. I looked everywhere. I found him at the park. I was so happy.",
    aboveYearLevel:
      "Rex bolted through the open gate before I could blink. I searched the whole street, my heart thumping. Finally, I spotted him chasing leaves at the park.",
    aboveYearLevelLabel: "Year 4",
    criteriaJustifications: [
      {
        criterion: "Has a clear beginning",
        atYearLevel: "Opens by naming the dog and the problem.",
        aboveYearLevel: "Opens with action — Rex 'bolted' — establishing setting and stakes immediately.",
      },
      {
        criterion: "Uses descriptive language",
        atYearLevel: "Uses everyday words like 'happy' and 'park'.",
        aboveYearLevel: "Uses vivid verbs ('bolted', 'thumping') and a sensory image.",
      },
      {
        criterion: "Ends with resolution",
        atYearLevel: "Ends by stating Rex was found.",
        aboveYearLevel: "Resolves with a concrete sensory image of Rex at play.",
      },
    ],
  },
  vocabularyToOffer: ["bolted", "frantic"],
  watchFor: ["Tense drift", "Missing full stops"],
  coachingScript: "Sit beside the child during the planning questions.",
};

describe("normalisePlan", () => {
  it("returns an empty modelAnswers pair when the field is missing (legacy session)", () => {
    const legacy = { ...VALID_PLAN } as Partial<WritingPlanPacket>;
    delete (legacy as Record<string, unknown>).modelAnswers;
    const result = normalisePlan(legacy as WritingPlanPacket);
    expect(result.modelAnswers).toEqual({
      atYearLevel: "",
      aboveYearLevel: "",
      aboveYearLevelLabel: "",
      criteriaJustifications: [],
    });
  });

  it("coerces non-string modelAnswers fields to strings", () => {
    const plan = {
      ...VALID_PLAN,
      modelAnswers: {
        atYearLevel: 123 as unknown as string,
        aboveYearLevel: null as unknown as string,
        aboveYearLevelLabel: undefined as unknown as string,
        criteriaJustifications: [
          { criterion: 42, atYearLevel: null, aboveYearLevel: undefined },
        ] as unknown as CriteriaJustification[],
      },
    };
    const result = normalisePlan(plan);
    expect(result.modelAnswers.atYearLevel).toBe("123");
    expect(result.modelAnswers.aboveYearLevel).toBe("");
    expect(result.modelAnswers.aboveYearLevelLabel).toBe("");
    expect(result.modelAnswers.criteriaJustifications[0]).toEqual({
      criterion: "42",
      atYearLevel: "",
      aboveYearLevel: "",
    });
  });

  it("preserves the modelAnswers structure when given a valid packet", () => {
    const result = normalisePlan(VALID_PLAN);
    expect(result.modelAnswers.atYearLevel).toBe(VALID_PLAN.modelAnswers.atYearLevel);
    expect(result.modelAnswers.aboveYearLevel).toBe(VALID_PLAN.modelAnswers.aboveYearLevel);
    expect(result.modelAnswers.aboveYearLevelLabel).toBe("Year 4");
    expect(result.modelAnswers.criteriaJustifications).toHaveLength(3);
    expect(result.modelAnswers.criteriaJustifications[0]).toEqual({
      criterion: "Has a clear beginning",
      atYearLevel: "Opens by naming the dog and the problem.",
      aboveYearLevel: "Opens with action — Rex 'bolted' — establishing setting and stakes immediately.",
    });
  });
});
