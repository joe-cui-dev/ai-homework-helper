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
  | { type: "packet_start"; questionId: number; total: number; text: string }
  | { type: "packet_complete"; questionId: number; packet: CoachingPacket }
  | { type: "complete"; packets: BatchPacket[] }
  | { type: "error"; message: string };
