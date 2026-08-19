// Mirrored from backend/src/types.ts — kept separate to avoid circular workspace imports.

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type ModelChoice = "fast" | "advanced";

export type Subject = "math" | "science" | "english" | "other";
export type YearLevel =
  | "year-1"
  | "year-2"
  | "year-3"
  | "year-4"
  | "year-5"
  | "year-6";

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

export interface SessionQuestion {
  questionId: number;
  input: string;
  subject: Subject;
  yearLevel: YearLevel;
  packet: CoachingPacket;
  possiblyRepeatedOfQuestionId?: number;
  practiceSession?: PracticeSessionSummary;
}

// ── Reading Session types ───────────────────────────────────────────────────

export type TaskType = "homework" | "reading" | "writing";

export type ReadingQuestionType = "literal" | "inference" | "vocabulary";

export interface BookContext {
  title?: string;
  author?: string;
}

export interface ReadingPacket {
  questionId: number;
  yearLevel: YearLevel;
  questionType: ReadingQuestionType;
  questionText: string;
  modelAnswer: string;
  comprehensionSkill: string;
  coachingTip: string;
  commonMisreadings: string[];
  discussionPrompt: string;
  pageReference?: string;
}

export interface ReadingBatchPacket {
  questionId: number;
  packet: ReadingPacket;
}

export interface SessionSummary {
  sessionId: string;
  timestamp: string;
  // Discriminator. History API normalises legacy rows to "homework".
  sessionType: TaskType;
  modelChoice?: ModelChoice;
  subjects: string[];
  imageUrls: Array<string | null>;
  questions: SessionQuestion[];
  // Reading-only fields. Empty/undefined for non-reading sessions.
  bookContext?: BookContext;
  readingPackets?: ReadingPacket[];
  // Writing-only fields. Empty/undefined for non-writing sessions.
  status?: "active" | "ended";
  endedReason?: WritingEndedReason;
  updatedAt?: string;
  prompt?: { input: string; imageKeys?: string[] };
  plan?: WritingPlanPacket;
  turns?: WritingTurn[];
  draftCount?: number;
  questionCount?: number;
  usage?: TokenUsage;
}

export type StreamEvent =
  | { type: "analyzing" }
  | { type: "append_phase"; phase: "preparing" | "analyzing" | "generating" | "saving" }
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
      pageCount: number;
      questionCount: number;
      updatedQuestionIds: number[];
      possiblyRepeatedQuestionIds: number[];
      hasNoCompleteQuestions: boolean;
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
  | {
      type: "reading_packet_complete";
      questionId: number;
      packet: ReadingPacket;
    }
  | {
      type: "reading_complete";
      sessionId: string;
      bookContext: BookContext;
      packets: ReadingBatchPacket[];
      usage: TokenUsage;
      modelChoice: ModelChoice;
    }
  | { type: "error"; message: string; code?: string; retryable?: boolean };

// ── Phase 2: Practice Tutor Loop ─────────────────────────────────────────────

export type EndedReason = "mastered" | "partial" | "abandoned";

export interface PracticeSessionSummary {
  questionId: number;
  status: "active" | "ended";
  endedReason?: EndedReason;
  problemCount: number;
  updatedAt: string;
  totalUsage?: TokenUsage;
}

// Per-turn UI-facing transcript entry. Built up in usePracticeSession from
// the server's turn_complete events plus locally-appended parent messages.
export type TranscriptEntry =
  | {
      role: "agent";
      agentMessage: string;
      problem?: string;
      isSessionEnded: boolean;
      endedReason?: EndedReason;
      finalSummary?: string;
    }
  | { role: "parent"; message: string };

export type PracticeStreamEvent =
  | { type: "tool_start"; tool: string }
  | { type: "tool_end"; tool: string }
  | {
      type: "turn_complete";
      sessionId: string;
      agentMessage: string;
      problem?: string;
      isSessionEnded: boolean;
      endedReason?: EndedReason;
      finalSummary?: string;
      turnUsage: TokenUsage;
      sessionUsage: TokenUsage;
    }
  | { type: "error"; message: string };

// ── Writing Session types (mirror backend/src/shared/types.ts) ──────────────

export type WritingGenre =
  | "narrative"
  | "persuasive"
  | "recount"
  | "descriptive"
  | "information_report"
  | "explanation"
  | "procedure"
  | "other";

export type WritingEndedReason =
  | "completed"
  | "abandoned"
  | "max_drafts"
  | "max_questions";

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

export interface WritingPlanPacket {
  assignmentSummary: string;
  genre: WritingGenre;
  yearLevel: YearLevel;
  yearLevelSource?: "user" | "inferred";
  successCriteria: string[];
  planningQuestions: PlanningQuestion[];
  modelAnswers: ModelAnswerPair;
  vocabularyToOffer: string[];
  watchFor: string[];
  coachingScript: string;
}

export interface FeedbackHighlight {
  evidenceQuote: string;
  comment: string;
}

export interface DraftFeedbackWish {
  evidenceQuote: string;
  comment: string;
  revisionSuggestion: string;
}

export type RubricDimensionName =
  | "Ideas & Content"
  | "Structure & Organisation"
  | "Language & Vocabulary"
  | "Mechanics";

export interface RubricDimension {
  name: RubricDimensionName;
  score: 1 | 2 | 3 | 4;
  rationale: string;
}

export type OverallBand =
  | "Working towards"
  | "At standard"
  | "Above standard";

export interface DraftRubric {
  dimensions: RubricDimension[];
  overallBand: OverallBand;
}

export type DraftNextStep =
  | "revise_with_focus"
  | "ready_for_final_read_aloud"
  | "needs_replanning";

export interface DraftFeedbackPacket {
  transcription: string;
  againstPrompt: string;
  twoStars: FeedbackHighlight[];
  oneWish: DraftFeedbackWish;
  rubric: DraftRubric;
  mechanicsNotes: string[];
  coachingScript: string;
  nextStep: DraftNextStep;
}

export interface CoachingNotePacket {
  questionUnderstood: string;
  answer: string;
  coachingTip: string;
  relatedGuidanceField?: string;
}

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
