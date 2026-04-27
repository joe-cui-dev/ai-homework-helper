import { QuestionInput } from "./QuestionInput";
import { QuestionResultList } from "./QuestionResultList";
import { useHomeworkStream } from "../hooks/useHomeworkStream";

interface HomePageProps {
  email: string;
  token: string;
  onLogout: () => void;
}

export const HomePage = ({ email, token, onLogout }: HomePageProps) => {
  const { status, toolEvents, results, activeQuestion, totalQuestions, error, submit, stop, reset } =
    useHomeworkStream();

  const handleSubmit = (question: string, images: string[]) => {
    submit(question, token, images.length > 0 ? images : undefined);
  };

  const isStreaming = status === "streaming";
  const isDone = status === "done";
  const isStopped = status === "stopped";
  const isError = status === "error";

  return (
    <div className="min-h-screen bg-gradient-to-br from-sky-100 via-indigo-50 to-purple-100">
      {/* Header */}
      <header className="bg-white/80 backdrop-blur-sm border-b border-gray-100 sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-2xl">🎒</span>
            <span className="font-extrabold text-base sm:text-xl text-brand-700 tracking-tight">
              AI Homework Helper
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
        {status === "idle" && (
          <div className="text-center space-y-1 pb-2">
            <h1 className="text-2xl sm:text-3xl font-extrabold text-gray-800">
              What are we learning today? ✨
            </h1>
            <p className="text-gray-500">
              Type your question or snap a photo of your homework.
            </p>
          </div>
        )}

        {/* Input */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 sm:p-6">
          <QuestionInput onSubmit={handleSubmit} disabled={isStreaming} />
        </div>

        {/* Streaming status bar + stop button */}
        {isStreaming && (
          <div className="bg-white/60 rounded-2xl border border-gray-100 px-5 py-3 flex items-center justify-between gap-4">
            <div className="min-w-0">
              {activeQuestion && activeQuestion.total > 1 ? (
                <>
                  <p className="text-xs font-bold uppercase tracking-widest text-gray-400">
                    Solving question {activeQuestion.id} of {activeQuestion.total}…
                  </p>
                  <p className="text-sm text-gray-600 mt-0.5 line-clamp-1">
                    {activeQuestion.text}
                  </p>
                </>
              ) : (
                <p className="text-xs font-bold uppercase tracking-widest text-gray-400">
                  Your tutor is working…
                </p>
              )}
            </div>
            <button
              onClick={stop}
              className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-red-50 text-red-500 font-semibold text-sm hover:bg-red-100 transition-colors"
              aria-label="Stop processing"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
                <rect x="3" y="3" width="10" height="10" rx="1" />
              </svg>
              Stop
            </button>
          </div>
        )}

        {/* Results list (progressive — cards appear as each question completes) */}
        {(isStreaming || isDone || isStopped) && (results.length > 0 || activeQuestion) && (
          <QuestionResultList
            results={results}
            activeQuestion={activeQuestion}
            toolEvents={toolEvents}
            total={totalQuestions}
          />
        )}

        {/* Error */}
        {isError && (
          <div className="bg-red-50 border border-red-200 rounded-2xl p-5 text-center space-y-3">
            <p className="text-red-600 font-semibold">
              😕 Something went wrong
            </p>
            <p className="text-red-500 text-sm">{error}</p>
            <button
              onClick={reset}
              className="px-5 py-2 rounded-xl bg-red-100 text-red-600 font-semibold hover:bg-red-200 transition-colors text-sm"
            >
              Try again
            </button>
          </div>
        )}

        {/* Stopped notice */}
        {isStopped && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-center space-y-1">
            <p className="text-amber-700 font-semibold text-sm">Stopped early</p>
            {results.length > 0 && (
              <p className="text-amber-600 text-xs">
                {results.length} question{results.length !== 1 ? "s" : ""} answered above.
              </p>
            )}
          </div>
        )}

        {/* Ask another question */}
        {(isDone || isStopped) && (
          <div className="text-center">
            <button
              onClick={reset}
              className="px-6 py-2.5 rounded-2xl bg-white border-2 border-brand-200 text-brand-600 font-bold hover:bg-brand-50 transition-colors shadow-sm"
            >
              Ask another question 🔁
            </button>
          </div>
        )}
      </main>
    </div>
  );
};
