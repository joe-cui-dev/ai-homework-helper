import type {
  BookContext,
  CoachingPacket,
  CoachingNotePacket,
  DraftFeedbackPacket,
  ReadingPacket,
  TokenUsage,
  WritingEndedReason,
  WritingPlanPacket,
} from "./types";

export type { CoachingPacket, TokenUsage };

// One persisted unit of AI interaction. Stored at
// sessions/{studentId}/{sessionId}.json with a 30-day lifecycle.
// Discriminated union on sessionType. See ADR 0004.
export interface SessionBase {
  sessionId: string;
  studentId: string;
  timestamp: string;
  updatedAt: string;
  usage: TokenUsage;
}

export interface HomeworkQuestion {
  questionId: number;
  input: string;
  packet: CoachingPacket;
}

export interface HomeworkSession extends SessionBase {
  sessionType: "homework";
  questions: HomeworkQuestion[];
  imageKeys: string[];
}

export interface ReadingSession extends SessionBase {
  sessionType: "reading";
  bookContext: BookContext;
  readingPackets: ReadingPacket[];
  imageKeys: string[];
}

export type WritingDraftTurn = {
  kind: "draft";
  turnIndex: number;
  ts: string;
  input: { text?: string; imageKeys?: string[] };
  packet: DraftFeedbackPacket;
};

export type WritingQuestionTurn = {
  kind: "question";
  turnIndex: number;
  ts: string;
  input: { text: string };
  packet: CoachingNotePacket;
};

export type WritingTurn = WritingDraftTurn | WritingQuestionTurn;

export interface WritingSession extends SessionBase {
  sessionType: "writing";
  status: "active" | "ended";
  endedReason?: WritingEndedReason;
  endedAt?: string;
  prompt: { input: string; imageKeys: string[] };
  plan: WritingPlanPacket;
  turns: WritingTurn[];
  draftCount: number;
  questionCount: number;
}

export type PracticeEndedReason =
  | "mastered"
  | "partial"
  | "abandoned"
  | "tool_call_cap_reached";

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

export interface PracticeSession extends SessionBase {
  sessionType: "practice";
  status: "active" | "ended";
  endedReason?: PracticeEndedReason;
  endedAt?: string;
  origin: { sessionId: string; questionId: number };
  sourceCoachingPacket: CoachingPacket;
  problemCount: number;
  toolCallCount: number;
  problems: PracticeProblem[];
  toolLog: PracticeToolLogEntry[];
  finalSummary?: string;
}

export type Session =
  | HomeworkSession
  | ReadingSession
  | WritingSession
  | PracticeSession;

export type SessionType = Session["sessionType"];
