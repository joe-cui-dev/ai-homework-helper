import { parseSessionId, parseStudentId, parseSubmissionId } from "../shared/storageIdentifiers";

describe("storage identifiers", () => {
  it.each([
    "550e8400-e29b-41d4-a716-446655440000",
    "session-1",
    "attempt_2.test",
  ])("accepts a safe key segment: %s", (value) => {
    expect(parseSubmissionId(value)).toBe(value);
    expect(parseSessionId(value)).toBe(value);
    expect(parseStudentId(value)).toBe(value);
  });

  it.each(["", " ", "../other", "path/child", "unicode-作業", "line\nbreak", `x${"a".repeat(128)}`])(
    "rejects an unsafe or overlong key segment: %j",
    (value) => expect(() => parseSubmissionId(value)).toThrow(),
  );
});
