// ── Shared types ──────────────────────────────────────────────────────────────
// Phase 1 (Coaching Packet) wire format. Phase 2 (Coaching Dialogue) will
// define its own event types in a separate handler.
// ─────────────────────────────────────────────────────────────────────────────

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
// Parent-facing fields (whyItWorks, howToCoach, watchFor) are adult-to-adult
// regardless of yearLevel. Only childHint is calibrated to the year level.
export interface CoachingPacket {
  questionId: number;
  subject: Subject;
  yearLevel: YearLevel;
  tldrAnswer: string;
  whyItWorks: string;
  howToCoach: string;
  watchFor: string[];
  childHint: string;
}

export interface BatchPacket {
  questionId: number;
  questionText: string;
  packet: CoachingPacket;
}

export interface IdentifiedQuestion {
  id: number;
  text: string;
  usesArticle: boolean;
  sourcePage?: number;
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
      batchId: string;
      questionId: number;
      total: number;
      text: string;
    }
  | { type: "packet_complete"; questionId: number; packet: CoachingPacket }
  | {
      type: "complete";
      batchId: string;
      packets: BatchPacket[];
      usage: TokenUsage;
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
      batchId: string;
      questionId: number;
      total: number;
    }
  | { type: "reading_packet_complete"; questionId: number; packet: ReadingPacket }
  | {
      type: "reading_complete";
      batchId: string;
      bookContext: BookContext;
      packets: ReadingBatchPacket[];
      usage: TokenUsage;
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

export type EndedReason = "mastered" | "partial" | "abandoned";

// One generated practice problem and its expected answer. Cached server-side
// keyed by problemIndex inside the PracticeSession; the answer is never sent
// to the client until the agent calls evaluate_attempt.
export interface PracticeProblem {
  problemIndex: number;
  problem: string;
  expectedAnswer: string;
  difficulty: "easier" | "same" | "harder";
}

export interface PracticeToolLogEntry {
  turn: number;
  tool: string;
  ts: string;
}

import type { BedrockMessage } from "./bedrock";

export interface PracticeSession {
  practiceSessionId: string;
  studentId: string;
  sourceBatchId: string;
  sourceQuestionId: number;
  sourceCoachingPacket: CoachingPacket;
  createdAt: string;
  updatedAt: string;
  status: "active" | "ended";
  endedReason?: EndedReason;
  problemCount: number;
  toolCallCount: number;
  problems: PracticeProblem[];
  messages: BedrockMessage[];
  toolLog: PracticeToolLogEntry[];
  finalSummary?: string;
  // Cumulative usage across every turn in this practice session.
  totalUsage: TokenUsage;
}

// Wire format from /practice/start, /practice/turn, /practice/end.
// Distinct from the Phase 1 StreamEvent union — the frontend has two parsers,
// one per Lambda.
export type PracticeStreamEvent =
  | { type: "tool_start"; tool: string }
  | { type: "tool_end"; tool: string }
  | {
      type: "turn_complete";
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

// One-sentence explanation, per success criterion per sample, of how that
// sample satisfies the criterion. Surfaced outside the modelAnswers disclosure
// because the abstract justifications are coaching material, not copyable text.
export interface CriteriaJustification {
  criterion: string;
  atYearLevel: string;
  aboveYearLevel: string;
}

// Pair of student-voice exemplars: atYearLevel matches the locked yearLevel;
// aboveYearLevel is one year above, capped at Year 6 (where it stays at Year 6
// but is described as "upper Year 6"). Both gated behind a UI disclosure.
export interface ModelAnswerPair {
  atYearLevel: string;
  aboveYearLevel: string;
  aboveYearLevelLabel: string;
  criteriaJustifications: CriteriaJustification[];
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
  planningQuestions: string[];
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

// Per-turn record appended to WritingSessionRecord.turns after turn 1.
export type WritingTurn =
  | {
      kind: "draft";
      turnIndex: number;
      ts: string;
      input: { text?: string; imageKeys?: string[] };
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

// Per-turn raw usage entry. Lives under _internal — never echoed in history.
export interface WritingTurnUsage {
  turnIndex: number;
  inputTokens: number;
  outputTokens: number;
}

// Internal namespace inside the SessionRecord JSON. The history reader and
// getRecentSessions skip this field — see ADR 0003.
export interface WritingSessionInternal {
  messages: BedrockMessage[];
  usagePerTurn: WritingTurnUsage[];
}

// Full Writing Session record persisted at sessions/{studentId}/{batchId}.json.
// Public fields conform to the SessionRecord polymorphism (sessionType="writing").
// _internal carries Bedrock state and is never returned to the frontend.
export interface WritingSessionRecord {
  sessionId: string;
  studentId: string;
  sessionType: "writing";
  timestamp: string;
  updatedAt: string;
  status: "active" | "ended";
  endedReason?: WritingEndedReason;
  prompt: { input: string; imageKeys?: string[] };
  plan: WritingPlanPacket;
  turns: WritingTurn[];
  draftCount: number;
  questionCount: number;
  imageKeys: string[];
  usage: TokenUsage;
  _internal: WritingSessionInternal;
}

// Public projection of a Writing Session — the shape returned by the History
// Lambda for history listings and resume. _internal is stripped.
export interface WritingSessionPublic {
  sessionId: string;
  sessionType: "writing";
  timestamp: string;
  updatedAt: string;
  status: "active" | "ended";
  endedReason?: WritingEndedReason;
  prompt: { input: string; imageKeys?: string[] };
  plan: WritingPlanPacket;
  turns: WritingTurn[];
  draftCount: number;
  questionCount: number;
  imageKeys: string[];
  usage?: TokenUsage;
}

// Wire format for the Writing Lambda's four NDJSON streaming endpoints.
export type WritingStreamEvent =
  | { type: "plan_complete"; batchId: string; plan: WritingPlanPacket; usage: TokenUsage }
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
