// Mirrored from backend/src/types.ts — kept separate to avoid circular workspace imports.

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

export interface SessionQuestion {
  questionId: number;
  input: string;
  packet: CoachingPacket;
  practiceSession?: PracticeSessionSummary;
}

export interface SessionSummary {
  sessionId: string;
  timestamp: string;
  subjects: string[];
  imageUrls: string[];
  questions: SessionQuestion[];
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

export type EndedReason = "mastered" | "partial" | "abandoned";

export interface PracticeSessionSummary {
  questionId: number;
  status: "active" | "ended";
  endedReason?: EndedReason;
  problemCount: number;
  updatedAt: string;
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
      agentMessage: string;
      problem?: string;
      isSessionEnded: boolean;
      endedReason?: EndedReason;
      finalSummary?: string;
    }
  | { type: "error"; message: string };
