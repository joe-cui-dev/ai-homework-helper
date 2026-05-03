// ── Shared types ──────────────────────────────────────────────────────────────
// Phase 1 (Coaching Packet) wire format. Phase 2 (Coaching Dialogue) will
// define its own event types in a separate handler.
// ─────────────────────────────────────────────────────────────────────────────

export type Subject = "math" | "science" | "english" | "other";
export type YearLevel =
  | "year-1"
  | "year-2"
  | "year-3"
  | "year-4"
  | "year-5"
  | "year-6";

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
  | { type: "complete"; batchId: string; packets: BatchPacket[] }
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
    }
  | { type: "error"; message: string };
