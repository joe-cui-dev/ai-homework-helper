jest.mock("@aws-sdk/client-s3", () => {
  const sendMock = jest.fn();
  class NoSuchKey extends Error {
    name = "NoSuchKey";
  }
  return {
    S3Client: jest.fn(() => ({ send: sendMock })),
    GetObjectCommand: jest.fn((input: unknown) => ({ __cmd: "Get", ...input as object })),
    PutObjectCommand: jest.fn((input: unknown) => ({ __cmd: "Put", ...input as object })),
    ListObjectsV2Command: jest.fn((input: unknown) => ({ __cmd: "List", ...input as object })),
    NoSuchKey,
    _sendMock: sendMock,
  };
});

jest.mock("../shared/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { _sendMock: mockSend, NoSuchKey } = jest.requireMock("@aws-sdk/client-s3") as {
  _sendMock: jest.Mock;
  NoSuchKey: typeof Error;
};

import {
  createPracticeSession,
  loadPracticeSession,
  listPracticeSessionsForBatch,
  PRACTICE_SESSION_MAX_AGE_HOURS,
} from "../practice/practiceStorage";
import type { CoachingPacket, PracticeSession } from "../shared/types";

const PACKET: CoachingPacket = {
  questionId: 1,
  subject: "math",
  yearLevel: "year-3",
  tldrAnswer: "12",
  whyItWorks: "Adding two-digit numbers.",
  howToCoach: "Use blocks.",
  watchFor: ["regrouping errors"],
  childHint: "What's 5+7?",
};

const sessionJson = (
  overrides: Partial<PracticeSession> = {},
): PracticeSession => ({
  practiceSessionId: "batch-1:1",
  studentId: "student-1",
  sourceBatchId: "batch-1",
  sourceQuestionId: 1,
  sourceCoachingPacket: PACKET,
  createdAt: "2026-05-01T00:00:00Z",
  updatedAt: "2026-05-01T00:00:00Z",
  status: "active",
  problemCount: 0,
  toolCallCount: 0,
  problems: [],
  messages: [],
  toolLog: [],
  totalUsage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  ...overrides,
});

beforeEach(() => {
  mockSend.mockReset();
  process.env.S3_BUCKET_NAME = "test-bucket";
});

// ── createPracticeSession ─────────────────────────────────────────────────

describe("createPracticeSession", () => {
  it("creates a fresh session when no prior practice exists", async () => {
    // First call: load existing practice (NoSuchKey).
    mockSend.mockRejectedValueOnce(new NoSuchKey("not found"));
    // Second call: load source batch.
    mockSend.mockResolvedValueOnce({
      Body: {
        transformToString: async () =>
          JSON.stringify({
            timestamp: "t",
            questions: [{ questionId: 1, input: "Q", packet: PACKET }],
          }),
      },
    });
    // Third call: PutObject (saving the new session).
    mockSend.mockResolvedValueOnce({});

    const session = await createPracticeSession({
      studentId: "student-1",
      batchId: "batch-1",
      questionId: 1,
    });

    expect(session.practiceSessionId).toBe("batch-1:1");
    expect(session.status).toBe("active");
    expect(session.sourceCoachingPacket.tldrAnswer).toBe("12");
  });

  it("refuses to create when an active session already exists", async () => {
    // updatedAt must be fresh to avoid the 24h auto-abandon path.
    mockSend.mockResolvedValueOnce({
      Body: {
        transformToString: async () =>
          JSON.stringify(
            sessionJson({
              status: "active",
              updatedAt: new Date().toISOString(),
            }),
          ),
      },
    });

    await expect(
      createPracticeSession({
        studentId: "student-1",
        batchId: "batch-1",
        questionId: 1,
      }),
    ).rejects.toThrow(/already in progress/i);
  });
});

// ── loadPracticeSession + auto-abandon ────────────────────────────────────

describe("loadPracticeSession", () => {
  it("returns the session as-is when status is active and not stale", async () => {
    const fresh = sessionJson({ updatedAt: new Date().toISOString() });
    mockSend.mockResolvedValueOnce({
      Body: { transformToString: async () => JSON.stringify(fresh) },
    });

    const session = await loadPracticeSession({
      studentId: "student-1",
      batchId: "batch-1",
      questionId: 1,
    });

    expect(session.status).toBe("active");
    expect(session.endedReason).toBeUndefined();
  });

  it("auto-abandons sessions older than the max age and persists the change", async () => {
    const ancient = sessionJson({
      updatedAt: new Date(
        Date.now() - (PRACTICE_SESSION_MAX_AGE_HOURS + 1) * 3600 * 1000,
      ).toISOString(),
    });
    mockSend.mockResolvedValueOnce({
      Body: { transformToString: async () => JSON.stringify(ancient) },
    });
    mockSend.mockResolvedValueOnce({}); // PutObject (auto-abandon save)

    const session = await loadPracticeSession({
      studentId: "student-1",
      batchId: "batch-1",
      questionId: 1,
    });

    expect(session.status).toBe("ended");
    expect(session.endedReason).toBe("abandoned");
    expect(mockSend).toHaveBeenCalledTimes(2); // Get + Put
  });
});

// ── listPracticeSessionsForBatch ──────────────────────────────────────────

describe("listPracticeSessionsForBatch", () => {
  it("returns summaries for each practice session in a batch", async () => {
    mockSend.mockResolvedValueOnce({
      Contents: [
        { Key: "sessions/student-1/batch-1/practice-1.json" },
        { Key: "sessions/student-1/batch-1/practice-3.json" },
        { Key: "sessions/student-1/batch-1/image-0.jpeg" }, // ignored
      ],
    });
    mockSend.mockResolvedValueOnce({
      Body: {
        transformToString: async () =>
          JSON.stringify(
            sessionJson({
              practiceSessionId: "batch-1:1",
              sourceQuestionId: 1,
              status: "ended",
              endedReason: "mastered",
              problemCount: 4,
            }),
          ),
      },
    });
    mockSend.mockResolvedValueOnce({
      Body: {
        transformToString: async () =>
          JSON.stringify(
            sessionJson({
              practiceSessionId: "batch-1:3",
              sourceQuestionId: 3,
              status: "active",
              problemCount: 2,
            }),
          ),
      },
    });

    const summaries = await listPracticeSessionsForBatch("student-1", "batch-1");

    expect(summaries).toHaveLength(2);
    const byQ = new Map(summaries.map((s) => [s.questionId, s]));
    expect(byQ.get(1)?.status).toBe("ended");
    expect(byQ.get(1)?.endedReason).toBe("mastered");
    expect(byQ.get(3)?.status).toBe("active");
    expect(byQ.get(3)?.problemCount).toBe(2);
  });

  it("returns empty when no practice sessions exist", async () => {
    mockSend.mockResolvedValueOnce({ Contents: [] });
    const summaries = await listPracticeSessionsForBatch(
      "student-1",
      "batch-1",
    );
    expect(summaries).toEqual([]);
  });
});
