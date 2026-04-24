import type { StreamEvent } from "../types";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB

export const toBase64 = (file: File): Promise<string> => {
  if (file.size > MAX_IMAGE_BYTES) {
    return Promise.reject(
      new Error("Image must be under 4 MB. Please choose a smaller file."),
    );
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to read image file."));
    reader.readAsDataURL(file);
  });
};

export const streamHomework = async (
  question: string,
  token: string,
  onEvent: (event: StreamEvent) => void,
  image?: string,
): Promise<void> => {
  const apiUrl = import.meta.env.VITE_API_URL;
  if (!apiUrl) throw new Error("VITE_API_URL is not configured.");

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ question, image: image ?? null }),
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
    // Keep the last (potentially incomplete) chunk in the buffer.
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as StreamEvent;
        onEvent(event);
        if (event.type === "complete" || event.type === "error") return;
      } catch {
        // Ignore malformed lines.
      }
    }
  }

  // Flush remaining buffer.
  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer.trim()) as StreamEvent;
      onEvent(event);
    } catch {
      // Ignore.
    }
  }
};
