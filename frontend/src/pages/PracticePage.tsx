import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { usePracticeSession } from "../hooks/usePracticeSession";
import { formatUsageCompact } from "../utils/formatUsage";

const TOOL_LABEL: Record<string, string> = {
  generate_problem: "Generating problem",
  evaluate_attempt: "Evaluating attempt",
  give_hint: "Preparing a hint",
  worked_example: "Showing a worked example",
  change_teaching_style: "Switching teaching style",
  lookup_prerequisite_skill: "Identifying prerequisite",
  end_turn: "Wrapping up turn",
};

interface PracticePageProps {
  token: string;
}

export const PracticePage = ({ token }: PracticePageProps) => {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();

  const {
    status,
    transcript,
    toolEvents,
    sessionUsage,
    turnCount,
    finalSummary,
    error,
    start,
    submit,
    end,
    reset,
  } = usePracticeSession();

  const [parentInput, setParentInput] = useState("");
  const startedRef = useRef(false);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  // sessionId format: "{batchId}:{questionId}"
  const colon = sessionId?.indexOf(":") ?? -1;
  const batchId = colon > 0 ? sessionId!.slice(0, colon) : "";
  const questionId = colon > 0 ? parseInt(sessionId!.slice(colon + 1), 10) : NaN;

  useEffect(() => {
    if (startedRef.current || !batchId || Number.isNaN(questionId)) return;
    startedRef.current = true;
    void start(batchId, questionId, token);
  }, [batchId, questionId, token, start]);

  useEffect(() => {
    return () => reset();
  }, [reset]);

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

  if (!batchId || Number.isNaN(questionId)) {
    return (
      <main className="max-w-2xl mx-auto px-4 py-16 text-center space-y-4">
        <p className="text-gray-600">Invalid practice session link.</p>
        <button
          onClick={() => navigate("/homework")}
          className="px-5 py-2 rounded-xl bg-brand-600 text-white font-semibold hover:bg-brand-700 transition-colors"
        >
          Back to Homework
        </button>
      </main>
    );
  }

  return (
    <div className="min-h-[calc(100vh-56px)] flex flex-col max-w-2xl mx-auto px-3 sm:px-4 py-5 sm:py-8">
      {/* Back link + header */}
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1.5 text-sm font-semibold text-brand-600 hover:text-brand-800 transition-colors"
        >
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
          Back
        </button>
        <div className="text-right">
          <p className="text-xs font-bold uppercase tracking-widest text-gray-400">Practice</p>
          {sessionUsage && (
            <p className="text-[11px] text-gray-400">
              {turnCount} turn{turnCount === 1 ? "" : "s"} · {formatUsageCompact(sessionUsage)}
            </p>
          )}
        </div>
      </div>

      {/* Transcript */}
      <div className="flex-1 bg-white rounded-2xl shadow-sm border border-gray-100 flex flex-col overflow-hidden">
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

        {/* Input footer */}
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
              onClick={() => navigate("/homework")}
              className="w-full px-4 py-2 rounded-xl text-sm font-bold bg-brand-600 text-white hover:bg-brand-700 transition-colors"
            >
              Back to Homework
            </button>
          )}
        </form>
      </div>
    </div>
  );
};
