import type { PracticeStreamEvent } from "../types";

const practiceUrl = (): string => {
  const base = import.meta.env.VITE_PRACTICE_API_URL as string | undefined;
  if (!base) throw new Error("VITE_PRACTICE_API_URL is not configured.");
  return base.endsWith("/") ? base.slice(0, -1) : base;
};

const streamPracticeRoute = async (
  path: "start" | "turn" | "end",
  body: Record<string, unknown>,
  token: string,
  onEvent: (event: PracticeStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> => {
  const response = await fetch(`${practiceUrl()}/practice/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Practice request failed (${response.status}).`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as PracticeStreamEvent;
        onEvent(event);
        if (event.type === "error") return;
      } catch {
        // malformed line — ignore
      }
    }
  }

  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer.trim()) as PracticeStreamEvent;
      onEvent(event);
    } catch {
      // ignore
    }
  }
};

export const startPractice = (
  originSessionId: string,
  questionId: number,
  token: string,
  onEvent: (event: PracticeStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> =>
  streamPracticeRoute(
    "start",
    { originSessionId, questionId },
    token,
    onEvent,
    signal,
  );

export const submitPracticeTurn = (
  sessionId: string,
  parentMessage: string,
  token: string,
  onEvent: (event: PracticeStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> =>
  streamPracticeRoute(
    "turn",
    { sessionId, parentMessage },
    token,
    onEvent,
    signal,
  );

export const endPractice = (
  sessionId: string,
  token: string,
  onEvent: (event: PracticeStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> =>
  streamPracticeRoute(
    "end",
    { sessionId },
    token,
    onEvent,
    signal,
  );
