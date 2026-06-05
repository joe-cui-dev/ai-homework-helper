import {
  createPracticeBundle,
  loadPracticeBundle,
  savePracticeBundle,
  listPracticeSessionsForOrigin,
  PRACTICE_SESSION_MAX_AGE_HOURS,
} from "../practice/practiceStorage";
import type { CoachingPacket } from "../shared/session";
import type { HomeworkSession, PracticeSession } from "../shared/session";
import { saveSession } from "../shared/sessionStore";

jest.mock("@aws-sdk/client-s3", () => {
  const store = new Map<string, string>();
  const sendMock = jest.fn(async (cmd: { Body?: string; Key?: string; Prefix?: string }) => {
    if (typeof cmd.Body === "string") {
      store.set(cmd.Key!, cmd.Body);
      return {};
    }
    if (cmd.Prefix) {
      return {
        Contents: Array.from(store.keys())
          .filter((k) => k.startsWith(cmd.Prefix!))
          .map((key) => ({ Key: key, LastModified: new Date("2026-05-01") })),
        IsTruncated: false,
      };
    }
    const body = store.get(cmd.Key!);
    if (!body) {
      const err: Error & { name?: string } = new Error("NoSuchKey");
      err.name = "NoSuchKey";
      throw err;
    }
    return { Body: { transformToString: async () => body } };
  });
  return {
    S3Client: jest.fn(() => ({ send: sendMock })),
    GetObjectCommand: jest.fn((input: unknown) => input),
    PutObjectCommand: jest.fn((input: unknown) => input),
    ListObjectsV2Command: jest.fn((input: unknown) => input),
    NoSuchKey: class NoSuchKey extends Error {
      name = "NoSuchKey";
    },
    _sendMock: sendMock,
    _store: store,
  };
});

jest.mock("../shared/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const s3Mock = jest.requireMock("@aws-sdk/client-s3") as {
  _store: Map<string, string>;
};

beforeEach(() => {
  s3Mock._store.clear();
  process.env.S3_BUCKET_NAME = "test-bucket";
});

const PACKET: CoachingPacket = {
  questionId: 1,
  tldrAnswer: "12",
  whyItWorks: "Adding two-digit numbers.",
  childHint: "What's 5+7?",
};

const ZERO = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

const homeworkFixture = (
  sessionId: string,
  questionId: number,
): HomeworkSession => ({
  sessionType: "homework",
  sessionId,
  studentId: "student-1",
  modelChoice: "advanced",
  timestamp: "2026-05-01T00:00:00Z",
  updatedAt: "2026-05-01T00:00:00Z",
  usage: ZERO,
  imageKeys: [],
  questions: [
    {
      questionId,
      input: "Q",
      subject: "math",
      yearLevel: "year-3",
      packet: { ...PACKET, questionId },
    },
  ],
});

describe("createPracticeBundle", () => {
  it("creates a Practice session with its own UUID and origin link", async () => {
    await saveSession(homeworkFixture("home-1", 1));

    const { session, sidecar } = await createPracticeBundle({
      studentId: "student-1",
      originSessionId: "home-1",
      originQuestionId: 1,
    });

    expect(session.sessionType).toBe("practice");
    expect(session.sessionId).not.toBe("home-1");
    expect(session.sessionId).not.toContain(":");
    expect(session.origin).toEqual({ sessionId: "home-1", questionId: 1 });
    // subject and yearLevel are snapshotted from the source HomeworkQuestion
    // onto the practice session top-level — not from the packet (ADR 0006).
    expect(session.subject).toBe("math");
    expect(session.yearLevel).toBe("year-3");
    expect(session.status).toBe("active");
    expect(session.modelChoice).toBe("advanced");
    expect(sidecar.bedrockMessages).toEqual([]);
  });

  it("copies modelChoice from the origin Homework session", async () => {
    await saveSession(homeworkFixture("home-advanced", 1));

    const { session } = await createPracticeBundle({
      studentId: "student-1",
      originSessionId: "home-advanced",
      originQuestionId: 1,
    });

    expect(session.modelChoice).toBe("advanced");
  });

  it("persists the new Practice session under the practice/ prefix (not nested under origin)", async () => {
    await saveSession(homeworkFixture("home-1", 1));

    const { session } = await createPracticeBundle({
      studentId: "student-1",
      originSessionId: "home-1",
      originQuestionId: 1,
    });

    expect(
      s3Mock._store.has(`sessions/student-1/practice/${session.sessionId}.json`),
    ).toBe(true);
    expect(s3Mock._store.has(`sessions/student-1/home-1/practice-1.json`)).toBe(false);
  });

  it("fails when the origin homework question does not exist", async () => {
    await saveSession(homeworkFixture("home-1", 1));

    await expect(
      createPracticeBundle({
        studentId: "student-1",
        originSessionId: "home-1",
        originQuestionId: 999,
      }),
    ).rejects.toThrow(/Question 999/);
  });
});

describe("loadPracticeBundle", () => {
  it("loads session and sidecar together", async () => {
    await saveSession(homeworkFixture("home-1", 1));
    const { session } = await createPracticeBundle({
      studentId: "student-1",
      originSessionId: "home-1",
      originQuestionId: 1,
    });

    const bundle = await loadPracticeBundle({
      studentId: "student-1",
      sessionId: session.sessionId,
    });

    expect(bundle.session.sessionType).toBe("practice");
    expect(bundle.session.origin.sessionId).toBe("home-1");
    expect(bundle.sidecar.bedrockMessages).toEqual([]);
  });

  it("flips active sessions older than the stale threshold to abandoned", async () => {
    const ancient = new Date(
      Date.now() - (PRACTICE_SESSION_MAX_AGE_HOURS + 1) * 3600 * 1000,
    ).toISOString();
    const stale: PracticeSession = {
      sessionType: "practice",
      sessionId: "stale-1",
      studentId: "student-1",
      modelChoice: "advanced",
      timestamp: ancient,
      updatedAt: ancient,
      usage: ZERO,
      status: "active",
      origin: { sessionId: "home-1", questionId: 1 },
      subject: "math",
      yearLevel: "year-3",
      sourceCoachingPacket: PACKET,
      problemCount: 0,
      toolCallCount: 0,
      problems: [],
      toolLog: [],
    };
    await saveSession(stale);

    const { session } = await loadPracticeBundle({
      studentId: "student-1",
      sessionId: "stale-1",
    });

    expect(session.status).toBe("ended");
    expect(session.endedReason).toBe("abandoned");
  });

  it("returns NOT_FOUND when no practice session exists for the id (typed prefixes prevent cross-type collision)", async () => {
    await saveSession(homeworkFixture("not-practice", 1));

    await expect(
      loadPracticeBundle({ studentId: "student-1", sessionId: "not-practice" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("savePracticeBundle", () => {
  it("persists session and sidecar to separate keys", async () => {
    await saveSession(homeworkFixture("home-1", 1));
    const bundle = await createPracticeBundle({
      studentId: "student-1",
      originSessionId: "home-1",
      originQuestionId: 1,
    });
    bundle.sidecar.bedrockMessages.push({
      role: "user",
      content: [{ type: "text", text: "trace fragment" }],
    });

    await savePracticeBundle(bundle);

    const sessionJson = s3Mock._store.get(
      `sessions/student-1/practice/${bundle.session.sessionId}.json`,
    );
    const sidecarJson = s3Mock._store.get(
      `sessions/student-1/practice/${bundle.session.sessionId}.agent.json`,
    );
    expect(sessionJson).toBeDefined();
    expect(sessionJson).not.toContain("trace fragment");
    expect(sidecarJson).toContain("trace fragment");
  });
});

describe("listPracticeSessionsForOrigin", () => {
  it("returns practice summaries pointing at the given origin homework session", async () => {
    await saveSession(homeworkFixture("home-1", 1));
    await saveSession(homeworkFixture("home-2", 1));

    await createPracticeBundle({
      studentId: "student-1",
      originSessionId: "home-1",
      originQuestionId: 1,
    });
    await createPracticeBundle({
      studentId: "student-1",
      originSessionId: "home-2",
      originQuestionId: 1,
    });

    const summaries = await listPracticeSessionsForOrigin("student-1", "home-1");

    expect(summaries).toHaveLength(1);
    expect(summaries[0].origin).toEqual({ sessionId: "home-1", questionId: 1 });
  });
});
