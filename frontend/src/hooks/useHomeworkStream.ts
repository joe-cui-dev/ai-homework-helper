import { useState, useCallback, useEffect, useRef } from "react";
import { appendHomeworkPages, streamHomework } from "../services/homeworkApi";
import type { BatchPacket, ModelChoice, StreamEvent, TokenUsage } from "../types";

type Status = "idle" | "analyzing" | "generating" | "done" | "stopped" | "error";

export interface PendingPacket {
  questionId: number;
  total: number;
  text: string;
}

interface UseHomeworkStreamReturn {
  status: Status;
  sessionId: string | null;
  packets: BatchPacket[];
  pending: PendingPacket[];
  totalQuestions: number;
  usage: TokenUsage | null;
  modelChoice: ModelChoice;
  error: string | null;
  appendStatus: "idle" | "preparing" | "analyzing" | "generating" | "saving" | "error";
  appendError: string | null;
  appendNotice: string | null;
  updatedQuestionIds: number[];
  possiblyRepeatedQuestionIds: number[];
  pageCount: number;
  hasNoCompleteQuestions: boolean;
  submit: (
    question: string,
    token: string,
    images?: string[],
    modelChoice?: ModelChoice,
  ) => Promise<void>;
  stop: () => void;
  append: (token: string, images: string[], submissionId: string) => Promise<void>;
  reset: () => void;
}

export const useHomeworkStream = (): UseHomeworkStreamReturn => {
  const [status, setStatus] = useState<Status>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [packets, setPackets] = useState<BatchPacket[]>([]);
  const [pending, setPending] = useState<PendingPacket[]>([]);
  const [totalQuestions, setTotalQuestions] = useState(0);
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const [modelChoice, setModelChoice] = useState<ModelChoice>("fast");
  const [error, setError] = useState<string | null>(null);
  const [appendStatus, setAppendStatus] = useState<"idle" | "preparing" | "analyzing" | "generating" | "saving" | "error">("idle");
  const [appendError, setAppendError] = useState<string | null>(null);
  const [appendNotice, setAppendNotice] = useState<string | null>(null);
  const [updatedQuestionIds, setUpdatedQuestionIds] = useState<number[]>([]);
  const [possiblyRepeatedQuestionIds, setPossiblyRepeatedQuestionIds] = useState<number[]>([]);
  const [pageCount, setPageCount] = useState(0);
  const [hasNoCompleteQuestions, setHasNoCompleteQuestions] = useState(false);

  useEffect(() => {
    if (updatedQuestionIds.length === 0 && possiblyRepeatedQuestionIds.length === 0) return;
    const timer = window.setTimeout(() => {
      setUpdatedQuestionIds([]);
      setPossiblyRepeatedQuestionIds([]);
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [updatedQuestionIds, possiblyRepeatedQuestionIds]);

  useEffect(() => {
    if (!appendNotice) return;
    const timer = window.setTimeout(() => setAppendNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [appendNotice]);

  // abortRef gates stale event processing; abortControllerRef cancels the fetch.
  const abortRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Capture text per-question so we can pair it with the packet on packet_complete.
  const pendingTextRef = useRef<Map<number, string>>(new Map());

  const stop = useCallback(() => {
    abortRef.current = true;
    abortControllerRef.current?.abort();
    setPending([]);
    setStatus("stopped");
  }, []);

  const reset = useCallback(() => {
    abortRef.current = true;
    abortControllerRef.current?.abort();
    setStatus("idle");
    setSessionId(null);
    setPackets([]);
    setPending([]);
    setTotalQuestions(0);
    setUsage(null);
    setModelChoice("fast");
    setError(null);
    setAppendStatus("idle"); setAppendError(null); setAppendNotice(null); setUpdatedQuestionIds([]); setPossiblyRepeatedQuestionIds([]); setPageCount(0); setHasNoCompleteQuestions(false);
    pendingTextRef.current.clear();
  }, []);

  const submit = useCallback(
    async (
      question: string,
      token: string,
      images?: string[],
      selectedModelChoice: ModelChoice = "fast",
    ) => {
      const controller = new AbortController();
      abortControllerRef.current = controller;
      abortRef.current = false;
      pendingTextRef.current.clear();
      setStatus("analyzing");
      setSessionId(null);
      setPackets([]);
      setPending([]);
      setTotalQuestions(0);
      setUsage(null);
      setModelChoice(selectedModelChoice);
      setError(null);

      const handleEvent = (event: StreamEvent) => {
        if (abortRef.current) return;

        if (event.type === "analyzing") {
          setStatus("analyzing");
        } else if (event.type === "packet_start") {
          pendingTextRef.current.set(event.questionId, event.text);
          setTotalQuestions(event.total);
          setSessionId(event.sessionId);
          setStatus("generating");
          setPending((prev) => {
            // Avoid duplicates if the same id is announced twice.
            if (prev.some((p) => p.questionId === event.questionId)) return prev;
            return [
              ...prev,
              {
                questionId: event.questionId,
                total: event.total,
                text: event.text,
              },
            ];
          });
        } else if (event.type === "packet_complete") {
          const text = pendingTextRef.current.get(event.questionId) ?? "";
          setPackets((prev) => [
            ...prev,
            {
              questionId: event.questionId,
              questionText: text,
              subject: event.subject,
              yearLevel: event.yearLevel,
              packet: event.packet,
            },
          ]);
          setPending((prev) =>
            prev.filter((p) => p.questionId !== event.questionId),
          );
        } else if (event.type === "complete") {
          setSessionId(event.sessionId);
          setPackets(event.packets);
          setUsage(event.usage);
          setModelChoice(event.modelChoice);
          setPageCount(event.pageCount);
          setTotalQuestions(event.questionCount);
          setHasNoCompleteQuestions(event.hasNoCompleteQuestions);
          setPending([]);
          setStatus("done");
        } else if (event.type === "error") {
          setError(event.message);
          setStatus("error");
        }
      };

      try {
        await streamHomework(
          question,
          token,
          handleEvent,
          images,
          controller.signal,
          selectedModelChoice,
        );
        setStatus((prev) =>
          prev === "analyzing" || prev === "generating" ? "done" : prev,
        );
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          setStatus((prev) =>
            prev === "analyzing" || prev === "generating" ? "stopped" : prev,
          );
          return;
        }
        if (!abortRef.current) {
          setError(err instanceof Error ? err.message : "Something went wrong.");
          setStatus("error");
        }
      }
    },
    [],
  );

  const append = useCallback(async (token: string, images: string[], submissionId: string) => {
    if (!sessionId || !images.length) return;
    setAppendStatus("preparing"); setAppendError(null); setAppendNotice(null); setUpdatedQuestionIds([]); setPossiblyRepeatedQuestionIds([]);
    try {
      await appendHomeworkPages(sessionId, submissionId, images, token, (event) => {
        if (event.type === "append_phase") setAppendStatus(event.phase);
        if (event.type === "complete") {
          // Append results are authoritative; replace only once the server committed.
          setPackets(event.packets); setUsage(event.usage); setModelChoice(event.modelChoice);
          setTotalQuestions(event.questionCount); setPageCount(event.pageCount); setHasNoCompleteQuestions(event.hasNoCompleteQuestions); setUpdatedQuestionIds(event.updatedQuestionIds);
          setPossiblyRepeatedQuestionIds(event.possiblyRepeatedQuestionIds); setAppendStatus("idle");
          const changedQuestions = event.questionCount !== totalQuestions || event.updatedQuestionIds.length > 0;
          setAppendNotice(changedQuestions
            ? "Pages added and coaching updated."
            : "Pages added as context; no complete questions changed.");
        }
        if (event.type === "error") { setAppendError(event.message); setAppendStatus("error"); }
      });
    } catch (err) { setAppendError(err instanceof Error ? err.message : "Could not add pages."); setAppendStatus("error"); }
  }, [sessionId, totalQuestions]);

  return {
    status,
    sessionId,
    packets,
    pending,
    totalQuestions,
    usage,
    modelChoice,
    error,
    appendStatus,
    appendError,
    appendNotice,
    updatedQuestionIds,
    possiblyRepeatedQuestionIds,
    pageCount,
    hasNoCompleteQuestions,
    submit,
    stop,
    append,
    reset,
  };
};
