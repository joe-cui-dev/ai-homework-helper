// ── Shared types ──────────────────────────────────────────────────────────────
// Phase 1 (Coaching Packet) wire format. Phase 2 (Coaching Dialogue) will
// define its own event types in a separate handler.
// ─────────────────────────────────────────────────────────────────────────────

import type { ModelChoice } from "./modelChoice";

// ── Token usage / cost ───────────────────────────────────────────────────────
// Returned by every Bedrock call wrapper. Aggregated server-side and surfaced
// to the frontend in stream events and persisted in S3 alongside session JSON.
// costUsd is computed server-side from price constants colocated with the
// model id in CDK (passed via env vars to each Lambda).
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type Subject = "math" | "science" | "english" | "other";
export type YearLevel =
  | "year-1"
  | "year-2"
  | "year-3"
  | "year-4"
  | "year-5"
  | "year-6";

// Writing assignment genres. Inferred by Claude from the prompt at turn 1 of a
// Writing Session and locked for the session — drives success criteria, rubric
// descriptors, and planning questions.
export type WritingGenre =
  | "narrative"
  | "persuasive"
  | "recount"
  | "descriptive"
  | "information_report"
  | "explanation"
  | "procedure"
  | "other";

// One coaching packet per identified question. The reader is the parent.
// whyItWorks stays in adult voice; only childHint is calibrated to year level.
// subject and yearLevel live on the sibling IdentifiedQuestion, not here — see
// ADR 0006.
export interface CoachingPacket {
  questionId: number;
  tldrAnswer: string;
  whyItWorks: string;
  childHint: string;
}

export interface BatchPacket {
  questionId: number;
  questionText: string;
  subject: Subject;
  yearLevel: YearLevel;
  packet: CoachingPacket;
}

export interface IdentifiedQuestion {
  id: number;
  text: string;
  usesArticle: boolean;
  sourcePage?: number;
  subject: Subject;
  yearLevel: YearLevel;
}

export interface PageAnalysis {
  articleContext?: string;
  questions: IdentifiedQuestion[];
}

// ── Reading Session types ───────────────────────────────────────────────────
// A Reading Session is a Session where the parent uploads a book (cover +
// pages) and the AI *generates* comprehension questions, instead of
// *extracting* questions from a worksheet. See ADR 0002 and CONTEXT.md.

export type TaskType = "homework" | "reading" | "writing";

export type ReadingQuestionType = "literal" | "inference" | "vocabulary";

export interface BookContext {
  // Title and author extracted from the cover when recognisable. Both
  // optional — if Claude can't read the cover, the session still works
  // (questions are grounded in the page contents anyway).
  title?: string;
  author?: string;
}

// One generated comprehension question. Sibling of CoachingPacket; reading
// questions don't fit the homework field semantics ("Answer" implies one
// correct numeric answer; reading is prose). Reader is the parent.
export interface ReadingPacket {
  questionId: number;
  yearLevel: YearLevel;
  questionType: ReadingQuestionType;
  // Phrased so the parent can read it aloud verbatim. Calibrated to year level.
  questionText: string;
  // What a strong answer looks like — grounded in the uploaded pages.
  modelAnswer: string;
  // Adult-to-adult: what reading sub-skill this question targets and why.
  comprehensionSkill: string;
  // Adult-to-adult: what the parent should do/say with the child.
  coachingTip: string;
  // Common wrong/partial answers a child of this year level might give.
  commonMisreadings: string[];
  // Year-calibrated Socratic prompt the parent reads if the child is stuck.
  discussionPrompt: string;
  // Optional pointer to where in the uploaded pages the answer can be found.
  pageReference?: string;
}

export interface ReadingBatchPacket {
  questionId: number;
  packet: ReadingPacket;
}

export interface BookAnalysis {
  bookContext: BookContext;
  yearLevel: YearLevel;
  pagesAreSufficient: boolean;
  // Required when pagesAreSufficient === false. A specific request to the
  // parent ("Could you upload a few pages from the middle of the book?").
  insufficientReason?: string;
}

export type StreamEvent =
  | { type: "analyzing" }
  | {
      type: "packet_start";
      sessionId: string;
      questionId: number;
      total: number;
      text: string;
    }
  | {
      type: "packet_complete";
      questionId: number;
      subject: Subject;
      yearLevel: YearLevel;
      packet: CoachingPacket;
    }
  | {
      type: "complete";
      sessionId: string;
      packets: BatchPacket[];
      usage: TokenUsage;
      modelChoice: ModelChoice;
    }
  // ── Reading-task events ───────────────────────────────────────────────
  | { type: "book_analyzing" }
  | {
      type: "book_analyzed";
      bookContext: BookContext;
      yearLevel: YearLevel;
    }
  | { type: "needs_more_pages"; message: string }
  | {
      type: "reading_packet_start";
      sessionId: string;
      questionId: number;
      total: number;
    }
  | { type: "reading_packet_complete"; questionId: number; packet: ReadingPacket }
  | {
      type: "reading_complete";
      sessionId: string;
      bookContext: BookContext;
      packets: ReadingBatchPacket[];
      usage: TokenUsage;
      modelChoice: ModelChoice;
    }
  | { type: "error"; message: string };

// ── Phase 2: Practice Tutor Loop ─────────────────────────────────────────────

export type Verdict =
  | "correct"
  | "careless_slip"
  | "concept_gap"
  | "different_concept"
  | "stuck";

export type TeachingStyle =
  | "visual"
  | "story"
  | "manipulatives"
  | "number_line"
  | "real_world";

// Practice session ended-reason wire enum. Domain types in shared/session.ts
// own PracticeEndedReason which is the source of truth; PracticeStreamEvent
// remains lenient via the legacy `EndedReason` until the wire format is bumped.
export type EndedReason = "mastered" | "partial" | "abandoned";

// Wire format from /practice/start, /practice/turn, /practice/end.
// Distinct from the Phase 1 StreamEvent union — the frontend has two parsers,
// one per Lambda.
export type PracticeStreamEvent =
  | { type: "tool_start"; tool: string }
  | { type: "tool_end"; tool: string }
  | {
      type: "turn_complete";
      // The practice session's stable UUID. Surfaced on every turn so the
      // frontend can learn the id on /start (when it had only the origin info).
      sessionId: string;
      agentMessage: string;
      problem?: string;
      isSessionEnded: boolean;
      endedReason?: EndedReason;
      finalSummary?: string;
      // Usage for THIS turn only.
      turnUsage: TokenUsage;
      // Cumulative usage across the entire practice session so far.
      sessionUsage: TokenUsage;
    }
  | { type: "error"; message: string };

// ── Writing Session types ────────────────────────────────────────────────────
// A Writing Session is a SessionRecord variant that is mutated across multiple
// HTTP requests (cold turn 1, then 1..N draft turns and 0..N question turns).
// See ADR 0003 and the CONTEXT.md "Writing Session" entry.

// Pair of student-voice exemplars: atYearLevel matches the locked yearLevel;
// aboveYearLevel is one year above, capped at Year 6 (where it stays at Year 6
// but is described as "upper Year 6"). Both gated behind a UI disclosure.
// whyAboveIsBetter is a single adult-to-adult sentence or two explaining what
// the stretch sample does better — surfaced openly alongside the disclosure.
export interface ModelAnswerPair {
  atYearLevel: string;
  aboveYearLevel: string;
  aboveYearLevelLabel: string;
  whyAboveIsBetter: string;
}

export interface PlanningQuestion {
  question: string;
  suggestedAnswers: string[];
}

// Turn-1 output: the parent's coaching plan for this assignment. modelAnswers
// are student-voice, year-level-calibrated; the frontend gates them behind a
// UI disclosure so parents must opt in to see them.
export interface WritingPlanPacket {
  assignmentSummary: string;
  genre: WritingGenre;
  yearLevel: YearLevel;
  // "user" when the parent picked the year level on the landing page;
  // "inferred" when Claude guessed it. Optional for back-compat with sessions
  // persisted before this field existed — readers should treat undefined as
  // "inferred".
  yearLevelSource?: "user" | "inferred";
  successCriteria: string[];
  planningQuestions: PlanningQuestion[];
  modelAnswers: ModelAnswerPair;
  vocabularyToOffer: string[];
  watchFor: string[];
  coachingScript: string;
}

// Sub-shape of DraftFeedbackPacket. Both stars and the wish quote a fragment
// from the draft so feedback is concrete, not vague.
export interface FeedbackHighlight {
  evidenceQuote: string;
  comment: string;
}

export interface DraftFeedbackWish {
  evidenceQuote: string;
  comment: string;
  // Concrete revision suggestion the parent can act on with the child.
  revisionSuggestion: string;
}

export type RubricDimensionName =
  | "Ideas & Content"
  | "Structure & Organisation"
  | "Language & Vocabulary"
  | "Mechanics";

export interface RubricDimension {
  name: RubricDimensionName;
  // 1 = not yet, 2 = developing, 3 = achieving, 4 = extending. Year-level- and
  // genre-calibrated descriptors live in the system prompt.
  score: 1 | 2 | 3 | 4;
  rationale: string;
}

export type OverallBand =
  | "Working towards"
  | "At standard"
  | "Above standard";

export interface DraftRubric {
  dimensions: RubricDimension[];
  // Coarse categorical, not an averaged numeric. Reads as a teacher's
  // professional judgment, not a grade.
  overallBand: OverallBand;
}

export type DraftNextStep =
  | "revise_with_focus"
  | "ready_for_final_read_aloud"
  | "needs_replanning";

// Draft-turn output: strength-first, priority-disciplined feedback for the
// Parent-as-Coach. Carries a verbatim transcription so handwriting OCR errors
// don't masquerade as writing-skill judgments.
export interface DraftFeedbackPacket {
  // Verbatim of the draft, preserving misspellings. When the input was text,
  // this is just the text. When it was an image, this is the OCR — and the
  // parent can dispute it.
  transcription: string;
  againstPrompt: string;
  // Exactly two — schema enforces it.
  twoStars: FeedbackHighlight[];
  // Exactly one — the highest-leverage improvement, not a laundry list.
  oneWish: DraftFeedbackWish;
  rubric: DraftRubric;
  // Year-level-gated in system prompt; empty array allowed.
  mechanicsNotes: string[];
  coachingScript: string;
  nextStep: DraftNextStep;
}

// Question-turn output: the parent's escape hatch for clarifying questions
// during a writing assignment. By policy, never produces content the child
// could copy verbatim into their draft.
export interface CoachingNotePacket {
  questionUnderstood: string;
  answer: string;
  coachingTip: string;
  // Optional pointer back into the turn-1 WritingPlan ("See planningQuestions
  // #2"). Reduces duplication and reminds the parent what they already have.
  relatedGuidanceField?: string;
}

// Per-turn record appended to WritingSession.turns after turn 1 (ADR 0004).
export type WritingTurn =
  | {
      kind: "draft";
      turnIndex: number;
      ts: string;
      input: { text?: string; imageKeys?: string[]; imageUrls?: string[] };
      packet: DraftFeedbackPacket;
    }
  | {
      kind: "question";
      turnIndex: number;
      ts: string;
      input: { text: string };
      packet: CoachingNotePacket;
    };

export type WritingEndedReason =
  | "completed"
  | "abandoned"
  | "max_drafts"
  | "max_questions";

// Wire format for the Writing Lambda's four NDJSON streaming endpoints.
export type WritingStreamEvent =
  | {
      type: "plan_complete";
      sessionId: string;
      plan: WritingPlanPacket;
      usage: TokenUsage;
      modelChoice: ModelChoice;
    }
  | { type: "transcribing" }
  | {
      type: "feedback_complete";
      turnIndex: number;
      packet: DraftFeedbackPacket;
      draftCount: number;
      questionCount: number;
      usage: TokenUsage;
    }
  | {
      type: "answer_complete";
      turnIndex: number;
      packet: CoachingNotePacket;
      draftCount: number;
      questionCount: number;
      usage: TokenUsage;
    }
  | { type: "limit_reached"; kind: "draft" | "question"; remaining: 0 }
  | { type: "session_ended"; endedReason: WritingEndedReason }
  | { type: "error"; message: string };
