import { ReadingInput } from "../components/ReadingInput";
import { ReadingPacketCard } from "../components/ReadingPacketCard";
import { ModuleHistoryButton } from "../components/ModuleHistoryButton";
import { useReadingStream } from "../hooks/useReadingStream";
import { formatUsage } from "../utils/formatUsage";

interface ReadingPageProps {
  token: string;
}

export const ReadingPage = ({ token }: ReadingPageProps) => {
  const reading = useReadingStream();

  const analyzing = reading.status === "analyzing";
  const generating = reading.status === "generating";
  const working = analyzing || generating;
  const done = reading.status === "done";
  const stopped = reading.status === "stopped";
  const needsMore = reading.status === "needs_more_pages";
  const error = reading.status === "error";

  const handleSubmit = (images: string[]) => {
    reading.submit(token, images);
  };

  return (
    <main className="max-w-2xl mx-auto px-3 sm:px-4 py-5 sm:py-8 space-y-4 sm:space-y-6">
      <div className="flex justify-end">
        <ModuleHistoryButton token={token} module="reading" />
      </div>
      {reading.status === "idle" && (
        <div className="text-center space-y-1 pb-2">
          <h1 className="text-2xl sm:text-3xl font-extrabold text-gray-800">
            Reading Coach
          </h1>
          <p className="text-gray-500">
            Upload a book your child is reading. We'll generate questions to check their comprehension.
          </p>
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 sm:p-6">
        <ReadingInput onSubmit={handleSubmit} disabled={working} />
      </div>

      {working && (
        <div className="bg-white/60 rounded-2xl border border-gray-100 px-5 py-3 flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-gray-600">
              {analyzing
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

      {(done || stopped) && reading.bookContext && (
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

      {(working || done || stopped) && reading.packets.length > 0 && (
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

      {(done || stopped) && reading.usage && (
        <p className="text-xs text-gray-500 text-center px-1">
          Batch usage: {formatUsage(reading.usage)}
        </p>
      )}

      {needsMore && (
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

      {error && (
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

      {(done || stopped) && (
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
  );
};
