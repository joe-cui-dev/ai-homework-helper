import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { compressImage } from "../services/api";
import { useWritingSession } from "../hooks/useWritingSession";
import { useSessionHistory } from "../hooks/useSessionHistory";
import type { SessionSummary } from "../types";

const MAX_CHARS = 4000;
const MAX_IMAGES = 5;

interface WritingPageProps {
  token: string;
}

export const WritingPage = ({ token }: WritingPageProps) => {
  const navigate = useNavigate();
  const { status, batchId, error, start } = useWritingSession();
  const { sessions } = useSessionHistory(token);

  const [promptText, setPromptText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [isCompressing, setIsCompressing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const activeSessions: SessionSummary[] = sessions.filter(
    (s) => s.sessionType === "writing" && s.status === "active",
  );

  // When the start request returns a batchId, navigate into the session view.
  useEffect(() => {
    if (status === "ready" && batchId) {
      navigate(`/writing/${batchId}`);
    }
  }, [status, batchId, navigate]);

  const handleImageChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    setImageError(null);
    const remaining = MAX_IMAGES - images.length;
    const slice = files.slice(0, remaining);
    if (files.length > remaining) {
      setImageError(`You can attach at most ${MAX_IMAGES} images.`);
    }
    setIsCompressing(true);
    const results = await Promise.allSettled(slice.map(compressImage));
    setIsCompressing(false);
    const successful: string[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") successful.push(r.value);
      else
        setImageError(
          r.reason instanceof Error ? r.reason.message : "Invalid image.",
        );
    }
    if (successful.length > 0) setImages((prev) => [...prev, ...successful]);
    e.target.value = "";
  };

  const removeImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
    setImageError(null);
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = promptText.trim();
    if (!trimmed && images.length === 0) return;
    if (status === "starting") return;
    void start({ text: trimmed, images: images.length ? images : undefined }, token);
  };

  const isWorking = status === "starting";

  return (
    <main className="max-w-2xl mx-auto px-4 py-6 sm:py-10 space-y-8">
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

      <form onSubmit={handleSubmit} className="space-y-3">
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

        <div className="flex items-start gap-3 flex-wrap">
          {images.length < MAX_IMAGES && !isCompressing && (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={isWorking}
              className="flex items-center gap-2 px-4 py-2 rounded-xl border-2 border-dashed border-gray-300 text-gray-500 hover:border-violet-400 hover:text-violet-600 transition-colors text-sm font-semibold disabled:opacity-40 shrink-0"
            >
              📎 {images.length === 0 ? "Add a photo" : "Add another"}
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={handleImageChange}
          />
          {images.map((src, i) => (
            <div key={i} className="relative inline-block">
              <img
                src={src}
                alt={`Prompt page ${i + 1}`}
                className="w-16 h-16 rounded-xl object-cover border-2 border-violet-200"
              />
              <button
                type="button"
                onClick={() => removeImage(i)}
                className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-red-400 text-white text-xs flex items-center justify-center hover:bg-red-500"
                aria-label={`Remove image ${i + 1}`}
              >
                ×
              </button>
            </div>
          ))}
          {isCompressing && (
            <p className="text-gray-400 text-sm self-center animate-pulse">
              Compressing…
            </p>
          )}
          {imageError && (
            <p className="text-red-500 text-sm self-center">{imageError}</p>
          )}
        </div>

        <button
          type="submit"
          disabled={
            isWorking ||
            isCompressing ||
            (!promptText.trim() && images.length === 0)
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
                  {s.plan?.genre && (
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 capitalize">
                      {s.plan.genre.replace(/_/g, " ")}
                    </span>
                  )}
                  {s.plan?.yearLevel && (
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">
                      {s.plan.yearLevel.replace("year-", "Year ")}
                    </span>
                  )}
                </div>
                <p className="text-sm text-gray-700 line-clamp-2">
                  {s.plan?.assignmentSummary ?? s.prompt?.input ?? ""}
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
