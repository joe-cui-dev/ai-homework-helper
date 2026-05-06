import type { StreamEvent } from "../types";

export const streamReading = async (
  token: string,
  images: string[],
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> => {
  const apiUrl = import.meta.env.VITE_READING_API_URL;
  if (!apiUrl) throw new Error("VITE_READING_API_URL is not configured.");

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ images }),
    signal,
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Request failed with status ${response.status}.`);
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
        const event = JSON.parse(trimmed) as StreamEvent;
        onEvent(event);
        if (event.type === "error") return;
      } catch {
        // Ignore malformed lines.
      }
    }
  }

  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer.trim()) as StreamEvent;
      onEvent(event);
    } catch {
      // Ignore malformed final line.
    }
  }
};
