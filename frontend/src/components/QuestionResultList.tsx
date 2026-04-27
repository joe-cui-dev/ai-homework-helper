import type { QuestionResult } from "../types";
import type { ActiveQuestion } from "../hooks/useHomeworkStream";
import { ResultCard } from "./ResultCard";
import { LoadingState } from "./LoadingState";
import { ProgressFeed } from "./ProgressFeed";

interface ToolEvent {
  tool: string;
  done: boolean;
}

interface QuestionResultListProps {
  results: QuestionResult[];
  activeQuestion: ActiveQuestion | null;
  toolEvents: ToolEvent[];
  total: number;
}

export function QuestionResultList({
  results,
  activeQuestion,
  toolEvents,
  total,
}: QuestionResultListProps) {
  const showHeader = total > 1;

  return (
    <div className="space-y-4">
      {/* Completed question cards */}
      {results.map((qr) => (
        <div key={qr.questionId} className="space-y-2">
          {showHeader && (
            <p className="text-xs font-bold uppercase tracking-widest text-gray-400 px-1">
              Question {qr.questionId} of {total}
            </p>
          )}
          {qr.questionText && (
            <p className="text-sm text-gray-500 italic px-1 line-clamp-2">
              {qr.questionText}
            </p>
          )}
          <ResultCard result={qr.result} />
        </div>
      ))}

      {/* In-progress question skeleton */}
      {activeQuestion && (
        <div className="space-y-2">
          {showHeader && (
            <p className="text-xs font-bold uppercase tracking-widest text-gray-400 px-1">
              Question {activeQuestion.id} of {activeQuestion.total}
            </p>
          )}
          {activeQuestion.text && (
            <p className="text-sm text-gray-500 italic px-1 line-clamp-2">
              {activeQuestion.text}
            </p>
          )}
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 space-y-3">
            {toolEvents.length > 0 && <ProgressFeed events={toolEvents} />}
            <LoadingState />
          </div>
        </div>
      )}
    </div>
  );
}
