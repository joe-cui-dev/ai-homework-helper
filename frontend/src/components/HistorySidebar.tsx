import { useState } from "react";
import type { SessionSummary } from "../types";
import { useSessionHistory } from "../hooks/useSessionHistory";
import { subjectColour } from "../utils/subjectColour";
import { SessionDetailModal } from "./SessionDetailModal";

interface HistorySidebarProps {
  token: string;
  open: boolean;
  onClose: () => void;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function SessionCard({ session, onClick }: { session: SessionSummary; onClick: () => void }) {
  const extraCount = session.questions.length - 1;

  return (
    <button
      onClick={onClick}
      className="w-full text-left p-3 rounded-xl bg-white border border-gray-100 space-y-2 hover:border-brand-200 hover:shadow-sm transition-all"
    >
      <div className="flex items-center gap-2 flex-wrap">
        {session.subjects.map((subject) => (
          <span
            key={subject}
            className={`text-xs font-semibold px-2 py-0.5 rounded-full capitalize ${subjectColour(subject)}`}
          >
            {subject}
          </span>
        ))}
        <span className="text-xs text-gray-400">{formatDate(session.timestamp)}</span>
      </div>

      <p className="text-sm text-gray-700 line-clamp-2">{session.questions[0]?.input}</p>

      {extraCount > 0 && (
        <span className="inline-block text-xs font-semibold text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
          +{extraCount} more
        </span>
      )}

      {session.imageUrls.length > 0 && (
        <div className="flex gap-1.5 flex-wrap">
          {session.imageUrls.map((url, i) => (
            <img
              key={i}
              src={url}
              alt={`Upload ${i + 1}`}
              className="w-14 h-14 object-cover rounded-lg border border-gray-200"
            />
          ))}
        </div>
      )}
    </button>
  );
}

function SkeletonCard() {
  return (
    <div className="p-3 rounded-xl bg-white border border-gray-100 space-y-2 animate-pulse">
      <div className="flex gap-2">
        <div className="h-5 w-16 bg-gray-200 rounded-full" />
        <div className="h-5 w-20 bg-gray-100 rounded-full" />
      </div>
      <div className="h-4 w-full bg-gray-200 rounded" />
      <div className="h-4 w-3/4 bg-gray-100 rounded" />
    </div>
  );
}

export function HistorySidebar({ token, open, onClose }: HistorySidebarProps) {
  const { sessions, loading, loadingMore, error, nextCursor, loadMore } =
    useSessionHistory(token);
  const [selectedSession, setSelectedSession] = useState<SessionSummary | null>(null);

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 bg-black/30 z-20 md:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed top-0 left-0 h-full w-full md:w-72 bg-gray-50 border-r border-gray-200 z-30 flex flex-col transition-transform duration-300 ease-in-out ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        aria-label="Session history"
      >
        <div className="flex items-center justify-between px-4 py-3 bg-white/80 backdrop-blur-sm border-b border-gray-100 shrink-0">
          <span className="font-bold text-gray-700">History</span>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
            aria-label="Close history"
          >
            <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path
                fillRule="evenodd"
                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {loading && (
            <>
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
            </>
          )}

          {error && (
            <p className="text-sm text-red-500 text-center py-4">{error}</p>
          )}

          {!loading && !error && sessions.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-8">
              No history yet — submit a question to get started!
            </p>
          )}

          {sessions.map((s) => (
            <SessionCard key={s.sessionId} session={s} onClick={() => setSelectedSession(s)} />
          ))}

          {nextCursor && (
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="w-full py-2 text-sm font-semibold text-brand-600 hover:text-brand-700 hover:bg-brand-50 rounded-xl transition-colors disabled:opacity-50"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
        </div>
      </aside>

      {selectedSession && (
        <SessionDetailModal
          session={selectedSession}
          onClose={() => setSelectedSession(null)}
        />
      )}
    </>
  );
}
