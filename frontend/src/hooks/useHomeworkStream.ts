import { useState, useCallback, useRef } from "react";
import { streamHomework } from "../services/api";
import type { BatchPacket, StreamEvent } from "../types";

type Status = "idle" | "analyzing" | "generating" | "done" | "stopped" | "error";

export interface PendingPacket {
  questionId: number;
  total: number;
  text: string;
}

interface UseHomeworkStreamReturn {
  status: Status;
  packets: BatchPacket[];
  pending: PendingPacket[];
  totalQuestions: number;
  error: string | null;
  submit: (question: string, token: string, images?: string[]) => Promise<void>;
  stop: () => void;
  reset: () => void;
}

export const useHomeworkStream = (): UseHomeworkStreamReturn => {
  const [status, setStatus] = useState<Status>("idle");
  const [packets, setPackets] = useState<BatchPacket[]>([]);
  const [pending, setPending] = useState<PendingPacket[]>([]);
  const [totalQuestions, setTotalQuestions] = useState(0);
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
    setPackets([]);
    setPending([]);
    setTotalQuestions(0);
    setError(null);
    pendingTextRef.current.clear();
  }, []);

  const submit = useCallback(
    async (question: string, token: string, images?: string[]) => {
      const controller = new AbortController();
      abortControllerRef.current = controller;
      abortRef.current = false;
      pendingTextRef.current.clear();
      setStatus("analyzing");
      setPackets([]);
      setPending([]);
      setTotalQuestions(0);
      setError(null);

      const handleEvent = (event: StreamEvent) => {
        if (abortRef.current) return;

        if (event.type === "analyzing") {
          setStatus("analyzing");
        } else if (event.type === "packet_start") {
          pendingTextRef.current.set(event.questionId, event.text);
          setTotalQuestions(event.total);
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
              packet: event.packet,
            },
          ]);
          setPending((prev) =>
            prev.filter((p) => p.questionId !== event.questionId),
          );
        } else if (event.type === "complete") {
          setPackets(event.packets);
          setPending([]);
          setStatus("done");
        } else if (event.type === "error") {
          setError(event.message);
          setStatus("error");
        }
      };

      try {
        await streamHomework(question, token, handleEvent, images, controller.signal);
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
    packets,
    pending,
    totalQuestions,
    error,
    submit,
    stop,
    reset,
  };
};
