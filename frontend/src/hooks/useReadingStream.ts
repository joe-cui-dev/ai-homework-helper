import { useState, useCallback, useRef } from "react";
import { streamReading } from "../services/readingApi";
import type {
  BookContext,
  ReadingBatchPacket,
  StreamEvent,
  TokenUsage,
  YearLevel,
} from "../types";

// State machine for the reading-task flow. Mirrors useHomeworkStream but
// handles the reading-specific event sequence:
//   idle → analyzing → (needs_more_pages | generating → done) | error | stopped
// The "needs_more_pages" terminal state is unique to reading: the AI judged
// the uploaded pages too thin for 5 grounded questions, and asks the parent
// to re-upload with more book content (no session is saved).
type Status =
  | "idle"
  | "analyzing"
  | "generating"
  | "done"
  | "needs_more_pages"
  | "stopped"
  | "error";

interface UseReadingStreamReturn {
  status: Status;
  sessionId: string | null;
  bookContext: BookContext | null;
  yearLevel: YearLevel | null;
  packets: ReadingBatchPacket[];
  usage: TokenUsage | null;
  needsMorePagesMessage: string | null;
  error: string | null;
  submit: (token: string, images: string[]) => Promise<void>;
  stop: () => void;
  reset: () => void;
}

export const useReadingStream = (): UseReadingStreamReturn => {
  const [status, setStatus] = useState<Status>("idle");
  const [sessionId, setBatchId] = useState<string | null>(null);
  const [bookContext, setBookContext] = useState<BookContext | null>(null);
  const [yearLevel, setYearLevel] = useState<YearLevel | null>(null);
  const [packets, setPackets] = useState<ReadingBatchPacket[]>([]);
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const [needsMorePagesMessage, setNeedsMorePagesMessage] = useState<
    string | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current = true;
    abortControllerRef.current?.abort();
    setStatus("stopped");
  }, []);

  const reset = useCallback(() => {
    abortRef.current = true;
    abortControllerRef.current?.abort();
    setStatus("idle");
    setBatchId(null);
    setBookContext(null);
    setYearLevel(null);
    setPackets([]);
    setUsage(null);
    setNeedsMorePagesMessage(null);
    setError(null);
  }, []);

  const submit = useCallback(async (token: string, images: string[]) => {
    const controller = new AbortController();
    abortControllerRef.current = controller;
    abortRef.current = false;
    setStatus("analyzing");
    setBatchId(null);
    setBookContext(null);
    setYearLevel(null);
    setPackets([]);
    setUsage(null);
    setNeedsMorePagesMessage(null);
    setError(null);

    const handleEvent = (event: StreamEvent) => {
      if (abortRef.current) return;

      if (event.type === "book_analyzing") {
        setStatus("analyzing");
      } else if (event.type === "book_analyzed") {
        setBookContext(event.bookContext);
        setYearLevel(event.yearLevel);
        setStatus("generating");
      } else if (event.type === "needs_more_pages") {
        setNeedsMorePagesMessage(event.message);
        setStatus("needs_more_pages");
      } else if (event.type === "reading_packet_complete") {
        setPackets((prev) => [
          ...prev,
          { questionId: event.questionId, packet: event.packet },
        ]);
      } else if (event.type === "reading_complete") {
        setBatchId(event.sessionId);
        setBookContext(event.bookContext);
        setPackets(event.packets);
        setUsage(event.usage);
        setStatus("done");
      } else if (event.type === "error") {
        setError(event.message);
        setStatus("error");
      }
    };

    try {
      await streamReading(token, images, handleEvent, controller.signal);
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
  }, []);

  return {
    status,
    sessionId,
    bookContext,
    yearLevel,
    packets,
    usage,
    needsMorePagesMessage,
    error,
    submit,
    stop,
    reset,
  };
};
