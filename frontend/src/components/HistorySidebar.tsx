import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { SessionCardSummary, SessionSummary } from "../types";
import { useSessionHistory } from "../hooks/useSessionHistory";
import { fetchSessionDetail, type HistoryModule } from "../services/api";
import { subjectColour } from "../utils/subjectColour";
import { SessionDetailModal } from "./SessionDetailModal";
import { ModelChoiceBadge } from "./ModelChoiceBadge";

interface HistorySidebarProps {
  token: string;
  module: HistoryModule;
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

const WRITING_ENDED_LABEL: Record<string, { text: string; chip: string }> = {
  completed: { text: "Completed", chip: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  abandoned: { text: "Expired", chip: "bg-gray-100 text-gray-500 border-gray-200" },
  max_drafts: { text: "Limit reached", chip: "bg-amber-50 text-amber-700 border-amber-200" },
  max_questions: { text: "Limit reached", chip: "bg-amber-50 text-amber-700 border-amber-200" },
};

interface SessionCardProps {
  session: SessionCardSummary;
  onClick: () => void;
  onResume?: () => void;
}

function SessionCard({ session, onClick, onResume }: SessionCardProps) {
  const isReading = session.sessionType === "reading";
  const isWriting = session.sessionType === "writing";

  let previewText = "";
  let extraText: string | null = null;
  if (isWriting) {
    previewText =
      session.assignmentSummary ?? session.prompt?.input ?? "Writing session";
    extraText = `${session.draftCount ?? 0} drafts · ${session.questionCount ?? 0} questions`;
  } else if (isReading) {
    previewText =
      session.bookContext?.title ?? session.questionPreview ?? "Reading session";
    if (session.questionCount > 0) extraText = `${session.questionCount} questions`;
  } else {
    previewText = session.questionPreview ?? "";
    const extraCount = Math.max(0, session.questionCount - 1);
    if (extraCount > 0) extraText = `+${extraCount} more`;
  }

  const isActiveWriting = isWriting && session.status === "active";
  const writingEndedChip =
    isWriting && session.status === "ended" && session.endedReason
      ? WRITING_ENDED_LABEL[session.endedReason]
      : null;

  return (
    <button
      onClick={isActiveWriting ? onResume : onClick}
      className={`w-full text-left p-3 rounded-xl bg-white border space-y-2 hover:shadow-sm transition-all ${
        isActiveWriting
          ? "border-violet-200 border-l-4 hover:border-violet-400"
          : "border-gray-100 hover:border-brand-200"
      }`}
    >
      <div className="flex items-center gap-2 flex-wrap">
        {/* Subject badges are still informative within Homework (math/english/science).
            Module-level badges are dropped — the sidebar is now single-module. */}
        {!isWriting && !isReading &&
          session.subjects.map((subject) => (
            <span
              key={subject}
              className={`text-xs font-semibold px-2 py-0.5 rounded-full capitalize ${subjectColour(subject)}`}
            >
              {subject}
            </span>
          ))}
        {isActiveWriting && (
          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-violet-100 text-violet-800">
            In progress
          </span>
        )}
        {writingEndedChip && (
          <span
            className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${writingEndedChip.chip}`}
          >
            {writingEndedChip.text}
          </span>
        )}
        <ModelChoiceBadge choice={session.modelChoice} />
        <span className="text-xs text-gray-400">{formatDate(session.updatedAt ?? session.timestamp)}</span>
      </div>

      <p className="text-sm text-gray-700 line-clamp-2">{previewText}</p>

      {extraText && (
        <span className="inline-block text-xs font-semibold text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
          {extraText}
        </span>
      )}

      {isActiveWriting && (
        <p className="text-xs font-semibold text-violet-600">Resume →</p>
      )}

      {session.imageUrls.length > 0 && (
        <div className="flex gap-1.5 flex-wrap">
          {session.imageUrls.slice(0, 1).map((url, i) => url ? (
            <img key={i} src={url} alt="Upload 1" className="w-14 h-14 object-cover rounded-lg border border-gray-200" />
          ) : (
            <div key={i} role="img" aria-label="Upload 1 unavailable" className="w-14 h-14 rounded-lg border border-dashed border-gray-300 bg-gray-50 text-[10px] text-gray-400 flex items-center justify-center text-center">Unavailable</div>
          ))}
          <span className="self-end text-xs text-gray-400">{session.imageCount} {session.imageCount === 1 ? "image" : "images"}</span>
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

export function HistorySidebar({ token, module, open, onClose }: HistorySidebarProps) {
  const { sessions, loading, loadingMore, error, nextCursor, loadMore, removeSession } =
    useSessionHistory(token, module);
  const navigate = useNavigate();
  const [selectedSession, setSelectedSession] = useState<SessionSummary | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailRequestRef = useRef(0);

  const selectSession = async (session: SessionCardSummary) => {
    const requestId = ++detailRequestRef.current;
    setSelectedSessionId(session.sessionId);
    setSelectedSession(null);
    setDetailError(null);
    try {
      const detail = await fetchSessionDetail(token, module, session.sessionId);
      if (detailRequestRef.current === requestId) setSelectedSession(detail);
    } catch (error) {
      if (detailRequestRef.current !== requestId) return;
      if ((error as Error & { status?: number }).status === 404) {
        removeSession(session.sessionId);
      }
      setDetailError(error instanceof Error ? error.message : "Session unavailable.");
    }
  };

  const closeDetail = () => {
    detailRequestRef.current += 1;
    setSelectedSessionId(null);
    setSelectedSession(null);
    setDetailError(null);
  };

  // Pin active writing sessions to the top.
  const activeWriting = sessions.filter(
    (s) => s.sessionType === "writing" && s.status === "active",
  );
  const otherSessions = sessions.filter(
    (s) => !(s.sessionType === "writing" && s.status === "active"),
  );

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
          <span className="font-bold text-gray-700 capitalize">{module} history</span>
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

          {activeWriting.length > 0 && (
            <>
              {activeWriting.map((s) => (
                <SessionCard
                  key={s.sessionId}
                  session={s}
                  onClick={() => { void selectSession(s); }}
                  onResume={() => {
                    onClose();
                    navigate(`/writing/${s.sessionId}`);
                  }}
                />
              ))}
              <div className="border-b border-gray-200 my-2" />
            </>
          )}
          {otherSessions.map((s) => (
            <SessionCard
              key={s.sessionId}
              session={s}
              onClick={() => { void selectSession(s); }}
              onResume={() => {
                onClose();
                navigate(`/writing/${s.sessionId}`);
              }}
            />
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
          token={token}
          onClose={closeDetail}
        />
      )}
      {selectedSessionId && !selectedSession && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-label="Session detail">
          <div className="bg-white rounded-2xl shadow-xl p-6 text-sm text-gray-600">
            {detailError ?? "Loading latest session…"}
            {detailError && <button className="block mt-4 text-brand-600 font-semibold" onClick={closeDetail}>Close</button>}
          </div>
        </div>
      )}
    </>
  );
}
