// ── Defensive shape normalisation for Writing packets ───────────────────────
// Bedrock's tool_use.input usually conforms to the JSON schema, but the
// occasional response packs an array-typed field as a string (numbered list,
// JSON-encoded string, etc.). Coerce here so the SessionRecord persisted to
// S3 always has the canonical shape, and downstream renderers can trust it.
// ─────────────────────────────────────────────────────────────────────────────
import type {
  CoachingNotePacket,
  DraftFeedbackPacket,
  DraftRubric,
  FeedbackHighlight,
  ModelAnswerPair,
  PlanningQuestion,
  RubricDimension,
  WritingPlanPacket,
} from "../shared/types";

// Strip Claude's XML tool-format leakage. Bedrock's force-tool-use sometimes
// returns array fields as a string of <item>...</item> tags (with trailing
// </invoke> garbage from the XML tool format). Extract the items.
const ITEM_TAG_RE = /<item[^>]*>([\s\S]*?)<\/item>/gi;

// A forced tool response can occasionally contain one extra closing quote in
// a planning-question value (`"question": "... ?"",`). Repair only that
// narrow, otherwise-invalid pattern before parsing the JSON array. Do not use
// a broad quote replacement: escaped quotes inside a valid question must stay
// intact.
const repairPlanningQuestionJson = (s: string): string =>
  s.replace(
    /("question"\s*:\s*"(?:\\.|[^"\\])*)""(?=\s*[,}])/g,
    '$1"',
  );

const stripXmlGarbage = (s: string): string =>
  s.replace(
    /<\/?(?:invoke|parameter|answer|item|tool_use|tool_result)[^>]*>/gi,
    "",
  );

const stringArray = (v: unknown): string[] => {
  if (Array.isArray(v)) {
    return v
      .map((x) => (typeof x === "string" ? x : String(x ?? "")))
      .map((x) => stripXmlGarbage(x).trim())
      .filter((x) => x.length > 0);
  }
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return stringArray(parsed);
      } catch {
        // fall through
      }
    }
    // <item>...</item> fallback (Claude's XML tool-format leakage).
    const itemMatches = [...trimmed.matchAll(ITEM_TAG_RE)].map((m) =>
      m[1].trim(),
    );
    if (itemMatches.length > 0) {
      return itemMatches.filter((s) => s.length > 0);
    }
    return stripXmlGarbage(trimmed)
      .split(/\r?\n+/)
      .map((s) => s.replace(/^\s*(?:[-*•]|\d+\.)\s*/, "").trim())
      .filter((s) => s.length > 0);
  }
  return [];
};

const objectArray = <T>(
  v: unknown,
  shape: (item: unknown) => T | null,
): T[] => {
  if (Array.isArray(v)) {
    return v.map(shape).filter((x): x is T => x !== null);
  }
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(repairPlanningQuestionJson(trimmed));
        if (Array.isArray(parsed)) return objectArray(parsed, shape);
      } catch {
        // fall through
      }
    }
  }
  return [];
};

const asObject = (v: unknown): Record<string, unknown> | undefined => {
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // fall through
      }
    }
  }
  return undefined;
};

const asString = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (v == null) return "";
  return String(v);
};

const asHighlight = (item: unknown): FeedbackHighlight | null => {
  if (typeof item !== "object" || item === null) return null;
  const obj = item as Record<string, unknown>;
  return {
    evidenceQuote: asString(obj.evidenceQuote),
    comment: asString(obj.comment),
  };
};

const RUBRIC_NAMES: RubricDimension["name"][] = [
  "Ideas & Content",
  "Structure & Organisation",
  "Language & Vocabulary",
  "Mechanics",
];

const asRubricDimension = (
  item: unknown,
  fallbackIndex: number,
): RubricDimension | null => {
  if (typeof item !== "object" || item === null) return null;
  const obj = item as Record<string, unknown>;
  const name =
    typeof obj.name === "string" &&
    (RUBRIC_NAMES as string[]).includes(obj.name)
      ? (obj.name as RubricDimension["name"])
      : (RUBRIC_NAMES[fallbackIndex] ?? RUBRIC_NAMES[0]);
  return {
    name,
    score: asRubricScore(obj.score),
    rationale: asString(obj.rationale),
  };
};

const asRubricScore = (rawScore: unknown): 1 | 2 | 3 | 4 => {
  if (rawScore === 1 || rawScore === 2 || rawScore === 3 || rawScore === 4) {
    return rawScore;
  }
  if (typeof rawScore === "string") {
    const parsed = parseInt(stripXmlGarbage(rawScore).trim(), 10);
    if (parsed >= 1 && parsed <= 4) return parsed as 1 | 2 | 3 | 4;
  }
  return 3;
};

const asModelAnswerPair = (v: unknown): ModelAnswerPair => {
  const obj = asObject(v) ?? {};
  return {
    atYearLevel: asString(obj.atYearLevel),
    aboveYearLevel: asString(obj.aboveYearLevel),
    aboveYearLevelLabel: asString(obj.aboveYearLevelLabel),
    whyAboveIsBetter: asString(obj.whyAboveIsBetter),
  };
};

const asPlanningQuestion = (item: unknown): PlanningQuestion | null => {
  if (typeof item === "string") {
    const question = stripXmlGarbage(item).trim();
    return question ? { question, suggestedAnswers: [] } : null;
  }
  const obj = asObject(item);
  if (!obj) return null;
  const question = asString(obj.question).trim();
  if (!question) return null;
  return {
    question,
    suggestedAnswers: stringArray(obj.suggestedAnswers),
  };
};

const planningQuestionArray = (v: unknown): PlanningQuestion[] => {
  const questions = objectArray(v, asPlanningQuestion);
  if (questions.length > 0) return questions;
  return stringArray(v).map((question) => ({ question, suggestedAnswers: [] }));
};

export const normalisePlan = (plan: WritingPlanPacket): WritingPlanPacket => ({
  ...plan,
  assignmentSummary: asString(plan.assignmentSummary),
  successCriteria: stringArray(plan.successCriteria),
  planningQuestions: planningQuestionArray(plan.planningQuestions),
  vocabularyToOffer: stringArray(plan.vocabularyToOffer),
  watchFor: stringArray(plan.watchFor),
  modelAnswers: asModelAnswerPair(plan.modelAnswers),
  coachingScript: asString(plan.coachingScript),
});

export const normaliseDraftFeedback = (
  packet: DraftFeedbackPacket,
): DraftFeedbackPacket => {
  const dimensions = objectArray(packet.rubric?.dimensions, (item) =>
    asRubricDimension(item, 0),
  );
  const fullDimensions: RubricDimension[] = RUBRIC_NAMES.map((name, i) => {
    const found = dimensions.find((d) => d.name === name);
    return found ?? dimensions[i] ?? { name, score: 3, rationale: "" };
  });
  const overallBand: DraftRubric["overallBand"] =
    packet.rubric?.overallBand === "Working towards" ||
    packet.rubric?.overallBand === "At standard" ||
    packet.rubric?.overallBand === "Above standard"
      ? packet.rubric.overallBand
      : "At standard";

  const stars = objectArray(packet.twoStars, asHighlight);
  const twoStars: FeedbackHighlight[] =
    stars.length >= 2
      ? [stars[0], stars[1]]
      : [
          stars[0] ?? { evidenceQuote: "", comment: "" },
          stars[1] ?? { evidenceQuote: "", comment: "" },
        ];

  const wishObj = asObject(packet.oneWish);
  const oneWish = {
    evidenceQuote: asString(wishObj?.evidenceQuote),
    comment: asString(wishObj?.comment),
    revisionSuggestion: asString(wishObj?.revisionSuggestion),
  };

  return {
    transcription: asString(packet.transcription),
    againstPrompt: asString(packet.againstPrompt),
    twoStars,
    oneWish,
    rubric: { dimensions: fullDimensions, overallBand },
    mechanicsNotes: stringArray(packet.mechanicsNotes),
    coachingScript: asString(packet.coachingScript),
    nextStep:
      packet.nextStep === "revise_with_focus" ||
      packet.nextStep === "ready_for_final_read_aloud" ||
      packet.nextStep === "needs_replanning"
        ? packet.nextStep
        : "revise_with_focus",
  };
};

export const normaliseCoachingNote = (
  packet: CoachingNotePacket,
): CoachingNotePacket => ({
  questionUnderstood: asString(packet.questionUnderstood),
  answer: asString(packet.answer),
  coachingTip: asString(packet.coachingTip),
  relatedGuidanceField:
    packet.relatedGuidanceField != null
      ? asString(packet.relatedGuidanceField)
      : undefined,
});
