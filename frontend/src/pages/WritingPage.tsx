import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useWritingSession } from "../hooks/useWritingSession";
import { useSessionHistory } from "../hooks/useSessionHistory";
import { ModuleHistoryButton } from "../components/ModuleHistoryButton";
import { ModelChoiceControl } from "../components/ModelChoiceControl";
import { ModelChoiceBadge } from "../components/ModelChoiceBadge";
import {
  ImageAttachmentField,
  guardFormDrop,
  type ImageAttachmentValue,
} from "../components/ImageAttachmentField";
import type { ModelChoice, SessionCardSummary, YearLevel } from "../types";

const MAX_CHARS = 4000;
const MAX_IMAGES = 5;

interface WritingPageProps {
  token: string;
}

export const WritingPage = ({ token }: WritingPageProps) => {
  const navigate = useNavigate();
  const { status, sessionId, error, start } = useWritingSession();
  const { sessions } = useSessionHistory(token, "writing");

  const [promptText, setPromptText] = useState("");
  const [yearLevel, setYearLevel] = useState<YearLevel | "">("");
  const [modelChoice, setModelChoice] = useState<ModelChoice>("fast");
  const [attachments, setAttachments] = useState<ImageAttachmentValue[]>([]);
  const [isCompressing, setIsCompressing] = useState(false);

  const activeSessions: SessionCardSummary[] = sessions.filter(
    (s) => s.sessionType === "writing" && s.status === "active",
  );

  // When the start request returns a sessionId, navigate into the session view.
  useEffect(() => {
    if (status === "ready" && sessionId) {
      navigate(`/writing/${sessionId}`);
    }
  }, [status, sessionId, navigate]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = promptText.trim();
    if (!trimmed && attachments.length === 0) return;
    if (status === "starting") return;
    const images = attachments.map((a) => a.dataUrl);
    void start(
      { text: trimmed, images: images.length ? images : undefined },
      token,
      yearLevel || undefined,
      modelChoice,
    );
  };

  const isWorking = status === "starting";

  return (
    <main className="max-w-2xl mx-auto px-4 py-6 sm:py-10 space-y-8">
      <div className="flex justify-end">
        <ModuleHistoryButton token={token} module="writing" />
      </div>
      <header className="space-y-1">
        <p className="text-xs font-bold uppercase tracking-widest text-violet-500">
          New writing assignment
        </p>
        <h1 className="text-2xl font-bold text-gray-800">
          Coach your child through a writing task
        </h1>
        <p className="text-sm text-gray-500">
          Paste or photograph the assignment. You'll get a plan to coach with —
          then submit drafts for feedback.
        </p>
      </header>

      <form
        onSubmit={handleSubmit}
        onDragOver={guardFormDrop}
        onDrop={guardFormDrop}
        className="space-y-3"
      >
        <div className="relative">
          <textarea
            value={promptText}
            onChange={(e) => setPromptText(e.target.value.slice(0, MAX_CHARS))}
            rows={6}
            placeholder="Paste the writing prompt here, or attach a photo of the assignment sheet…"
            disabled={isWorking}
            className="w-full rounded-2xl border-2 border-gray-200 focus:border-violet-400 focus:outline-none px-4 py-3 text-gray-800 placeholder-gray-400 resize-none transition-colors disabled:opacity-50 text-base leading-relaxed"
          />
          <span
            className={`absolute bottom-3 right-4 text-xs ${
              MAX_CHARS - promptText.length < 200
                ? "text-orange-400"
                : "text-gray-300"
            }`}
          >
            {MAX_CHARS - promptText.length}
          </span>
        </div>

        <ImageAttachmentField
          attachments={attachments}
          onChange={setAttachments}
          maxAttachments={MAX_IMAGES}
          disabled={isWorking}
          accent="violet"
          prompt="Drag and drop a photo of the assignment"
          hint={`or click to choose files (up to ${MAX_IMAGES})`}
          getPreviewLabel={(index, total) => (total > 1 ? `p${index + 1}` : undefined)}
          onProcessingChange={setIsCompressing}
        />

        <div className="flex items-center gap-3">
          <label
            htmlFor="writing-year-level"
            className="text-sm font-semibold text-gray-700 shrink-0"
          >
            Year level
          </label>
          <select
            id="writing-year-level"
            value={yearLevel}
            onChange={(e) => setYearLevel(e.target.value as YearLevel | "")}
            disabled={isWorking}
            className="flex-1 rounded-xl border-2 border-gray-200 focus:border-violet-400 focus:outline-none px-3 py-2 text-sm text-gray-800 bg-white transition-colors disabled:opacity-50"
          >
            <option value="">Let AI infer (default)</option>
            <option value="year-1">Year 1</option>
            <option value="year-2">Year 2</option>
            <option value="year-3">Year 3</option>
            <option value="year-4">Year 4</option>
            <option value="year-5">Year 5</option>
            <option value="year-6">Year 6</option>
          </select>
        </div>

        <ModelChoiceControl
          value={modelChoice}
          onChange={setModelChoice}
          disabled={isWorking}
        />

        <button
          type="submit"
          disabled={
            isWorking ||
            isCompressing ||
            (!promptText.trim() && attachments.length === 0)
          }
          className="w-full py-3 rounded-2xl bg-gradient-to-r from-violet-500 to-indigo-500 text-white font-bold text-lg shadow-md hover:shadow-lg hover:from-violet-600 hover:to-indigo-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isWorking ? "Building plan…" : "Build the writing plan ✨"}
        </button>

        {error && (
          <p className="text-sm text-red-500 text-center">{error}</p>
        )}
      </form>

      {activeSessions.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400">
            In progress
          </h2>
          <div className="space-y-2">
            {activeSessions.map((s) => (
              <button
                key={s.sessionId}
                onClick={() => navigate(`/writing/${s.sessionId}`)}
                className="w-full text-left p-4 rounded-2xl bg-white border border-violet-100 shadow-sm hover:border-violet-300 hover:shadow transition-all"
              >
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-violet-50 text-violet-700">
                    ✍️ Writing
                  </span>
                  <ModelChoiceBadge choice={s.modelChoice} />
                </div>
                <p className="text-sm text-gray-700 line-clamp-2">
                  {s.assignmentSummary ?? s.prompt?.input ?? ""}
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  {(s.draftCount ?? 0)} drafts · {(s.questionCount ?? 0)} questions
                  · Resume →
                </p>
              </button>
            ))}
          </div>
        </section>
      )}
    </main>
  );
};
