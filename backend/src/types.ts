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
  | { type: "packet_start"; questionId: number; total: number; text: string }
  | { type: "packet_complete"; questionId: number; packet: CoachingPacket }
  | { type: "complete"; packets: BatchPacket[] }
  | { type: "error"; message: string };
