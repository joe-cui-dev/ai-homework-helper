import { normalisePlan } from "../writing/normalize";
import type { WritingPlanPacket } from "../shared/types";

const VALID_PLAN: WritingPlanPacket = {
  assignmentSummary: "Write a short narrative about a lost dog.",
  genre: "narrative",
  yearLevel: "year-3",
  yearLevelSource: "user",
  successCriteria: ["Has a clear beginning", "Uses descriptive language", "Ends with resolution"],
  planningQuestions: [
    {
      question: "Who is the main character?",
      suggestedAnswers: ["A child looking for their dog", "The lost dog itself"],
    },
    {
      question: "What goes wrong?",
      suggestedAnswers: ["The dog runs through an open gate", "A storm makes searching harder"],
    },
    {
      question: "How is it resolved?",
      suggestedAnswers: ["The dog is found at the park", "A neighbour helps bring the dog home"],
    },
  ],
  modelAnswers: {
    atYearLevel: "My dog Rex ran away. I looked everywhere. I found him at the park. I was so happy.",
    aboveYearLevel:
      "Rex bolted through the open gate before I could blink. I searched the whole street, my heart thumping. Finally, I spotted him chasing leaves at the park.",
    aboveYearLevelLabel: "Year 4",
    whyAboveIsBetter:
      "The Year 4 sample opens with action ('bolted'), uses sensory verbs ('thumping') and embeds the resolution in a concrete image rather than a bare statement.",
  },
  vocabularyToOffer: ["bolted", "frantic"],
  watchFor: ["Tense drift", "Missing full stops"],
  coachingScript: "Sit beside the child during the planning questions.",
};

describe("normalisePlan", () => {
  it("recovers planning-question objects from malformed JSON returned as a string", () => {
    const plan = {
      ...VALID_PLAN,
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

  it("returns an empty modelAnswers pair when the field is missing (legacy session)", () => {
    const legacy = { ...VALID_PLAN } as Partial<WritingPlanPacket>;
    delete (legacy as Record<string, unknown>).modelAnswers;
    const result = normalisePlan(legacy as WritingPlanPacket);
    expect(result.modelAnswers).toEqual({
      atYearLevel: "",
      aboveYearLevel: "",
      aboveYearLevelLabel: "",
      whyAboveIsBetter: "",
    });
  });

  it("coerces non-string modelAnswers fields to strings", () => {
    const plan = {
      ...VALID_PLAN,
      modelAnswers: {
        atYearLevel: 123 as unknown as string,
        aboveYearLevel: null as unknown as string,
        aboveYearLevelLabel: undefined as unknown as string,
        whyAboveIsBetter: 0 as unknown as string,
      },
    };
    const result = normalisePlan(plan);
    expect(result.modelAnswers.atYearLevel).toBe("123");
    expect(result.modelAnswers.aboveYearLevel).toBe("");
    expect(result.modelAnswers.aboveYearLevelLabel).toBe("");
    expect(result.modelAnswers.whyAboveIsBetter).toBe("0");
  });

  it("preserves the modelAnswers structure when given a valid packet", () => {
    const result = normalisePlan(VALID_PLAN);
    expect(result.modelAnswers.atYearLevel).toBe(VALID_PLAN.modelAnswers.atYearLevel);
    expect(result.modelAnswers.aboveYearLevel).toBe(VALID_PLAN.modelAnswers.aboveYearLevel);
    expect(result.modelAnswers.aboveYearLevelLabel).toBe("Year 4");
    expect(result.modelAnswers.whyAboveIsBetter).toBe(VALID_PLAN.modelAnswers.whyAboveIsBetter);
  });

  it("coerces legacy string planningQuestions to question objects", () => {
    const legacy = {
      ...VALID_PLAN,
      planningQuestions: [
        "Who is the main character?",
        "What goes wrong?",
      ],
    } as unknown as WritingPlanPacket;
    const result = normalisePlan(legacy);
    expect(result.planningQuestions).toEqual([
      { question: "Who is the main character?", suggestedAnswers: [] },
      { question: "What goes wrong?", suggestedAnswers: [] },
    ]);
  });
});
