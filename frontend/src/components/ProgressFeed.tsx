interface ProgressFeedProps {
  phase: "analyzing" | "generating";
  totalQuestions: number;
  remaining: number;
}

export const ProgressFeed = ({
  phase,
  totalQuestions,
  remaining,
}: ProgressFeedProps) => {
  if (phase === "analyzing") {
    return (
      <div className="flex items-center gap-2 text-gray-500 text-sm">
        <span className="inline-block w-2 h-2 rounded-full bg-brand-400 animate-bounce" />
        <span className="animate-pulse">Reading your homework…</span>
      </div>
    );
  }

  const completed = Math.max(0, totalQuestions - remaining);
  return (
    <div className="flex items-center gap-2 text-gray-500 text-sm">
      <span className="inline-block w-2 h-2 rounded-full bg-brand-400 animate-bounce" />
      <span className="animate-pulse">
        Coaching packets {completed}/{totalQuestions}…
      </span>
    </div>
  );
};
