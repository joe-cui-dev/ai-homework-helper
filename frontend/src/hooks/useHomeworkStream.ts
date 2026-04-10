import { useState, useCallback, useRef } from "react";
import { streamHomework } from "../services/api";
import type { AgentResult, StreamEvent } from "../types";

type Status = "idle" | "streaming" | "done" | "error";

interface ToolEvent {
  tool: string;
  done: boolean;
}

interface UseHomeworkStreamReturn {
  status: Status;
  toolEvents: ToolEvent[];
  result: AgentResult | null;
  error: string | null;
  submit: (question: string, token: string, image?: string) => Promise<void>;
  reset: () => void;
}

export function useHomeworkStream(): UseHomeworkStreamReturn {
  const [status, setStatus] = useState<Status>("idle");
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [result, setResult] = useState<AgentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef(false);

  const reset = useCallback(() => {
    abortRef.current = true;
    setStatus("idle");
    setToolEvents([]);
    setResult(null);
    setError(null);
  }, []);

  const submit = useCallback(
    async (question: string, token: string, image?: string) => {
      abortRef.current = false;
      setStatus("streaming");
      setToolEvents([]);
      setResult(null);
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
        } else if (event.type === "complete") {
          setResult(event.result);
          setStatus("done");
        } else if (event.type === "error") {
          setError(event.message);
          setStatus("error");
        }
      };

      try {
        await streamHomework(question, token, handleEvent, image);
        // If the stream ended without a complete/error event, mark done.
        setStatus((prev) => (prev === "streaming" ? "done" : prev));
      } catch (err) {
        if (!abortRef.current) {
          setError(
            err instanceof Error ? err.message : "Something went wrong.",
          );
          setStatus("error");
        }
      }
    },
    [],
  );

  return { status, toolEvents, result, error, submit, reset };
}
