// ── Shared types ──────────────────────────────────────────────────────────────
// StreamEvent is the wire format for the NDJSON stream sent to the browser.
// The frontend processes each event as it arrives:
//   tool_start / tool_end      → display live progress (which tool is running)
//   question_start             → a new question is being solved (id, total, text)
//   question_complete          → one question finished (id + result)
//   complete                   → all questions done; carries full results array
//   error                      → show an error message
// ─────────────────────────────────────────────────────────────────────────────
export interface AgentResult {
  subject: string;
  difficulty: string;
  answer: string;
  steps: string[];
  explanation: string;
  hints?: string[];
}

export interface IdentifiedQuestion {
  id: number;
  text: string;
  usesArticle: boolean;
  sourcePage?: number; // 0-based index into the images array
}

export interface PageAnalysis {
  articleContext?: string;
  questions: IdentifiedQuestion[];
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
