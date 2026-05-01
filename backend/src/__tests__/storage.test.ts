import { listSessions, saveSession, uploadSessionImages } from "../storage";

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

// Access the shared sendMock through jest.requireMock so we can control it per-test.
const { _sendMock: mockSend } = jest.requireMock("@aws-sdk/client-s3") as {
  _sendMock: jest.Mock;
};

beforeEach(() => {
  mockSend.mockReset();
  process.env.S3_BUCKET_NAME = "test-bucket";
});

// ── saveSession ───────────────────────────────────────────────────────────────

describe("saveSession", () => {
  it("includes imageKeys in stored JSON when provided", async () => {
    mockSend.mockResolvedValueOnce({});

    await saveSession("sess-1", { input: "q", subject: "math", difficulty: "year-1", timestamp: "t" }, "student-1", ["sessions/student-1/sess-1/image-0.jpeg"]);

    const [putCall] = mockSend.mock.calls;
    const body = JSON.parse(putCall[0].Body as string) as { imageKeys?: string[] };
    expect(body.imageKeys).toEqual(["sessions/student-1/sess-1/image-0.jpeg"]);
  });

  it("omits imageKeys from stored JSON when not provided", async () => {
    mockSend.mockResolvedValueOnce({});

    await saveSession("sess-1", { input: "q", subject: "math", difficulty: "year-1", timestamp: "t" }, "student-1");

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

    const keys = await uploadSessionImages("student-1", "sess-1", [jpegDataUrl, pngDataUrl]);

    expect(keys).toEqual([
      "sessions/student-1/sess-1/image-0.jpeg",
      "sessions/student-1/sess-1/image-1.png",
    ]);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("returns empty array when no images provided", async () => {
    const keys = await uploadSessionImages("student-1", "sess-1", []);
    expect(keys).toEqual([]);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("uses correct S3 key format and uploads raw bytes", async () => {
    mockSend.mockResolvedValue({});

    await uploadSessionImages("student-1", "sess-1", ["data:image/jpeg;base64,aGVsbG8="]);

    const [putCall] = mockSend.mock.calls;
    expect(putCall[0].Key).toBe("sessions/student-1/sess-1/image-0.jpeg");
    expect(putCall[0].ContentType).toBe("image/jpeg");
    expect(putCall[0].Body).toBeInstanceOf(Buffer);
  });
});

// ── listSessions ──────────────────────────────────────────────────────────────

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
          { Key: "sessions/s1/batch-q1.json", LastModified: new Date("2024-01-01") },
          { Key: "sessions/s1/batch-q2.json", LastModified: new Date("2024-01-03") },
          { Key: "sessions/s1/batch-q3.json", LastModified: new Date("2024-01-02") },
        ],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({ Body: { transformToString: async () => JSON.stringify({ input: "newest", subject: "math", difficulty: "year-3", timestamp: "2024-01-03T00:00:00Z" }) } })
      .mockResolvedValueOnce({ Body: { transformToString: async () => JSON.stringify({ input: "middle", subject: "science", difficulty: "year-4", timestamp: "2024-01-02T00:00:00Z" }) } })
      .mockResolvedValueOnce({ Body: { transformToString: async () => JSON.stringify({ input: "oldest", subject: "english", difficulty: "year-2", timestamp: "2024-01-01T00:00:00Z" }) } });

    const result = await listSessions("s1");

    expect(result.nextCursor).toBeNull();
    expect(result.sessions.map((s) => s.input)).toEqual(["newest", "middle", "oldest"]);
    expect(result.sessions[0].sessionId).toBe("batch-q2");
  });

  it("filters out image files, only returns .json sessions", async () => {
    mockSend
      .mockResolvedValueOnce({
        Contents: [
          { Key: "sessions/s1/batch-q1.json", LastModified: new Date("2024-01-01") },
          { Key: "sessions/s1/batch-q1/image-0.jpeg", LastModified: new Date("2024-01-01") },
          { Key: "sessions/s1/batch-q1/image-1.jpeg", LastModified: new Date("2024-01-01") },
        ],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({ Body: { transformToString: async () => JSON.stringify({ input: "q1", subject: "math", difficulty: "year-1", timestamp: "2024-01-01T00:00:00Z" }) } });

    const result = await listSessions("s1");

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].sessionId).toBe("batch-q1");
  });

  it("paginates and returns nextCursor when more sessions exist", async () => {
    const contents = Array.from({ length: 15 }, (_, i) => ({
      Key: `sessions/s1/session-${i}.json`,
      LastModified: new Date(2024, 0, i + 1),
    }));
    mockSend.mockResolvedValueOnce({ Contents: contents, IsTruncated: false });
    for (let i = 0; i < 10; i++) {
      mockSend.mockResolvedValueOnce({
        Body: { transformToString: async () => JSON.stringify({ input: `q${i}`, subject: "math", difficulty: "year-1", timestamp: new Date(2024, 0, i + 1).toISOString() }) },
      });
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
      mockSend.mockResolvedValueOnce({
        Body: { transformToString: async () => JSON.stringify({ input: `q${i}`, subject: "math", difficulty: "year-1", timestamp: new Date(2024, 0, i + 1).toISOString() }) },
      });
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
    // First page to get the cursor
    mockSend.mockResolvedValueOnce({ Contents: contents, IsTruncated: false });
    for (let i = 0; i < 10; i++) {
      mockSend.mockResolvedValueOnce({
        Body: { transformToString: async () => JSON.stringify({ input: `q${i}`, subject: "math", difficulty: "year-1", timestamp: "" }) },
      });
    }
    const firstPage = await listSessions("s1", undefined, 10);
    const cursor = firstPage.nextCursor!;

    // Second page
    mockSend.mockResolvedValueOnce({ Contents: contents, IsTruncated: false });
    for (let i = 0; i < 2; i++) {
      mockSend.mockResolvedValueOnce({
        Body: { transformToString: async () => JSON.stringify({ input: `q${i}`, subject: "math", difficulty: "year-1", timestamp: "" }) },
      });
    }
    const secondPage = await listSessions("s1", cursor, 10);

    expect(secondPage.sessions).toHaveLength(2);
    expect(secondPage.nextCursor).toBeNull();
  });
});
