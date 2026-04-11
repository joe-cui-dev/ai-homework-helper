// ── Shared types ──────────────────────────────────────────────────────────────
// StreamEvent is the wire format for the NDJSON stream sent to the browser.
// The frontend processes each event as it arrives:
//   tool_start / tool_end  → display live progress (which tool is running)
//   complete               → render the final answer card
//   error                  → show an error message
// ─────────────────────────────────────────────────────────────────────────────
export interface AgentResult {
  subject: string;
  difficulty: string;
  answer: string;
  steps: string[];
  explanation: string;
  hints?: string[];
}

export type StreamEvent =
  | { type: "tool_start"; tool: string }
  | { type: "tool_end"; tool: string }
  | { type: "complete"; result: AgentResult }
  | { type: "error"; message: string };
