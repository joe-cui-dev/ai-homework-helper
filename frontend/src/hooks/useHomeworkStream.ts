import { useState, useCallback, useRef } from "react";
import { streamHomework } from "../services/homeworkApi";
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
  submit: (
    question: string,
    token: string,
    images?: string[],
    modelChoice?: ModelChoice,
  ) => Promise<void>;
  stop: () => void;
  reset: () => void;
}

export const useHomeworkStream = (): UseHomeworkStreamReturn => {
  const [status, setStatus] = useState<Status>("idle");
  const [sessionId, setBatchId] = useState<string | null>(null);
  const [packets, setPackets] = useState<BatchPacket[]>([]);
  const [pending, setPending] = useState<PendingPacket[]>([]);
  const [totalQuestions, setTotalQuestions] = useState(0);
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const [modelChoice, setModelChoice] = useState<ModelChoice>("fast");
  const [error, setError] = useState<string | null>(null);

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
    setBatchId(null);
    setPackets([]);
    setPending([]);
    setTotalQuestions(0);
    setUsage(null);
    setModelChoice("fast");
    setError(null);
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
      setBatchId(null);
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
          setBatchId(event.sessionId);
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
          setBatchId(event.sessionId);
          setPackets(event.packets);
          setUsage(event.usage);
          setModelChoice(event.modelChoice);
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

  return {
    status,
    sessionId,
    packets,
    pending,
    totalQuestions,
    usage,
    modelChoice,
    error,
    submit,
    stop,
    reset,
  };
};
