import { useState, useEffect, useCallback } from "react";
import { fetchSessionHistory } from "../services/api";
import type { HistoryModule } from "../services/api";
import type { SessionSummary } from "../types";

interface UseSessionHistoryReturn {
  sessions: SessionSummary[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  nextCursor: string | null;
  loadMore: () => Promise<void>;
  removeSession: (sessionId: string) => void;
}

export function useSessionHistory(
  token: string,
  module: HistoryModule,
): UseSessionHistoryReturn {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setSessions([]);
    setError(null);
    setNextCursor(null);

    fetchSessionHistory(token, module, undefined, controller.signal)
      .then(({ sessions: initial, nextCursor: cursor }) => {
        setSessions(initial);
        setNextCursor(cursor);
      })
      .catch((err: Error) => {
        if (err.name !== "AbortError") setError(err.message);
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [token, module]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const { sessions: more, nextCursor: cursor } = await fetchSessionHistory(
        token,
        module,
        nextCursor,
      );
      setSessions((prev) => [...prev, ...more]);
      setNextCursor(cursor);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }, [token, module, nextCursor]); // loadingMore excluded — it's a guard, not a dep

  const removeSession = useCallback((sessionId: string) => {
    setSessions((current) => current.filter((session) => session.sessionId !== sessionId));
  }, []);

  return { sessions, loading, loadingMore, error, nextCursor, loadMore, removeSession };
}
