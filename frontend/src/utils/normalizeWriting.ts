// ── Defensive shape normalisation for Writing packets ───────────────────────
// Bedrock occasionally returns array-typed fields as a single string (numbered
// list, newline-separated, or JSON-encoded). These coercions keep the
// renderer simple — call them once at the data boundary and the cards can
// trust the shape.
// ─────────────────────────────────────────────────────────────────────────────
import type {
  CoachingNotePacket,
  DraftFeedbackPacket,
  DraftRubric,
  FeedbackHighlight,
  RubricDimension,
  WritingPlanPacket,
} from "../types";

// Strip Claude's XML tool-format leakage. Bedrock's force-tool-use sometimes
// returns array fields as a string of <item>...</item> tags (with trailing
// </invoke> garbage from the XML tool format). Extract the items.
const ITEM_TAG_RE = /<item[^>]*>([\s\S]*?)<\/item>/gi;

const stripXmlGarbage = (s: string): string =>
  s.replace(/<\/?(?:invoke|parameter|answer|tool_use|tool_result)[^>]*>/gi, "");

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
    // Try JSON-encoded array first.
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
    // Fall back to splitting on newlines, stripping bullet/numbered prefixes.
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
    return v
      .map(shape)
      .filter((x): x is T => x !== null);
  }
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return objectArray(parsed, shape);
      } catch {
        // fall through
      }
    }
  }
  return [];
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
  const rawScore = obj.score;
  let score: 1 | 2 | 3 | 4 = 3;
  if (rawScore === 1 || rawScore === 2 || rawScore === 3 || rawScore === 4) {
    score = rawScore;
  } else if (typeof rawScore === "string") {
    const parsed = parseInt(rawScore, 10);
    if (parsed >= 1 && parsed <= 4) score = parsed as 1 | 2 | 3 | 4;
  }
  const name =
    typeof obj.name === "string" &&
    (RUBRIC_NAMES as string[]).includes(obj.name)
      ? (obj.name as RubricDimension["name"])
      : RUBRIC_NAMES[fallbackIndex] ?? RUBRIC_NAMES[0];
  return {
    name,
    score,
    rationale: asString(obj.rationale),
  };
};

export const normalisePlan = (plan: WritingPlanPacket): WritingPlanPacket => ({
  ...plan,
  assignmentSummary: asString(plan.assignmentSummary),
  successCriteria: stringArray(plan.successCriteria),
  planningQuestions: stringArray(plan.planningQuestions),
  vocabularyToOffer: stringArray(plan.vocabularyToOffer),
  watchFor: stringArray(plan.watchFor),
  modelAnswer: asString(plan.modelAnswer),
  coachingScript: asString(plan.coachingScript),
});

export const normaliseDraftFeedback = (
  packet: DraftFeedbackPacket,
): DraftFeedbackPacket => {
  const dimensions = objectArray(packet.rubric?.dimensions, (item) =>
    asRubricDimension(item, 0),
  );
  // Re-index dimension names so the strip always renders 4 in canonical order.
  const fullDimensions: RubricDimension[] = RUBRIC_NAMES.map((name, i) => {
    const found = dimensions.find((d) => d.name === name);
    return (
      found ??
      dimensions[i] ?? { name, score: 3, rationale: "" }
    );
  });
  const overallBand: DraftRubric["overallBand"] =
    packet.rubric?.overallBand === "Working towards" ||
    packet.rubric?.overallBand === "At standard" ||
    packet.rubric?.overallBand === "Above standard"
      ? packet.rubric.overallBand
      : "At standard";

  const stars = objectArray(packet.twoStars, asHighlight);
  // Pad / trim to exactly 2 so the layout is stable.
  const twoStars: FeedbackHighlight[] =
    stars.length >= 2
      ? [stars[0], stars[1]]
      : [
          stars[0] ?? { evidenceQuote: "", comment: "" },
          stars[1] ?? { evidenceQuote: "", comment: "" },
        ];

  const wishObj = packet.oneWish as unknown as
    | Record<string, unknown>
    | undefined;
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
