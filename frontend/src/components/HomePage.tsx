import { useState } from "react";
import { QuestionInput } from "./QuestionInput";
import { QuestionResultList } from "./QuestionResultList";
import { ProgressFeed } from "./ProgressFeed";
import { HistorySidebar } from "./HistorySidebar";
import { PracticeModal } from "./PracticeModal";
import { ReadingInput } from "./ReadingInput";
import { ReadingPacketCard } from "./ReadingPacketCard";
import { useHomeworkStream } from "../hooks/useHomeworkStream";
import { useReadingStream } from "../hooks/useReadingStream";
import { formatUsage } from "../utils/formatUsage";
import type { CoachingPacket, TaskType } from "../types";

interface PracticeModalState {
  batchId: string;
  questionId: number;
  questionText: string;
  packet: CoachingPacket;
}

interface HomePageProps {
  email: string;
  token: string;
  onLogout: () => void;
}

export const HomePage = ({ email, token, onLogout }: HomePageProps) => {
  const [taskType, setTaskType] = useState<TaskType>("homework");
  const homework = useHomeworkStream();
  const reading = useReadingStream();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [practice, setPractice] = useState<PracticeModalState | null>(null);

  const openPractice = (
    questionId: number,
    questionText: string,
    packet: CoachingPacket,
  ) => {
    if (!homework.batchId) return;
    setPractice({ batchId: homework.batchId, questionId, questionText, packet });
  };

  const handleHomeworkSubmit = (question: string, images: string[]) => {
    homework.submit(question, token, images.length > 0 ? images : undefined);
  };

  const handleReadingSubmit = (images: string[]) => {
    reading.submit(token, images);
  };

  const switchTaskType = (next: TaskType) => {
    if (next === taskType) return;
    // Reset both streams so the in-progress one doesn't bleed into the other tab.
    homework.reset();
    reading.reset();
    setTaskType(next);
  };

  // ── Derived UI state ───────────────────────────────────────────────────
  const isHomework = taskType === "homework";
  const isReading = taskType === "reading";

  const homeworkAnalyzing = homework.status === "analyzing";
  const homeworkGenerating = homework.status === "generating";
  const homeworkWorking = homeworkAnalyzing || homeworkGenerating;
  const homeworkDone = homework.status === "done";
  const homeworkStopped = homework.status === "stopped";
  const homeworkError = homework.status === "error";

  const readingAnalyzing = reading.status === "analyzing";
  const readingGenerating = reading.status === "generating";
  const readingWorking = readingAnalyzing || readingGenerating;
  const readingDone = reading.status === "done";
  const readingStopped = reading.status === "stopped";
  const readingError = reading.status === "error";
  const readingNeedsMore = reading.status === "needs_more_pages";

  return (
    <div className="min-h-screen bg-gradient-to-br from-sky-100 via-indigo-50 to-purple-100">
      <HistorySidebar token={token} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      {/* Header */}
      <header className="bg-white/80 backdrop-blur-sm border-b border-gray-100 sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-1.5 rounded-lg text-gray-400 hover:text-brand-600 hover:bg-brand-50 transition-colors"
              aria-label="Open history"
            >
              <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path
                  fillRule="evenodd"
                  d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h6a1 1 0 110 2H4a1 1 0 01-1-1z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
            <span className="text-2xl">🎒</span>
            <span className="font-extrabold text-base sm:text-xl text-brand-700 tracking-tight">
              Homework Coach
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500 hidden sm:block truncate max-w-[180px]">
              {email}
            </span>
            <button
              onClick={onLogout}
              className="px-3 py-1.5 rounded-xl text-sm font-semibold text-gray-500 hover:text-red-500 hover:bg-red-50 transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="max-w-2xl mx-auto px-3 sm:px-4 py-5 sm:py-8 space-y-4 sm:space-y-6">
        {/* Welcome */}
        {homework.status === "idle" && reading.status === "idle" && (
          <div className="text-center space-y-1 pb-2">
            <h1 className="text-2xl sm:text-3xl font-extrabold text-gray-800">
              Coaching packets for parents
            </h1>
            <p className="text-gray-500">
              {isHomework
                ? "Snap a photo of your child's homework. We'll prepare what to teach and what to watch for."
                : "Upload a book your child is reading. We'll generate questions to check their comprehension."}
            </p>
          </div>
        )}

        {/* Task-type tabs */}
        <div className="flex gap-1 p-1 bg-white/60 rounded-2xl border border-gray-100">
          <button
            onClick={() => switchTaskType("homework")}
            disabled={homeworkWorking || readingWorking}
            className={`flex-1 py-2 px-3 rounded-xl text-sm font-bold transition-colors ${
              isHomework
                ? "bg-white text-brand-700 shadow-sm"
                : "text-gray-500 hover:text-brand-600"
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            🎒 Homework
          </button>
          <button
            onClick={() => switchTaskType("reading")}
            disabled={homeworkWorking || readingWorking}
            className={`flex-1 py-2 px-3 rounded-xl text-sm font-bold transition-colors ${
              isReading
                ? "bg-white text-brand-700 shadow-sm"
                : "text-gray-500 hover:text-brand-600"
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            📚 Reading
          </button>
        </div>

        {/* Input — switched on tab */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 sm:p-6">
          {isHomework ? (
            <QuestionInput onSubmit={handleHomeworkSubmit} disabled={homeworkWorking} />
          ) : (
            <ReadingInput onSubmit={handleReadingSubmit} disabled={readingWorking} />
          )}
        </div>

        {/* ── Homework results ─────────────────────────────────────────── */}
        {isHomework && homeworkWorking && (
          <div className="bg-white/60 rounded-2xl border border-gray-100 px-5 py-3 flex items-center justify-between gap-4">
            <div className="min-w-0 flex-1">
              <ProgressFeed
                phase={homeworkAnalyzing ? "analyzing" : "generating"}
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

        {isHomework &&
          (homeworkWorking || homeworkDone || homeworkStopped) &&
          (homework.packets.length > 0 || homework.pending.length > 0) && (
            <QuestionResultList
              packets={homework.packets}
              pending={homework.pending}
              total={homework.totalQuestions}
              onPractise={openPractice}
            />
          )}

        {isHomework && (homeworkDone || homeworkStopped) && homework.usage && (
          <p className="text-xs text-gray-500 text-center px-1">
            Batch usage: {formatUsage(homework.usage)}
          </p>
        )}

        {isHomework && homeworkError && (
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

        {isHomework && homeworkStopped && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-center space-y-1">
            <p className="text-amber-700 font-semibold text-sm">Stopped early</p>
            {homework.packets.length > 0 && (
              <p className="text-amber-600 text-xs">
                {homework.packets.length} packet{homework.packets.length !== 1 ? "s" : ""} ready above.
              </p>
            )}
          </div>
        )}

        {isHomework && (homeworkDone || homeworkStopped) && (
          <div className="text-center">
            <button
              onClick={homework.reset}
              className="px-6 py-2.5 rounded-2xl bg-white border-2 border-brand-200 text-brand-600 font-bold hover:bg-brand-50 transition-colors shadow-sm"
            >
              Coach another question
            </button>
          </div>
        )}

        {/* ── Reading results ──────────────────────────────────────────── */}
        {isReading && readingWorking && (
          <div className="bg-white/60 rounded-2xl border border-gray-100 px-5 py-3 flex items-center justify-between gap-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-gray-600">
                {readingAnalyzing
                  ? "Reading the book…"
                  : reading.packets.length > 0
                    ? `Writing question ${reading.packets.length + 1} of 5…`
                    : "Writing comprehension questions…"}
              </p>
            </div>
            <button
              onClick={reading.stop}
              className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-red-50 text-red-500 font-semibold text-sm hover:bg-red-100 transition-colors"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <rect x="3" y="3" width="10" height="10" rx="1" />
              </svg>
              Stop
            </button>
          </div>
        )}

        {isReading && (readingDone || readingStopped) && reading.bookContext && (
          <div className="bg-white/60 rounded-2xl border border-gray-100 px-4 py-3 text-sm text-gray-700">
            <span className="font-semibold">
              {reading.bookContext.title ?? "This book"}
            </span>
            {reading.bookContext.author && (
              <span className="text-gray-500"> — {reading.bookContext.author}</span>
            )}
            {reading.yearLevel && (
              <span className="text-gray-500"> · {reading.yearLevel.replace("year-", "Year ")}</span>
            )}
          </div>
        )}

        {isReading &&
          (readingWorking || readingDone || readingStopped) &&
          reading.packets.length > 0 && (
            <div className="space-y-4">
              {reading.packets.map((bp, i) => (
                <ReadingPacketCard
                  key={bp.questionId}
                  packet={bp.packet}
                  index={i}
                  total={Math.max(reading.packets.length, 5)}
                />
              ))}
            </div>
          )}

        {isReading && (readingDone || readingStopped) && reading.usage && (
          <p className="text-xs text-gray-500 text-center px-1">
            Batch usage: {formatUsage(reading.usage)}
          </p>
        )}

        {isReading && readingNeedsMore && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 text-center space-y-3">
            <p className="text-amber-700 font-semibold">I need a few more pages</p>
            <p className="text-amber-600 text-sm">{reading.needsMorePagesMessage}</p>
            <button
              onClick={reading.reset}
              className="px-5 py-2 rounded-xl bg-amber-100 text-amber-700 font-semibold hover:bg-amber-200 transition-colors text-sm"
            >
              Try again with more pages
            </button>
          </div>
        )}

        {isReading && readingError && (
          <div className="bg-red-50 border border-red-200 rounded-2xl p-5 text-center space-y-3">
            <p className="text-red-600 font-semibold">Something went wrong</p>
            <p className="text-red-500 text-sm">{reading.error}</p>
            <button
              onClick={reading.reset}
              className="px-5 py-2 rounded-xl bg-red-100 text-red-600 font-semibold hover:bg-red-200 transition-colors text-sm"
            >
              Try again
            </button>
          </div>
        )}

        {isReading && (readingDone || readingStopped) && (
          <div className="text-center">
            <button
              onClick={reading.reset}
              className="px-6 py-2.5 rounded-2xl bg-white border-2 border-brand-200 text-brand-600 font-bold hover:bg-brand-50 transition-colors shadow-sm"
            >
              Try another book
            </button>
          </div>
        )}
      </main>

      {practice && (
        <PracticeModal
          batchId={practice.batchId}
          questionId={practice.questionId}
          questionText={practice.questionText}
          packet={practice.packet}
          token={token}
          onClose={() => setPractice(null)}
        />
      )}
    </div>
  );
};
