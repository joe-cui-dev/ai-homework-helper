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

// Streams the homework question and optional image to the backend, invoking onEvent for each parsed event received.
export const streamHomework = async (
  question: string,
  token: string,
  onEvent: (event: StreamEvent) => void,
  image?: string, // base64-encoded image string, optional
): Promise<void> => {
  const apiUrl = import.meta.env.VITE_API_URL;
  if (!apiUrl) throw new Error("VITE_API_URL is not configured.");

  // Send the question and image to the backend and process the streaming response.
  // The backend is expected to send a stream of JSON lines, each representing a StreamEvent.
  // Read the response as a stream and parse each line as it arrives, invoking the onEvent callback for each event.
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

  // Process the streaming response from the backend.
  // Get a reader for the response body stream. This allows us to read the response chunk by chunk as it arrives, which is essential for handling streaming data.
  const reader = response.body.getReader();
  const decoder = new TextDecoder(); // Decoder to convert Uint8Array chunks into strings.
  let buffer = ""; // Buffer to hold incomplete lines between chunks.

  // Read the stream chunk by chunk, parsing complete lines as JSON events.
  while (true) {
    // Read the next chunk from the stream. The read() method returns a promise that resolves to an object containing a Uint8Array of the chunk and a boolean indicating if the stream is done.
    const { done, value } = await reader.read();
    if (done) break;

    // Append the decoded chunk to the buffer and split it into lines. Each line is expected to be a complete JSON string representing a StreamEvent.
    buffer += decoder.decode(value, { stream: true });
    console.log("Received chunk:", buffer); // Log the raw buffer for debugging purposes.
    const lines = buffer.split("\n"); // The last line may be incomplete, so we keep it in the buffer for the next chunk. The rest of the lines are complete and can be processed as events.
    // Keep the last (potentially incomplete) chunk in the buffer.
    buffer = lines.pop() ?? "";

    // Process each complete line as a JSON event. If a line cannot be parsed as JSON, we ignore it and continue with the next line.
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue; // Skip empty lines.
      try {
        // Parse the line as a StreamEvent and invoke the onEvent callback with the parsed event. The onEvent callback is responsible for updating the application state based on the events received from the backend.
        const event = JSON.parse(trimmed) as StreamEvent;
        onEvent(event);
        if (event.type === "complete" || event.type === "error") return;
      } catch {
        // Ignore malformed lines.
      }
    }
  }

  // After the stream is done, there may still be an incomplete line in the buffer. If so, attempt to parse it as a final event.
  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer.trim()) as StreamEvent;
      onEvent(event);
    } catch {
      // Ignore malformed final line.
    }
  }
};
