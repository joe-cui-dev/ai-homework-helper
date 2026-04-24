import { QuestionInput } from "./QuestionInput";
import { ProgressFeed } from "./ProgressFeed";
import { ResultCard } from "./ResultCard";
import { LoadingState } from "./LoadingState";
import { useHomeworkStream } from "../hooks/useHomeworkStream";

interface HomePageProps {
  email: string;
  token: string;
  onLogout: () => void;
}

export function HomePage({ email, token, onLogout }: HomePageProps) {
  const { status, toolEvents, result, error, submit, reset } =
    useHomeworkStream();

  const handleSubmit = (question: string, image?: string) => {
    submit(question, token, image);
  };

  const isStreaming = status === "streaming";
  const isDone = status === "done";
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

        {/* Progress feed */}
        {isStreaming && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
            <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-3">
              Your tutor is working…
            </p>
            <ProgressFeed events={toolEvents} />
          </div>
        )}

        {/* Loading skeleton while streaming before first result */}
        {isStreaming && toolEvents.length > 0 && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
            <LoadingState />
          </div>
        )}

        {/* Result */}
        {isDone && result && <ResultCard result={result} />}

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

        {/* Ask another question */}
        {isDone && (
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
}
