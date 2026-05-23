import { parseToolInput } from "../shared/bedrock";

describe("parseToolInput", () => {
  it("passes through a normal object input unchanged", () => {
    const raw = { packets: [{ questionId: 1 }, { questionId: 2 }] };
    expect(parseToolInput<typeof raw>(raw)).toEqual(raw);
  });

  it("parses a JSON-string payload back into an object", () => {
    const raw = JSON.stringify({ packets: [{ questionId: 1 }] });
    expect(parseToolInput<{ packets: { questionId: number }[] }>(raw)).toEqual({
      packets: [{ questionId: 1 }],
    });
  });

  it("parses an array-field that the model emitted as a JSON string (the bug)", () => {
    const raw = {
      packets: JSON.stringify([{ questionId: 1 }, { questionId: 2 }]),
    };
    const out = parseToolInput<{ packets: { questionId: number }[] }>(raw);
    expect(Array.isArray(out.packets)).toBe(true);
    expect(out.packets).toEqual([{ questionId: 1 }, { questionId: 2 }]);
  });

  it("parses an object-field that the model emitted as a JSON string", () => {
    const raw = { bookContext: JSON.stringify({ title: "T", author: "A" }) };
    const out = parseToolInput<{ bookContext: { title: string; author: string } }>(raw);
    expect(out.bookContext).toEqual({ title: "T", author: "A" });
  });

  it("leaves a plain-text string field alone", () => {
    const raw = { tldrAnswer: "The answer is 4." };
    expect(parseToolInput<{ tldrAnswer: string }>(raw)).toEqual(raw);
  });

  it("repairs lightly malformed JSON (trailing comma) via jsonrepair", () => {
    const raw = { items: '[{"a": 1,}, {"a": 2,},]' };
    const out = parseToolInput<{ items: { a: number }[] }>(raw);
    expect(out.items).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("repairs malformed JSON in a stringified array field (the second-layer bug)", () => {
    // The model wrote unescaped inner quotes inside a string value — strict
    // JSON.parse fails at the inner quote, but the value is recoverable.
    const raw = {
      packets:
        '[{"questionId": 1, "howToCoach": "they are "so-called" friends"}, {"questionId": 2, "howToCoach": "ok"}]',
    };
    const out = parseToolInput<{
      packets: { questionId: number; howToCoach: string }[];
    }>(raw);
    expect(Array.isArray(out.packets)).toBe(true);
    expect(out.packets).toHaveLength(2);
    expect(out.packets[0].questionId).toBe(1);
    expect(out.packets[1].questionId).toBe(2);
  });
});
