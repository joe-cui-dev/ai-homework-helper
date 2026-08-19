import type { BatchPacket } from "../types";
import type { PendingPacket } from "../hooks/useHomeworkStream";
import { ResultCard } from "./ResultCard";
import { LoadingState } from "./LoadingState";

interface QuestionResultListProps {
  packets: BatchPacket[];
  pending: PendingPacket[];
  total: number;
  onPractise?: (questionId: number, questionText: string, packet: BatchPacket["packet"]) => void;
  updatedQuestionIds?: number[];
  possiblyRepeatedQuestionIds?: number[];
}

export function QuestionResultList({
  packets,
  pending,
  total,
  onPractise,
  updatedQuestionIds = [],
  possiblyRepeatedQuestionIds = [],
}: QuestionResultListProps) {
  const showHeader = total > 1;

  return (
    <div className="space-y-4">
      {/* Completed coaching packets */}
      {packets.map((bp) => (
        <div key={bp.questionId} className="space-y-2">
          {showHeader && (
            <p className="text-xs font-bold uppercase tracking-widest text-gray-400 px-1">
              Question {bp.questionId} of {total}
            </p>
          )}
          {bp.questionText && (
            <p className="text-sm text-gray-500 italic px-1 line-clamp-2">
              {bp.questionText}
            </p>
          )}
          {(updatedQuestionIds.includes(bp.questionId) || possiblyRepeatedQuestionIds.includes(bp.questionId)) && (
            <div className="flex gap-2 px-1 text-xs font-semibold" role="status" aria-live="polite">
              {updatedQuestionIds.includes(bp.questionId) && <span className="text-brand-600">Updated</span>}
              {possiblyRepeatedQuestionIds.includes(bp.questionId) && <span className="text-amber-700">Possibly repeated</span>}
            </div>
          )}
          <ResultCard
            packet={bp.packet}
            subject={bp.subject}
            yearLevel={bp.yearLevel}
            onPractise={
              onPractise
                ? () => onPractise(bp.questionId, bp.questionText, bp.packet)
                : undefined
            }
          />
        </div>
      ))}

      {/* Optimistic placeholders for packets still being generated */}
      {pending.map((p) => (
        <div key={`pending-${p.questionId}`} className="space-y-2">
          {showHeader && (
            <p className="text-xs font-bold uppercase tracking-widest text-gray-400 px-1">
              Question {p.questionId} of {total}
            </p>
          )}
          {p.text && (
            <p className="text-sm text-gray-500 italic px-1 line-clamp-2">
              {p.text}
            </p>
          )}
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
            <LoadingState />
          </div>
        </div>
      ))}
    </div>
  );
}
