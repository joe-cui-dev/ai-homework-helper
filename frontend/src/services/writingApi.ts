import type { WritingStreamEvent } from "../types";

const writingUrl = (): string => {
  const base = import.meta.env.VITE_WRITING_API_URL as string | undefined;
  if (!base) throw new Error("VITE_WRITING_API_URL is not configured.");
  return base.endsWith("/") ? base.slice(0, -1) : base;
};

const streamRoute = async (
  path: "start" | "draft" | "question" | "end",
  body: Record<string, unknown>,
  token: string,
  onEvent: (event: WritingStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> => {
  const response = await fetch(`${writingUrl()}/writing/${path}`, {
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
    throw new Error(text || `Writing request failed (${response.status}).`);
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
        const event = JSON.parse(trimmed) as WritingStreamEvent;
        onEvent(event);
        if (event.type === "error") return;
      } catch {
        // malformed line — ignore
      }
    }
  }

  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer.trim()) as WritingStreamEvent;
      onEvent(event);
    } catch {
      // ignore
    }
  }
};

export const startWriting = (
  prompt: { text: string; images?: string[] },
  token: string,
  onEvent: (event: WritingStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> => streamRoute("start", { prompt }, token, onEvent, signal);

export const submitWritingDraft = (
  batchId: string,
  draft: { text?: string; images?: string[] },
  token: string,
  onEvent: (event: WritingStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> =>
  streamRoute("draft", { batchId, draft }, token, onEvent, signal);

export const submitWritingQuestion = (
  batchId: string,
  question: string,
  token: string,
  onEvent: (event: WritingStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> =>
  streamRoute("question", { batchId, question }, token, onEvent, signal);

export const endWritingSession = (
  batchId: string,
  token: string,
  onEvent: (event: WritingStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> => streamRoute("end", { batchId }, token, onEvent, signal);
