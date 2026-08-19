export async function parseNdjsonStream<T extends { type: string }>(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: T) => void,
  isTerminal: (event: T) => boolean,
): Promise<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const consume = (line: string): T | undefined => {
    const trimmed = line.trim();
    if (!trimmed) return undefined;
    try {
      const event = JSON.parse(trimmed) as T;
      if (!event || typeof event.type !== "string") {
        throw new Error("Event has no type discriminator.");
      }
      onEvent(event);
      return isTerminal(event) ? event : undefined;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("Malformed NDJSON event.");
      }
      throw error;
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const terminal = consume(line);
      if (terminal) return terminal;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const terminal = consume(buffer);
    if (terminal) return terminal;
  }
  throw new Error("The response stream ended before a terminal event.");
}
