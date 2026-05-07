import { useNavigate } from "react-router-dom";
import { QuestionInput } from "../components/QuestionInput";
import { QuestionResultList } from "../components/QuestionResultList";
import { ProgressFeed } from "../components/ProgressFeed";
import { useHomeworkStream } from "../hooks/useHomeworkStream";
import { formatUsage } from "../utils/formatUsage";
import type { CoachingPacket } from "../types";

interface HomeworkPageProps {
  token: string;
}

export const HomeworkPage = ({ token }: HomeworkPageProps) => {
  const navigate = useNavigate();
  const homework = useHomeworkStream();

  const analyzing = homework.status === "analyzing";
  const generating = homework.status === "generating";
  const working = analyzing || generating;
  const done = homework.status === "done";
  const stopped = homework.status === "stopped";
  const error = homework.status === "error";

  const handleSubmit = (question: string, images: string[]) => {
    homework.submit(question, token, images.length > 0 ? images : undefined);
  };

  const openPractice = (
    questionId: number,
    _questionText: string,
    _packet: CoachingPacket,
  ) => {
    if (!homework.batchId) return;
    navigate(`/practice/${homework.batchId}:${questionId}`);
  };

  return (
    <main className="max-w-2xl mx-auto px-3 sm:px-4 py-5 sm:py-8 space-y-4 sm:space-y-6">
      {homework.status === "idle" && (
        <div className="text-center space-y-1 pb-2">
          <h1 className="text-2xl sm:text-3xl font-extrabold text-gray-800">
            Homework Coach
          </h1>
          <p className="text-gray-500">
            Snap a photo of your child's homework. We'll prepare what to teach and what to watch for.
          </p>
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 sm:p-6">
        <QuestionInput onSubmit={handleSubmit} disabled={working} />
      </div>

      {working && (
        <div className="bg-white/60 rounded-2xl border border-gray-100 px-5 py-3 flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <ProgressFeed
              phase={analyzing ? "analyzing" : "generating"}
              totalQuestions={homework.totalQuestions}
              remaining={homework.pending.length}
            />
          </div>
          <button
            onClick={homework.stop}
            className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-red-50 text-red-500 font-semibold text-sm hover:bg-red-100 transition-colors"
            aria-label="Stop processing"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <rect x="3" y="3" width="10" height="10" rx="1" />
            </svg>
            Stop
          </button>
        </div>
      )}

      {(working || done || stopped) &&
        (homework.packets.length > 0 || homework.pending.length > 0) && (
          <QuestionResultList
            packets={homework.packets}
            pending={homework.pending}
            total={homework.totalQuestions}
            onPractise={openPractice}
          />
        )}

      {(done || stopped) && homework.usage && (
        <p className="text-xs text-gray-500 text-center px-1">
          Batch usage: {formatUsage(homework.usage)}
        </p>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-5 text-center space-y-3">
          <p className="text-red-600 font-semibold">Something went wrong</p>
          <p className="text-red-500 text-sm">{homework.error}</p>
          <button
            onClick={homework.reset}
            className="px-5 py-2 rounded-xl bg-red-100 text-red-600 font-semibold hover:bg-red-200 transition-colors text-sm"
          >
            Try again
          </button>
        </div>
      )}

      {stopped && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-center space-y-1">
          <p className="text-amber-700 font-semibold text-sm">Stopped early</p>
          {homework.packets.length > 0 && (
            <p className="text-amber-600 text-xs">
              {homework.packets.length} packet{homework.packets.length !== 1 ? "s" : ""} ready above.
            </p>
          )}
        </div>
      )}

      {(done || stopped) && (
        <div className="text-center">
          <button
            onClick={homework.reset}
            className="px-6 py-2.5 rounded-2xl bg-white border-2 border-brand-200 text-brand-600 font-bold hover:bg-brand-50 transition-colors shadow-sm"
          >
            Coach another question
          </button>
        </div>
      )}
    </main>
  );
};
