import { useEffect, useRef, useState } from "react";
import { usePracticeSession } from "../hooks/usePracticeSession";
import type { CoachingPacket } from "../types";

const TOOL_LABEL: Record<string, string> = {
  generate_problem: "Generating problem",
  evaluate_attempt: "Evaluating attempt",
  give_hint: "Preparing a hint",
  worked_example: "Showing a worked example",
  change_teaching_style: "Switching teaching style",
  lookup_prerequisite_skill: "Identifying prerequisite",
  end_turn: "Wrapping up turn",
};

interface PracticeModalProps {
  batchId: string;
  questionId: number;
  questionText: string;
  packet: CoachingPacket;
  token: string;
  onClose: () => void;
}

export function PracticeModal({
  batchId,
  questionId,
  questionText,
  packet,
  token,
  onClose,
}: PracticeModalProps) {
  const {
    status,
    transcript,
    toolEvents,
    finalSummary,
    error,
    start,
    submit,
    end,
    reset,
  } = usePracticeSession();

  const [parentInput, setParentInput] = useState("");
  const [contextOpen, setContextOpen] = useState(false);
  const startedRef = useRef(false);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  // Kick off the session exactly once when the modal mounts.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void start(batchId, questionId, token);
  }, [batchId, questionId, token, start]);

  // Reset hook state when the modal unmounts to free the abort controller.
  useEffect(() => {
    return () => reset();
  }, [reset]);

  // Scroll new entries into view.
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript, toolEvents]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = parentInput.trim();
    if (!text || status === "submitting" || status === "starting") return;
    setParentInput("");
    void submit(text, token);
  };

  const handleEnd = () => {
    if (status === "submitting" || status === "starting") return;
    void end(token);
  };

  const isWorking = status === "starting" || status === "submitting";
  const isEnded = status === "ended";

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch sm:items-center sm:justify-center bg-black/50 sm:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative w-full sm:max-w-2xl bg-white sm:rounded-2xl shadow-xl flex flex-col h-full sm:max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-bold uppercase tracking-widest text-gray-400">
              Practice
            </p>
            <p className="text-sm text-gray-700 truncate">{questionText}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors shrink-0"
            aria-label="Close practice"
          >
            <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>

        {/* Collapsible source CoachingPacket header */}
        <button
          onClick={() => setContextOpen((v) => !v)}
          className="flex items-center justify-between px-4 py-2 text-xs font-semibold text-brand-600 hover:bg-brand-50 transition-colors shrink-0"
        >
          <span>{contextOpen ? "Hide source coaching packet" : "Show source coaching packet"}</span>
          <svg
            className={`w-4 h-4 transition-transform ${contextOpen ? "rotate-180" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {contextOpen && (
          <div className="px-4 pb-3 text-xs text-gray-600 space-y-2 border-b border-gray-100 shrink-0">
            <p><span className="font-semibold">Concept:</span> {packet.whyItWorks}</p>
            <p><span className="font-semibold">Watch for:</span> {packet.watchFor.join("; ")}</p>
          </div>
        )}

        {/* Transcript */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {transcript.length === 0 && status === "starting" && (
            <p className="text-sm text-gray-400 italic">Setting up the first problem…</p>
          )}

          {transcript.map((entry, i) =>
            entry.role === "agent" ? (
              <div key={i} className="space-y-2">
                <div className="bg-blue-50 border border-blue-100 rounded-2xl px-4 py-3 space-y-2">
                  <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-line">
                    {entry.agentMessage}
                  </p>
                  {entry.problem && (
                    <div className="bg-white rounded-xl border border-blue-200 px-3 py-2">
                      <p className="text-xs font-bold uppercase tracking-wide text-blue-500 mb-1">
                        Read aloud
                      </p>
                      <p className="text-base text-gray-800 leading-relaxed whitespace-pre-line">
                        {entry.problem}
                      </p>
                    </div>
                  )}
                  {entry.isSessionEnded && entry.endedReason && (
                    <span className="inline-block text-xs font-semibold px-2 py-0.5 rounded-full bg-white border border-blue-200 text-blue-700 capitalize">
                      Session ended · {entry.endedReason}
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <div key={i} className="flex justify-end">
                <p className="bg-gray-100 text-gray-800 text-sm rounded-2xl px-4 py-2 max-w-[80%] whitespace-pre-line">
                  {entry.message}
                </p>
              </div>
            ),
          )}

          {/* Live tool indicators while a turn is running */}
          {isWorking && toolEvents.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {toolEvents.map((e, i) => (
                <span
                  key={i}
                  className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold transition-all ${
                    e.done
                      ? "bg-green-100 text-green-700"
                      : "bg-brand-100 text-brand-700 animate-pulse"
                  }`}
                >
                  {TOOL_LABEL[e.tool] ?? e.tool}
                </span>
              ))}
            </div>
          )}

          {isWorking && toolEvents.length === 0 && (
            <p className="text-sm text-gray-400 italic animate-pulse">Thinking…</p>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-3">
              <p className="text-sm text-red-600 font-semibold">Something went wrong</p>
              <p className="text-xs text-red-500 mt-1">{error}</p>
            </div>
          )}

          {isEnded && finalSummary && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
              <p className="text-xs font-bold uppercase tracking-wide text-amber-600 mb-1">
                Session recap
              </p>
              <p className="text-sm text-amber-800 leading-relaxed">{finalSummary}</p>
            </div>
          )}

          <div ref={transcriptEndRef} />
        </div>

        {/* Footer: parent input + end button */}
        <form
          onSubmit={handleSubmit}
          className="border-t border-gray-100 p-3 space-y-2 shrink-0"
        >
          {!isEnded && (
            <>
              <textarea
                value={parentInput}
                onChange={(e) => setParentInput(e.target.value)}
                placeholder="Tell the agent what your child said or did…"
                rows={2}
                disabled={isWorking || status === "error"}
                className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-brand-400 focus:outline-none disabled:bg-gray-50"
              />
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={handleEnd}
                  disabled={isWorking}
                  className="px-3 py-1.5 rounded-xl text-sm font-semibold text-red-500 hover:bg-red-50 disabled:opacity-40 transition-colors"
                >
                  End practice
                </button>
                <button
                  type="submit"
                  disabled={!parentInput.trim() || isWorking || status === "error"}
                  className="px-4 py-1.5 rounded-xl text-sm font-bold bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-40 transition-colors"
                >
                  Send
                </button>
              </div>
            </>
          )}
          {isEnded && (
            <button
              type="button"
              onClick={onClose}
              className="w-full px-4 py-2 rounded-xl text-sm font-bold bg-brand-600 text-white hover:bg-brand-700 transition-colors"
            >
              Close
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
