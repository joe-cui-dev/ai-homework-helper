import { useEffect } from "react";
import type { SessionSummary } from "../types";
import { ResultCard } from "./ResultCard";
import { ReadingPacketCard } from "./ReadingPacketCard";
import { WritingPlanCard } from "./WritingPlanCard";
import { DraftFeedbackCard } from "./DraftFeedbackCard";
import { CoachingNoteCard } from "./CoachingNoteCard";
import { subjectColour } from "../utils/subjectColour";
import { formatUsageCompact } from "../utils/formatUsage";
import { useNavigate } from "react-router-dom";
import { ModelChoiceBadge } from "./ModelChoiceBadge";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

interface SessionDetailModalProps {
  session: SessionSummary;
  token: string;
  onClose: () => void;
}

export function SessionDetailModal({ session, token: _token, onClose }: SessionDetailModalProps) {
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 overflow-y-auto"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative w-full max-w-2xl bg-gray-50 rounded-2xl shadow-xl my-6">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 bg-white/80 backdrop-blur-sm rounded-t-2xl border-b border-gray-100">
          <div className="flex items-center gap-2 flex-wrap">
            {session.subjects.map((subject) => (
              <span
                key={subject}
                className={`text-xs font-semibold px-2 py-0.5 rounded-full capitalize ${subjectColour(subject)}`}
              >
                {subject}
              </span>
            ))}
            <ModelChoiceBadge choice={session.modelChoice} />
            <span className="text-xs text-gray-400">{formatDate(session.updatedAt ?? session.timestamp)}</span>
            {session.usage && (
              <span className="text-xs text-gray-400">
                · {formatUsageCompact(session.usage)}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
            aria-label="Close"
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

        <div className="p-5 space-y-4">
          {/* Reading-session book context */}
          {session.sessionType === "reading" && session.bookContext && (
            <div className="bg-white rounded-xl border border-gray-100 px-4 py-3 text-sm text-gray-700">
              <span className="font-semibold">
                {session.bookContext.title ?? "This book"}
              </span>
              {session.bookContext.author && (
                <span className="text-gray-500"> — {session.bookContext.author}</span>
              )}
            </div>
          )}

          {/* Full-size uploaded images — shared across all questions */}
          {session.imageUrls.length > 0 && (
            <div className="space-y-3">
              {session.imageUrls.map((url, i) => url ? (
                <img key={i} src={url} alt={`Upload ${i + 1}`} className="w-full rounded-xl border border-gray-200 object-contain bg-white" />
              ) : (
                <div key={i} role="img" aria-label={`Upload ${i + 1} unavailable`} className="w-full min-h-32 rounded-xl border border-dashed border-gray-300 bg-white text-sm text-gray-400 flex items-center justify-center">Image unavailable</div>
              ))}
            </div>
          )}

          {/* Writing session: render plan + transcript of all turns */}
          {session.sessionType === "writing" && session.plan ? (
            <div className="space-y-3">
              <WritingPlanCard plan={session.plan} />
              {(session.turns ?? []).map((turn) => {
                if (turn.kind === "draft") {
                  const draftIndex =
                    (session.turns ?? [])
                      .slice(0, (session.turns ?? []).indexOf(turn) + 1)
                      .filter((t) => t.kind === "draft").length;
                  return (
                    <DraftFeedbackCard
                      key={turn.turnIndex}
                      packet={turn.packet}
                      draftIndex={draftIndex}
                    />
                  );
                }
                const questionIndex =
                  (session.turns ?? [])
                    .slice(0, (session.turns ?? []).indexOf(turn) + 1)
                    .filter((t) => t.kind === "question").length;
                return (
                  <CoachingNoteCard
                    key={turn.turnIndex}
                    packet={turn.packet}
                    question={turn.input.text}
                    questionIndex={questionIndex}
                  />
                );
              })}
            </div>
          ) : session.sessionType === "reading" && session.readingPackets?.length ? (
            // Reading session: render ReadingPacket cards
            <div className="space-y-3">
              {session.readingPackets.map((packet, i) => (
                <ReadingPacketCard
                  key={packet.questionId}
                  packet={packet}
                  index={i}
                  total={session.readingPackets!.length}
                />
              ))}
            </div>
          ) : (
            // Homework session: existing per-question CoachingPacket cards.
            session.questions.map((q, i) => (
              <div key={i} className="space-y-2">
                {session.questions.length > 1 && (
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide px-1">
                    Question {i + 1}
                  </p>
                )}
                <div className="bg-white rounded-xl border border-gray-100 px-4 py-3">
                  <p className="text-sm text-gray-700 leading-relaxed">{q.input}</p>
                </div>
                <ResultCard
                  packet={q.packet}
                  subject={q.subject}
                  yearLevel={q.yearLevel}
                  onPractise={() => {
                    onClose();
                    navigate(`/practice/${session.sessionId}:${q.questionId}`);
                  }}
                  practiceStatus={q.practiceSession?.status}
                />
              </div>
            ))
          )}
        </div>
      </div>

    </div>
  );
}
