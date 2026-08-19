import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { MAX_DRAFTS, MAX_QUESTIONS, useWritingSession } from "../hooks/useWritingSession";
import { useSessionHistory } from "../hooks/useSessionHistory";
import { WritingPlanCard } from "../components/WritingPlanCard";
import { DraftFeedbackCard } from "../components/DraftFeedbackCard";
import { CoachingNoteCard } from "../components/CoachingNoteCard";
import { ModelChoiceBadge } from "../components/ModelChoiceBadge";
import {
  ImageAttachmentField,
  guardFormDrop,
  type ImageAttachmentValue,
} from "../components/ImageAttachmentField";
import { formatUsageCompact } from "../utils/formatUsage";

const MAX_DRAFT_CHARS = 4000;
const MAX_QUESTION_CHARS = 600;
const MAX_DRAFT_IMAGES = 5;

interface WritingSessionPageProps {
  token: string;
}

export const WritingSessionPage = ({ token }: WritingSessionPageProps) => {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const writing = useWritingSession();
  const { sessions, loading } = useSessionHistory(token, "writing");

  const hydratedRef = useRef(false);

  // Hydrate from history when arriving cold (e.g. resume from sidebar). If
  // the hook already has state for this sessionId (just-submitted prompt
  // redirect), skip hydration.
  useEffect(() => {
    if (!sessionId || hydratedRef.current) return;
    if (writing.sessionId === sessionId && writing.plan) {
      hydratedRef.current = true;
      return;
    }
    const session = sessions.find((s) => s.sessionId === sessionId);
    if (!session || session.sessionType !== "writing" || !session.plan) return;
    hydratedRef.current = true;
    writing.hydrate({
      sessionId,
      plan: session.plan,
      turns: session.turns ?? [],
      draftCount: session.draftCount ?? 0,
      questionCount: session.questionCount ?? 0,
      usage: session.usage,
      modelChoice: session.modelChoice,
      status: session.status ?? "active",
      endedReason: session.endedReason,
      imageUrls: session.imageUrls.filter((url): url is string => url !== null),
    });
  }, [sessionId, sessions, writing]);

  const isLoadingResume =
    !writing.plan && !hydratedRef.current && (loading || sessions.length === 0);

  if (!sessionId) {
    return (
      <main className="max-w-2xl mx-auto px-4 py-16 text-center space-y-4">
        <p className="text-gray-600">Invalid writing session link.</p>
        <button
          onClick={() => navigate("/writing")}
          className="px-5 py-2 rounded-xl bg-violet-600 text-white font-semibold hover:bg-violet-700 transition-colors"
        >
          Back to Writing
        </button>
      </main>
    );
  }

  if (isLoadingResume) {
    return (
      <main className="max-w-2xl mx-auto px-4 py-16 text-center">
        <p className="text-gray-400 animate-pulse">Loading writing session…</p>
      </main>
    );
  }

  if (!writing.plan) {
    return (
      <main className="max-w-2xl mx-auto px-4 py-16 text-center space-y-4">
        <p className="text-gray-600">
          Couldn't find that writing session.
        </p>
        <button
          onClick={() => navigate("/writing")}
          className="px-5 py-2 rounded-xl bg-violet-600 text-white font-semibold hover:bg-violet-700 transition-colors"
        >
          Back to Writing
        </button>
      </main>
    );
  }

  return (
    <main className="max-w-2xl mx-auto px-3 sm:px-4 py-5 sm:py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => navigate("/writing")}
          className="flex items-center gap-1.5 text-sm font-semibold text-violet-600 hover:text-violet-800"
        >
          ←  Back
        </button>
        <div className="text-right">
          <div className="flex items-center justify-end gap-2">
            <ModelChoiceBadge choice={writing.modelChoice} />
            <p className="text-xs font-bold uppercase tracking-widest text-gray-400">
              Writing
            </p>
          </div>
          <p className="text-[11px] text-gray-400">
            {writing.draftCount}/{MAX_DRAFTS} drafts ·{" "}
            {writing.questionCount}/{MAX_QUESTIONS} questions
            {writing.usage && ` · ${formatUsageCompact(writing.usage)}`}
          </p>
        </div>
      </div>

      {writing.imageUrls.length > 0 && (
        <div className="space-y-3">
          {writing.imageUrls.map((url, i) => (
            <img
              key={i}
              src={url}
              alt={`Assignment page ${i + 1}`}
              className="w-full rounded-xl border border-gray-200 object-contain bg-white"
            />
          ))}
        </div>
      )}

      <WritingPlanCard plan={writing.plan} />

      {/* Turn transcript */}
      {writing.turns.map((turn) => {
        if (turn.kind === "draft") {
          return (
            <DraftFeedbackCard
              key={turn.turnIndex}
              packet={turn.packet}
              imageUrls={turn.input.imageUrls}
              draftIndex={
                writing.turns
                  .slice(0, writing.turns.indexOf(turn) + 1)
                  .filter((t) => t.kind === "draft").length
              }
            />
          );
        }
        return (
          <CoachingNoteCard
            key={turn.turnIndex}
            packet={turn.packet}
            question={turn.input.text}
            questionIndex={
              writing.turns
                .slice(0, writing.turns.indexOf(turn) + 1)
                .filter((t) => t.kind === "question").length
            }
          />
        );
      })}

      {/* Working / error states */}
      {(writing.status === "submitting_draft" ||
        writing.status === "transcribing") && (
        <p className="text-center text-sm text-gray-400 italic animate-pulse">
          {writing.status === "transcribing"
            ? "Transcribing handwriting…"
            : "Reviewing the draft…"}
        </p>
      )}
      {writing.status === "submitting_question" && (
        <p className="text-center text-sm text-gray-400 italic animate-pulse">
          Coach is thinking…
        </p>
      )}
      {writing.error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-center">
          <p className="text-sm text-red-600">{writing.error}</p>
        </div>
      )}

      {writing.status === "ended" && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-4 text-center">
          <p className="text-sm font-semibold text-emerald-800">
            Session{" "}
            {writing.endedReason === "max_drafts"
              ? "ended (5-draft cap reached)"
              : writing.endedReason === "max_questions"
                ? "ended (3-question cap reached)"
                : writing.endedReason === "abandoned"
                  ? "expired"
                  : "completed"}
          </p>
          <button
            onClick={() => navigate("/writing")}
            className="mt-3 px-4 py-2 rounded-xl bg-violet-600 text-white text-sm font-bold hover:bg-violet-700"
          >
            Start a new writing session
          </button>
        </div>
      )}

      {writing.status !== "ended" && (
        <SubmissionPanel writing={writing} token={token} />
      )}
    </main>
  );
};

interface SubmissionPanelProps {
  writing: ReturnType<typeof useWritingSession>;
  token: string;
}

function SubmissionPanel({ writing, token }: SubmissionPanelProps) {
  const [tab, setTab] = useState<"draft" | "question">("draft");
  const draftCapped = writing.draftCount >= MAX_DRAFTS;
  const questionCapped = writing.questionCount >= MAX_QUESTIONS;

  // If draft is capped, default to question; if both, hide.
  useEffect(() => {
    if (draftCapped && !questionCapped) setTab("question");
    if (!draftCapped && questionCapped) setTab("draft");
  }, [draftCapped, questionCapped]);

  if (draftCapped && questionCapped) {
    return (
      <div className="text-center text-sm text-gray-500">
        You've used all drafts and questions for this assignment.
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="flex border-b border-gray-100">
        <TabButton
          active={tab === "draft"}
          disabled={draftCapped}
          onClick={() => setTab("draft")}
          label={`Submit draft (${MAX_DRAFTS - writing.draftCount} left)`}
        />
        <TabButton
          active={tab === "question"}
          disabled={questionCapped}
          onClick={() => setTab("question")}
          label={`Ask the coach (${MAX_QUESTIONS - writing.questionCount} left)`}
        />
      </div>

      <div className="p-4">
        {tab === "draft" ? (
          <DraftSubmitForm writing={writing} token={token} />
        ) : (
          <QuestionSubmitForm writing={writing} token={token} />
        )}
      </div>

      <div className="px-4 pb-4 flex justify-end">
        <button
          onClick={() => writing.end(token)}
          disabled={
            writing.status === "submitting_draft" ||
            writing.status === "submitting_question" ||
            writing.status === "transcribing" ||
            writing.status === "ending"
          }
          className="text-xs font-semibold text-red-500 hover:bg-red-50 px-3 py-1.5 rounded-lg disabled:opacity-40"
        >
          Finish session
        </button>
      </div>
    </div>
  );
}

function TabButton({
  active,
  disabled,
  onClick,
  label,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex-1 py-3 text-sm font-semibold transition-colors ${
        active
          ? "bg-violet-50 text-violet-700"
          : "text-gray-500 hover:text-violet-600"
      } disabled:opacity-30 disabled:cursor-not-allowed`}
    >
      {label}
    </button>
  );
}

function DraftSubmitForm({
  writing,
  token,
}: {
  writing: ReturnType<typeof useWritingSession>;
  token: string;
}) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<ImageAttachmentValue[]>([]);
  const [isCompressing, setIsCompressing] = useState(false);

  const isWorking =
    writing.status === "submitting_draft" || writing.status === "transcribing";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    if (isWorking) return;
    const images = attachments.map((a) => a.dataUrl);
    await writing.submitDraft(
      { text: trimmed || undefined, images: images.length ? images : undefined },
      token,
    );
    setText("");
    setAttachments([]);
  };

  return (
    <form
      onSubmit={submit}
      onDragOver={guardFormDrop}
      onDrop={guardFormDrop}
      className="space-y-3"
    >
      <div className="relative">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, MAX_DRAFT_CHARS))}
          rows={6}
          placeholder="Paste your child's draft here, or attach a photo of the handwritten page…"
          disabled={isWorking}
          className="w-full rounded-xl border-2 border-gray-200 focus:border-violet-400 focus:outline-none px-3 py-2 text-sm text-gray-800 placeholder-gray-400 resize-none disabled:opacity-50"
        />
        <span className="absolute bottom-2 right-3 text-xs text-gray-300">
          {MAX_DRAFT_CHARS - text.length}
        </span>
      </div>

      <ImageAttachmentField
        attachments={attachments}
        onChange={setAttachments}
        maxAttachments={MAX_DRAFT_IMAGES}
        disabled={isWorking}
        accent="violet"
        prompt="Drag and drop a photo of the handwriting"
        hint="or click to choose files"
        compact
        onProcessingChange={setIsCompressing}
      />

      <button
        type="submit"
        disabled={
          isWorking ||
          isCompressing ||
          (!text.trim() && attachments.length === 0)
        }
        className="w-full py-2.5 rounded-xl bg-violet-600 text-white font-bold text-sm hover:bg-violet-700 disabled:opacity-50"
      >
        {isWorking ? "Reviewing…" : "Submit draft for feedback"}
      </button>
    </form>
  );
}

function QuestionSubmitForm({
  writing,
  token,
}: {
  writing: ReturnType<typeof useWritingSession>;
  token: string;
}) {
  const [text, setText] = useState("");
  const isWorking = writing.status === "submitting_question";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || isWorking) return;
    await writing.submitQuestion(trimmed, token);
    setText("");
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="relative">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, MAX_QUESTION_CHARS))}
          rows={3}
          placeholder="What would you like the coach to clarify? (Won't write content for the child.)"
          disabled={isWorking}
          className="w-full rounded-xl border-2 border-gray-200 focus:border-sky-400 focus:outline-none px-3 py-2 text-sm text-gray-800 placeholder-gray-400 resize-none disabled:opacity-50"
        />
        <span className="absolute bottom-2 right-3 text-xs text-gray-300">
          {MAX_QUESTION_CHARS - text.length}
        </span>
      </div>
      <button
        type="submit"
        disabled={isWorking || !text.trim()}
        className="w-full py-2.5 rounded-xl bg-sky-600 text-white font-bold text-sm hover:bg-sky-700 disabled:opacity-50"
      >
        {isWorking ? "Asking…" : "Ask the coach"}
      </button>
    </form>
  );
}
