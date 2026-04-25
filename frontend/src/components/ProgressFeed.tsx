interface ToolEvent {
  tool: string;
  done: boolean;
}

const TOOL_LABELS: Record<string, string> = {
  lookup_curriculum: "📚 Checking curriculum",
  fetch_session_history: "🕐 Loading your history",
  solve_question: "🧠 Solving question",
  explain_solution: "✏️ Writing explanation",
  generate_hint: "💡 Generating hints",
  submit_answer: "✅ Finalising answer",
};

interface ProgressFeedProps {
  events: ToolEvent[];
}

export const ProgressFeed = ({ events }: ProgressFeedProps) => {
  if (events.length === 0) {
    return (
      <div className="flex items-center gap-2 text-gray-400 text-sm">
        <span className="inline-block w-2 h-2 rounded-full bg-brand-400 animate-bounce" />
        <span className="animate-pulse">Thinking…</span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {events.map((e, i) => (
        <span
          key={i}
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-semibold transition-all duration-300 ${
            e.done
              ? "bg-green-100 text-green-700"
              : "bg-brand-100 text-brand-700 animate-pulse"
          }`}
        >
          {TOOL_LABELS[e.tool] ?? e.tool}
          {e.done && (
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={3}
                d="M5 13l4 4L19 7"
              />
            </svg>
          )}
        </span>
      ))}
    </div>
  );
};
