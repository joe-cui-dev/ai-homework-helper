import type { StreamEvent } from "../types";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB

export const toBase64 = (file: File): Promise<string> => {
  if (file.size > MAX_IMAGE_BYTES) {
    return Promise.reject(
      new Error("Image must be under 2 MB. Please choose a smaller file."),
    );
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to read image file."));
    reader.readAsDataURL(file);
  });
};

// Streams the homework question and optional page images to the backend,
// invoking onEvent for each parsed NDJSON event received.
export const streamHomework = async (
  question: string,
  token: string,
  onEvent: (event: StreamEvent) => void,
  images?: string[], // base64-encoded image strings, optional
  signal?: AbortSignal,
): Promise<void> => {
  const apiUrl = import.meta.env.VITE_API_URL;
  if (!apiUrl) throw new Error("VITE_API_URL is not configured.");

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ question, images: images?.length ? images : null }),
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
        // Only stop early on error — complete arrives after all question_complete events.
        if (event.type === "error") return;
      } catch {
        // Ignore malformed lines.
      }
    }
  }

  // Attempt to parse any remaining buffered content.
  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer.trim()) as StreamEvent;
      onEvent(event);
    } catch {
      // Ignore malformed final line.
    }
  }
};
