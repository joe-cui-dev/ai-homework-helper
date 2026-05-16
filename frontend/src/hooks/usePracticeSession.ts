import { useCallback, useRef, useState } from "react";
import {
  endPractice,
  startPractice,
  submitPracticeTurn,
} from "../services/practiceApi";
import type {
  PracticeStreamEvent,
  TokenUsage,
  TranscriptEntry,
} from "../types";

type Status =
  | "idle"
  | "starting"
  | "awaiting_parent"
  | "submitting"
  | "ended"
  | "error";

interface ToolEvent {
  tool: string;
  done: boolean;
}

interface UsePracticeSessionReturn {
  status: Status;
  sessionId: string | null;
  transcript: TranscriptEntry[];
  toolEvents: ToolEvent[];
  sessionUsage: TokenUsage | null;
  turnCount: number;
  finalSummary: string | null;
  error: string | null;
  start: (originSessionId: string, questionId: number, token: string) => Promise<void>;
  submit: (parentMessage: string, token: string) => Promise<void>;
  end: (token: string) => Promise<void>;
  reset: () => void;
}

export const usePracticeSession = (): UsePracticeSessionReturn => {
  const [status, setStatus] = useState<Status>("idle");
  // The practice session's stable UUID. Unknown until the backend assigns it
  // on /start and surfaces it via the first turn_complete event.
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [sessionUsage, setSessionUsage] = useState<TokenUsage | null>(null);
  const [turnCount, setTurnCount] = useState(0);
  const [finalSummary, setFinalSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  // useState's setter is captured by handleEvent, but submit/end need the
  // *current* sessionId — read it via this ref to avoid stale-closure misses.
  const sessionIdRef = useRef<string | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setStatus("idle");
    setSessionId(null);
    sessionIdRef.current = null;
    setTranscript([]);
    setToolEvents([]);
    setSessionUsage(null);
    setTurnCount(0);
    setFinalSummary(null);
    setError(null);
  }, []);

  const handleEvent = useCallback((event: PracticeStreamEvent) => {
    if (event.type === "tool_start") {
      setToolEvents((prev) => [...prev, { tool: event.tool, done: false }]);
    } else if (event.type === "tool_end") {
      setToolEvents((prev) =>
        prev.map((e) =>
          e.tool === event.tool && !e.done ? { ...e, done: true } : e,
        ),
      );
    } else if (event.type === "turn_complete") {
      if (sessionIdRef.current !== event.sessionId) {
        sessionIdRef.current = event.sessionId;
        setSessionId(event.sessionId);
      }
      setTranscript((prev) => [
        ...prev,
        {
          role: "agent",
          agentMessage: event.agentMessage,
          problem: event.problem,
          isSessionEnded: event.isSessionEnded,
          endedReason: event.endedReason,
          finalSummary: event.finalSummary,
        },
      ]);
      setSessionUsage(event.sessionUsage);
      setTurnCount((n) => n + 1);
      setToolEvents([]);
      if (event.isSessionEnded) {
        setFinalSummary(event.finalSummary ?? null);
        setStatus("ended");
      } else {
        setStatus("awaiting_parent");
      }
    } else if (event.type === "error") {
      setError(event.message);
      setStatus("error");
    }
  }, []);

  const start = useCallback(
    async (originSessionId: string, questionId: number, token: string) => {
      reset();
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus("starting");
      try {
        await startPractice(
          originSessionId,
          questionId,
          token,
          handleEvent,
          controller.signal,
        );
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to start practice.");
        setStatus("error");
      }
    },
    [handleEvent, reset],
  );

  const submit = useCallback(
    async (parentMessage: string, token: string) => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setTranscript((prev) => [...prev, { role: "parent", message: parentMessage }]);
      setStatus("submitting");
      try {
        await submitPracticeTurn(
          sid,
          parentMessage,
          token,
          handleEvent,
          controller.signal,
        );
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to submit turn.");
        setStatus("error");
      }
    },
    [handleEvent],
  );

  const end = useCallback(
    async (token: string) => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus("submitting");
      try {
        await endPractice(sid, token, handleEvent, controller.signal);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to end practice.");
        setStatus("error");
      }
    },
    [handleEvent],
  );

  return {
    status,
    sessionId,
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
  };
};
