import { useState, useCallback, useRef } from "react";
import { streamHomework } from "../services/api";
import type { QuestionResult, StreamEvent } from "../types";

type Status = "idle" | "streaming" | "done" | "stopped" | "error";

interface ToolEvent {
  tool: string;
  done: boolean;
}

export interface ActiveQuestion {
  id: number;
  total: number;
  text: string;
}

interface UseHomeworkStreamReturn {
  status: Status;
  toolEvents: ToolEvent[];
  results: QuestionResult[];
  activeQuestion: ActiveQuestion | null;
  totalQuestions: number;
  error: string | null;
  submit: (question: string, token: string, images?: string[]) => Promise<void>;
  stop: () => void;
  reset: () => void;
}

export const useHomeworkStream = (): UseHomeworkStreamReturn => {
  const [status, setStatus] = useState<Status>("idle");
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [results, setResults] = useState<QuestionResult[]>([]);
  const [activeQuestion, setActiveQuestion] = useState<ActiveQuestion | null>(null);
  const [totalQuestions, setTotalQuestions] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // abortRef gates stale event processing; abortControllerRef cancels the fetch.
  const abortRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeTextRef = useRef<string>("");

  const stop = useCallback(() => {
    abortRef.current = true;
    abortControllerRef.current?.abort();
    setActiveQuestion(null);
    setToolEvents([]);
    setStatus("stopped");
  }, []);

  const reset = useCallback(() => {
    abortRef.current = true;
    abortControllerRef.current?.abort();
    setStatus("idle");
    setToolEvents([]);
    setResults([]);
    setActiveQuestion(null);
    setError(null);
  }, []);

  const submit = useCallback(
    async (question: string, token: string, images?: string[]) => {
      const controller = new AbortController();
      abortControllerRef.current = controller;
      abortRef.current = false;
      activeTextRef.current = "";
      setStatus("streaming");
      setToolEvents([]);
      setResults([]);
      setActiveQuestion(null);
      setTotalQuestions(0);
      setError(null);

      const handleEvent = (event: StreamEvent) => {
        if (abortRef.current) return;

        if (event.type === "tool_start") {
          setToolEvents((prev) => [...prev, { tool: event.tool, done: false }]);
        } else if (event.type === "tool_end") {
          setToolEvents((prev) =>
            prev.map((e) =>
              e.tool === event.tool && !e.done ? { ...e, done: true } : e,
            ),
          );
        } else if (event.type === "question_start") {
          setToolEvents([]);
          activeTextRef.current = event.text;
          setTotalQuestions(event.total);
          setActiveQuestion({ id: event.questionId, total: event.total, text: event.text });
        } else if (event.type === "question_complete") {
          setResults((prev) => [
            ...prev,
            { questionId: event.questionId, questionText: activeTextRef.current, result: event.result },
          ]);
          setActiveQuestion(null);
        } else if (event.type === "complete") {
          setResults(event.results);
          setActiveQuestion(null);
          setStatus("done");
        } else if (event.type === "error") {
          setError(event.message);
          setStatus("error");
        }
      };

      try {
        await streamHomework(question, token, handleEvent, images, controller.signal);
        // If stop() was already called, leave status as "stopped".
        setStatus((prev) => (prev === "streaming" ? "done" : prev));
      } catch (err) {
        // AbortError means the user clicked Stop — not an unexpected failure.
        if (err instanceof Error && err.name === "AbortError") {
          setStatus((prev) => (prev === "streaming" ? "stopped" : prev));
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

  return { status, toolEvents, results, activeQuestion, totalQuestions, error, submit, stop, reset };
};
