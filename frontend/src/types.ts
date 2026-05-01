// Mirrored from backend/src/types.ts — kept separate to avoid circular workspace imports.

export interface SessionQuestion {
  input: string;
  subject: string;
  difficulty: string;
  answer: string;
  steps: string[];
  explanation: string;
  hints?: string[];
}

export interface SessionSummary {
  sessionId: string;
  timestamp: string;
  subjects: string[];
  imageUrls: string[];
  questions: SessionQuestion[];
}

export interface AgentResult {
  subject: string;
  difficulty: string;
  answer: string;
  steps: string[];
  explanation: string;
  hints?: string[];
}

export interface QuestionResult {
  questionId: number;
  questionText: string;
  result: AgentResult;
}

export type StreamEvent =
  | { type: "tool_start"; tool: string }
  | { type: "tool_end"; tool: string }
  | { type: "question_start"; questionId: number; total: number; text: string }
  | { type: "question_complete"; questionId: number; result: AgentResult }
  | { type: "complete"; results: QuestionResult[] }
  | { type: "error"; message: string };
