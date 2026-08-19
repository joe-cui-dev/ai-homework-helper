export async function parseNdjsonStream<T extends { type: string }>(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: T) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const consume = (line: string): boolean => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    try {
      const event = JSON.parse(trimmed) as T;
      onEvent(event);
      return event.type === "error";
    } catch {
      return false;
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (consume(line)) return;
  }
  buffer += decoder.decode();
  if (buffer.trim()) consume(buffer);
}
