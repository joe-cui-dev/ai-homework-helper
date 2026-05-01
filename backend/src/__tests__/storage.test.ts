import { listSessions, saveSession, uploadSessionImages } from "../storage";
import type { BatchQuestion } from "../storage";

jest.mock("@aws-sdk/client-s3", () => {
  const sendMock = jest.fn();
  return {
    S3Client: jest.fn(() => ({ send: sendMock })),
    ListObjectsV2Command: jest.fn((input: unknown) => input),
    GetObjectCommand: jest.fn((input: unknown) => input),
    PutObjectCommand: jest.fn((input: unknown) => input),
    _sendMock: sendMock,
  };
});

jest.mock("../logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { _sendMock: mockSend } = jest.requireMock("@aws-sdk/client-s3") as {
  _sendMock: jest.Mock;
};

beforeEach(() => {
  mockSend.mockReset();
  process.env.S3_BUCKET_NAME = "test-bucket";
});

const Q: BatchQuestion = {
  input: "What is 2+2?",
  subject: "math",
  difficulty: "year-1",
  answer: "4",
  steps: ["Add 2 and 2"],
  explanation: "Two plus two equals four.",
};

// ── saveSession ───────────────────────────────────────────────────────────────

describe("saveSession", () => {
  it("stores questions array and timestamp", async () => {
    mockSend.mockResolvedValueOnce({});

    await saveSession("batch-1", { timestamp: "2024-01-01T00:00:00Z", questions: [Q] }, "student-1");

    const [putCall] = mockSend.mock.calls;
    const body = JSON.parse(putCall[0].Body as string) as { questions: BatchQuestion[]; timestamp: string };
    expect(body.questions).toHaveLength(1);
    expect(body.questions[0].input).toBe("What is 2+2?");
    expect(body.timestamp).toBe("2024-01-01T00:00:00Z");
  });

  it("includes imageKeys in stored JSON when provided", async () => {
    mockSend.mockResolvedValueOnce({});

    await saveSession("batch-1", { timestamp: "t", questions: [Q] }, "student-1", ["sessions/student-1/batch-1/image-0.jpeg"]);

    const [putCall] = mockSend.mock.calls;
    const body = JSON.parse(putCall[0].Body as string) as { imageKeys?: string[] };
    expect(body.imageKeys).toEqual(["sessions/student-1/batch-1/image-0.jpeg"]);
  });

  it("omits imageKeys from stored JSON when not provided", async () => {
    mockSend.mockResolvedValueOnce({});

    await saveSession("batch-1", { timestamp: "t", questions: [Q] }, "student-1");

    const [putCall] = mockSend.mock.calls;
    const body = JSON.parse(putCall[0].Body as string) as { imageKeys?: string[] };
    expect(body.imageKeys).toBeUndefined();
  });
});

// ── uploadSessionImages ───────────────────────────────────────────────────────

describe("uploadSessionImages", () => {
  it("uploads each image and returns their S3 keys", async () => {
    mockSend.mockResolvedValue({});

    const jpegDataUrl = "data:image/jpeg;base64,/9j/abc123";
    const pngDataUrl = "data:image/png;base64,iVBORabc";

    const keys = await uploadSessionImages("student-1", "batch-1", [jpegDataUrl, pngDataUrl]);

    expect(keys).toEqual([
      "sessions/student-1/batch-1/image-0.jpeg",
      "sessions/student-1/batch-1/image-1.png",
    ]);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("returns empty array when no images provided", async () => {
    const keys = await uploadSessionImages("student-1", "batch-1", []);
    expect(keys).toEqual([]);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("uses correct S3 key format and uploads raw bytes", async () => {
    mockSend.mockResolvedValue({});

    await uploadSessionImages("student-1", "batch-1", ["data:image/jpeg;base64,aGVsbG8="]);

    const [putCall] = mockSend.mock.calls;
    expect(putCall[0].Key).toBe("sessions/student-1/batch-1/image-0.jpeg");
    expect(putCall[0].ContentType).toBe("image/jpeg");
    expect(putCall[0].Body).toBeInstanceOf(Buffer);
  });
});

// ── listSessions ──────────────────────────────────────────────────────────────

const newFormatSession = (overrides: Partial<BatchQuestion> = {}) =>
  JSON.stringify({
    timestamp: "2024-01-01T00:00:00Z",
    questions: [{ ...Q, ...overrides }],
  });

const legacyFormatSession = (input = "What is 2+2?") =>
  JSON.stringify({
    input,
    subject: "math",
    difficulty: "year-1",
    answer: "4",
    steps: ["Add 2 and 2"],
    explanation: "Two plus two equals four.",
    timestamp: "2024-01-01T00:00:00Z",
  });

describe("listSessions", () => {
  it("returns empty when student has no sessions", async () => {
    mockSend.mockResolvedValueOnce({ Contents: [], IsTruncated: false });

    const result = await listSessions("student-1");

    expect(result).toEqual({ sessions: [], nextCursor: null });
  });

  it("returns sessions sorted newest-first with correct sessionId", async () => {
    mockSend
      .mockResolvedValueOnce({
        Contents: [
          { Key: "sessions/s1/batch-a.json", LastModified: new Date("2024-01-01") },
          { Key: "sessions/s1/batch-b.json", LastModified: new Date("2024-01-03") },
          { Key: "sessions/s1/batch-c.json", LastModified: new Date("2024-01-02") },
        ],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({ Body: { transformToString: async () => newFormatSession({ input: "newest" }) } })
      .mockResolvedValueOnce({ Body: { transformToString: async () => newFormatSession({ input: "middle" }) } })
      .mockResolvedValueOnce({ Body: { transformToString: async () => newFormatSession({ input: "oldest" }) } });

    const result = await listSessions("s1");

    expect(result.nextCursor).toBeNull();
    expect(result.sessions.map((s) => s.questions[0].input)).toEqual(["newest", "middle", "oldest"]);
    expect(result.sessions[0].sessionId).toBe("batch-b");
  });

  it("filters out image files, only returns .json sessions", async () => {
    mockSend
      .mockResolvedValueOnce({
        Contents: [
          { Key: "sessions/s1/batch-a.json", LastModified: new Date("2024-01-01") },
          { Key: "sessions/s1/batch-a/image-0.jpeg", LastModified: new Date("2024-01-01") },
          { Key: "sessions/s1/batch-a/image-1.jpeg", LastModified: new Date("2024-01-01") },
        ],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({ Body: { transformToString: async () => newFormatSession() } });

    const result = await listSessions("s1");

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].sessionId).toBe("batch-a");
  });

  it("normalises legacy single-question sessions to a one-element questions array", async () => {
    mockSend
      .mockResolvedValueOnce({
        Contents: [{ Key: "sessions/s1/batch-q1.json", LastModified: new Date("2024-01-01") }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({ Body: { transformToString: async () => legacyFormatSession("Old question") } });

    const result = await listSessions("s1");

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].questions).toHaveLength(1);
    expect(result.sessions[0].questions[0].input).toBe("Old question");
    expect(result.sessions[0].questions[0].subject).toBe("math");
  });

  it("returns new-format multi-question sessions intact", async () => {
    const multiQuestion = JSON.stringify({
      timestamp: "2024-01-01T00:00:00Z",
      questions: [
        { ...Q, input: "Q1", subject: "math" },
        { ...Q, input: "Q2", subject: "science" },
      ],
    });
    mockSend
      .mockResolvedValueOnce({
        Contents: [{ Key: "sessions/s1/batch-a.json", LastModified: new Date("2024-01-01") }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({ Body: { transformToString: async () => multiQuestion } });

    const result = await listSessions("s1");

    expect(result.sessions[0].questions).toHaveLength(2);
    expect(result.sessions[0].questions[0].input).toBe("Q1");
    expect(result.sessions[0].questions[1].input).toBe("Q2");
  });

  it("paginates and returns nextCursor when more sessions exist", async () => {
    const contents = Array.from({ length: 15 }, (_, i) => ({
      Key: `sessions/s1/session-${i}.json`,
      LastModified: new Date(2024, 0, i + 1),
    }));
    mockSend.mockResolvedValueOnce({ Contents: contents, IsTruncated: false });
    for (let i = 0; i < 10; i++) {
      mockSend.mockResolvedValueOnce({ Body: { transformToString: async () => newFormatSession() } });
    }

    const result = await listSessions("s1", undefined, 10);

    expect(result.sessions).toHaveLength(10);
    expect(result.nextCursor).not.toBeNull();
  });

  it("returns null nextCursor on last page", async () => {
    const contents = Array.from({ length: 5 }, (_, i) => ({
      Key: `sessions/s1/session-${i}.json`,
      LastModified: new Date(2024, 0, i + 1),
    }));
    mockSend.mockResolvedValueOnce({ Contents: contents, IsTruncated: false });
    for (let i = 0; i < 5; i++) {
      mockSend.mockResolvedValueOnce({ Body: { transformToString: async () => newFormatSession() } });
    }

    const result = await listSessions("s1", undefined, 10);

    expect(result.sessions).toHaveLength(5);
    expect(result.nextCursor).toBeNull();
  });

  it("respects cursor to fetch the next page", async () => {
    const contents = Array.from({ length: 12 }, (_, i) => ({
      Key: `sessions/s1/session-${i}.json`,
      LastModified: new Date(2024, 0, i + 1),
    }));
    mockSend.mockResolvedValueOnce({ Contents: contents, IsTruncated: false });
    for (let i = 0; i < 10; i++) {
      mockSend.mockResolvedValueOnce({ Body: { transformToString: async () => newFormatSession() } });
    }
    const firstPage = await listSessions("s1", undefined, 10);
    const cursor = firstPage.nextCursor!;

    mockSend.mockResolvedValueOnce({ Contents: contents, IsTruncated: false });
    for (let i = 0; i < 2; i++) {
      mockSend.mockResolvedValueOnce({ Body: { transformToString: async () => newFormatSession() } });
    }
    const secondPage = await listSessions("s1", cursor, 10);

    expect(secondPage.sessions).toHaveLength(2);
    expect(secondPage.nextCursor).toBeNull();
  });
});
