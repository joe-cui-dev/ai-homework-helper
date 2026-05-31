import { useCallback, useRef, useState } from "react";
import {
  endWritingSession,
  startWriting,
  submitWritingDraft,
  submitWritingQuestion,
} from "../services/writingApi";
import { normalisePlan } from "../utils/normalizeWriting";
import type {
  TokenUsage,
  WritingEndedReason,
  WritingPlanPacket,
  WritingStreamEvent,
  WritingTurn,
  YearLevel,
} from "../types";

export const MAX_DRAFTS = 5;
export const MAX_QUESTIONS = 3;

type Status =
  | "idle"
  | "starting"
  | "ready"
  | "submitting_draft"
  | "submitting_question"
  | "transcribing"
  | "ending"
  | "ended"
  | "error";

interface UseWritingSessionReturn {
  status: Status;
  sessionId: string | null;
  plan: WritingPlanPacket | null;
  turns: WritingTurn[];
  draftCount: number;
  questionCount: number;
  usage: TokenUsage | null;
  endedReason: WritingEndedReason | null;
  error: string | null;
  imageUrls: string[];
  // Actions
  start: (
    prompt: { text: string; images?: string[] },
    token: string,
    yearLevel?: YearLevel,
  ) => Promise<void>;
  submitDraft: (
    draft: { text?: string; images?: string[] },
    token: string,
  ) => Promise<void>;
  submitQuestion: (question: string, token: string) => Promise<void>;
  end: (token: string) => Promise<void>;
  // Hydrate state from a persisted SessionRecord (resume flow).
  hydrate: (input: {
    sessionId: string;
    plan: WritingPlanPacket;
    turns: WritingTurn[];
    draftCount: number;
    questionCount: number;
    usage?: TokenUsage;
    status: "active" | "ended";
    endedReason?: WritingEndedReason;
    imageUrls?: string[];
  }) => void;
  reset: () => void;
}

export const useWritingSession = (): UseWritingSessionReturn => {
  const [status, setStatus] = useState<Status>("idle");
  const [sessionId, setBatchId] = useState<string | null>(null);
  const [plan, setPlan] = useState<WritingPlanPacket | null>(null);
  const [turns, setTurns] = useState<WritingTurn[]>([]);
  const [draftCount, setDraftCount] = useState(0);
  const [questionCount, setQuestionCount] = useState(0);
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const [endedReason, setEndedReason] = useState<WritingEndedReason | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const pendingDraftImagesRef = useRef<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setStatus("idle");
    setBatchId(null);
    setPlan(null);
    setTurns([]);
    setDraftCount(0);
    setQuestionCount(0);
    setUsage(null);
    setEndedReason(null);
    setError(null);
    setImageUrls([]);
  }, []);

  const hydrate = useCallback<UseWritingSessionReturn["hydrate"]>((input) => {
    setBatchId(input.sessionId);
    setPlan(normalisePlan(input.plan));
    setTurns(input.turns);
    setDraftCount(input.draftCount);
    setQuestionCount(input.questionCount);
    setUsage(input.usage ?? null);
    setEndedReason(input.endedReason ?? null);
    setStatus(input.status === "ended" ? "ended" : "ready");
    setError(null);
    setImageUrls(input.imageUrls ?? []);
  }, []);

  const handleEvent = useCallback(
    (
      event: WritingStreamEvent,
      kind: "start" | "draft" | "question" | "end",
    ) => {
      if (event.type === "plan_complete") {
        setBatchId(event.sessionId);
        setPlan(normalisePlan(event.plan));
        setUsage(event.usage);
        setStatus("ready");
      } else if (event.type === "transcribing") {
        setStatus("transcribing");
      } else if (event.type === "feedback_complete") {
        const submittedImages = pendingDraftImagesRef.current;
        pendingDraftImagesRef.current = [];
        setTurns((prev) => [
          ...prev,
          {
            kind: "draft",
            turnIndex: event.turnIndex,
            ts: new Date().toISOString(),
            input: submittedImages.length
              ? { imageUrls: submittedImages }
              : {},
            packet: event.packet,
          },
        ]);
        setDraftCount(event.draftCount);
        setQuestionCount(event.questionCount);
        setUsage(event.usage);
        if (event.draftCount >= MAX_DRAFTS) {
          setStatus("ended");
          setEndedReason("max_drafts");
        } else {
          setStatus("ready");
        }
      } else if (event.type === "answer_complete") {
        setTurns((prev) => [
          ...prev,
          {
            kind: "question",
            turnIndex: event.turnIndex,
            ts: new Date().toISOString(),
            input: { text: "" },
            packet: event.packet,
          },
        ]);
        setDraftCount(event.draftCount);
        setQuestionCount(event.questionCount);
        setUsage(event.usage);
        setStatus("ready");
      } else if (event.type === "limit_reached") {
        setError(
          event.kind === "draft"
            ? "You've used all 5 drafts for this assignment."
            : "You've used all 3 coach questions for this assignment.",
        );
        // Don't transition to error — the session is still usable for the
        // other turn kind.
        setStatus(kind === "end" ? "ended" : "ready");
      } else if (event.type === "session_ended") {
        setEndedReason(event.endedReason);
        setStatus("ended");
      } else if (event.type === "error") {
        setError(event.message);
        setStatus("error");
      }
    },
    [],
  );

  const start = useCallback<UseWritingSessionReturn["start"]>(
    async (prompt, token, yearLevel) => {
      reset();
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus("starting");
      try {
        await startWriting(
          prompt,
          token,
          (e) => handleEvent(e, "start"),
          controller.signal,
          yearLevel,
        );
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to start.");
        setStatus("error");
      }
    },
    [handleEvent, reset],
  );

  const submitDraft = useCallback<UseWritingSessionReturn["submitDraft"]>(
    async (draft, token) => {
      if (!sessionId) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus("submitting_draft");
      setError(null);
      pendingDraftImagesRef.current = draft.images ?? [];
      // Optimistic placeholder turn so the UI shows pending state — replaced
      // when feedback_complete lands.
      try {
        await submitWritingDraft(
          sessionId,
          draft,
          token,
          (e) => handleEvent(e, "draft"),
          controller.signal,
        );
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to submit draft.");
        setStatus("error");
      }
    },
    [sessionId, handleEvent],
  );

  const submitQuestion = useCallback<
    UseWritingSessionReturn["submitQuestion"]
  >(
    async (question, token) => {
      if (!sessionId) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus("submitting_question");
      setError(null);
      try {
        await submitWritingQuestion(
          sessionId,
          question,
          token,
          (e) => handleEvent(e, "question"),
          controller.signal,
        );
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(
          err instanceof Error ? err.message : "Failed to submit question.",
        );
        setStatus("error");
      }
    },
    [sessionId, handleEvent],
  );

  const end = useCallback<UseWritingSessionReturn["end"]>(
    async (token) => {
      if (!sessionId) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus("ending");
      try {
        await endWritingSession(
          sessionId,
          token,
          (e) => handleEvent(e, "end"),
          controller.signal,
        );
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to end session.");
        setStatus("error");
      }
    },
    [sessionId, handleEvent],
  );

  return {
    status,
    sessionId,
    plan,
    turns,
    draftCount,
    questionCount,
    usage,
    endedReason,
    error,
    start,
    submitDraft,
    submitQuestion,
    end,
    hydrate,
    reset,
    imageUrls,
  };
};
