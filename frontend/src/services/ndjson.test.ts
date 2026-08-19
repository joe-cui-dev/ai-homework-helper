import { describe, expect, it, vi } from "vitest";
import { parseNdjsonStream } from "./ndjson";

const stream = (text: string) => new Response(text).body!;

describe("parseNdjsonStream", () => {
  it("returns the caller-defined terminal event", async () => {
    const onEvent = vi.fn();
    const terminal = await parseNdjsonStream(
      stream('{"type":"progress"}\n{"type":"finished","value":2}\n'),
      onEvent,
      (event) => event.type === "finished",
    );

    expect(terminal).toEqual({ type: "finished", value: 2 });
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it("rejects a malformed non-empty line", async () => {
    await expect(parseNdjsonStream(
      stream('{"type":"progress"}\n{"type":'),
      vi.fn(),
      (event) => event.type === "finished",
    )).rejects.toThrow("Malformed NDJSON event");
  });

  it("rejects EOF before the caller-defined terminal event", async () => {
    await expect(parseNdjsonStream(
      stream('{"type":"progress"}\n'),
      vi.fn(),
      (event) => event.type === "finished",
    )).rejects.toThrow("ended before a terminal event");
  });
});
