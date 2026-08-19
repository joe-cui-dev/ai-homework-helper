import {
  saveSession,
  loadSession,
  listSessions,
  saveAgentSidecar,
  loadAgentSidecar,
  uploadSessionImages,
  acquireHomeworkSubmissionClaim,
  updateHomeworkSubmissionClaim,
  uploadHomeworkSubmissionImages,
} from "../shared/sessionStore";
import type { AgentSidecar } from "../shared/sessionStore";
import type {
  CoachingPacket,
  HomeworkSession,
  PracticeSession,
  ReadingSession,
  TokenUsage,
  WritingSession,
} from "../shared/session";
import type {
  DraftFeedbackPacket,
  ReadingPacket,
  WritingPlanPacket,
} from "../shared/types";

jest.mock("@aws-sdk/client-s3", () => {
  const store = new Map<string, string>();
  const sendMock = jest.fn(async (cmd: { Bucket?: string; Key?: string; Body?: string }) => {
    if (!cmd.Key) return {};
    // PutObjectCommand returns from sendMock receives Body as a string
    if (typeof cmd.Body === "string") {
      store.set(cmd.Key, cmd.Body);
      return {};
    }
    // GetObjectCommand
    const body = store.get(cmd.Key);
    if (!body) {
      const err: Error & { name?: string } = new Error("NoSuchKey");
      err.name = "NoSuchKey";
      throw err;
    }
    return {
      Body: { transformToString: async () => body },
    };
  });
  return {
    S3Client: jest.fn(() => ({ send: sendMock })),
    PutObjectCommand: jest.fn((input: unknown) => input),
    GetObjectCommand: jest.fn((input: unknown) => input),
    ListObjectsV2Command: jest.fn((input: unknown) => input),
    _sendMock: sendMock,
    _store: store,
  };
});

jest.mock("../shared/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const s3Mock = jest.requireMock("@aws-sdk/client-s3") as {
  _sendMock: jest.Mock;
  _store: Map<string, string>;
};

beforeEach(() => {
  s3Mock._sendMock.mockClear();
  s3Mock._store.clear();
  process.env.S3_BUCKET_NAME = "test-bucket";
});

const PACKET: CoachingPacket = {
  questionId: 1,
  tldrAnswer: "4",
  whyItWorks: "Adding two pairs of items totals four.",
  childHint: "What number comes after three?",
};

const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

describe("Session round-trip", () => {
  it("saves and loads a Homework session preserving questions and discriminator", async () => {
    const session: HomeworkSession = {
      sessionType: "homework",
      sessionId: "abc-123",
      studentId: "student-1",
      modelChoice: "advanced",
      timestamp: "2026-05-16T10:00:00Z",
      updatedAt: "2026-05-16T10:00:00Z",
      usage: ZERO_USAGE,
      imageKeys: ["sessions/student-1/abc-123/image-0.jpeg"],
      questions: [
        {
          questionId: 1,
          input: "What is 2+2?",
          subject: "math",
          yearLevel: "year-1",
          packet: PACKET,
        },
      ],
    };

    await saveSession(session);
    expect(s3Mock._store.has("sessions/student-1/homework/abc-123.json")).toBe(true);
    const loaded = await loadSession("student-1", "homework", "abc-123");

    expect(loaded).not.toBeNull();
    if (!loaded) return;
    expect(loaded.sessionType).toBe("homework");
    // Discriminated-union narrowing
    if (loaded.sessionType === "homework") {
      expect(loaded.questions).toHaveLength(1);
      expect(loaded.questions[0].input).toBe("What is 2+2?");
      expect(loaded.questions[0].subject).toBe("math");
      expect(loaded.imageKeys).toEqual([
        "sessions/student-1/abc-123/image-0.jpeg",
      ]);
    }
    expect(loaded.sessionId).toBe("abc-123");
    expect(loaded.studentId).toBe("student-1");
    expect(loaded.modelChoice).toBe("advanced");
  });

  it("loads a legacy session without modelChoice as fast", async () => {
    s3Mock._store.set(
      "sessions/student-1/homework/legacy.json",
      JSON.stringify({
        sessionType: "homework",
        sessionId: "legacy",
        studentId: "student-1",
        timestamp: "2026-05-16T10:00:00Z",
        updatedAt: "2026-05-16T10:00:00Z",
        usage: ZERO_USAGE,
        imageKeys: [],
        questions: [],
      }),
    );

    const loaded = await loadSession("student-1", "homework", "legacy");

    expect(loaded?.modelChoice).toBe("fast");
  });

  it("saves and loads a Reading session preserving bookContext and readingPackets", async () => {
    const readingPacket: ReadingPacket = {
      questionId: 1,
      yearLevel: "year-3",
      questionType: "inference",
      questionText: "Why did the rabbit hide?",
      modelAnswer: "Because the fox arrived.",
      comprehensionSkill: "Cause and effect",
      coachingTip: "Ask the child to point to the page.",
      commonMisreadings: ["thought the rabbit was tired"],
      discussionPrompt: "What changed on page 4?",
    };
    const session: ReadingSession = {
      sessionType: "reading",
      sessionId: "read-1",
      studentId: "student-1",
      modelChoice: "fast",
      timestamp: "2026-05-16T10:00:00Z",
      updatedAt: "2026-05-16T10:00:00Z",
      usage: ZERO_USAGE,
      imageKeys: ["sessions/student-1/read-1/image-0.jpeg"],
      bookContext: { title: "The Hungry Rabbit", author: "Jane Doe" },
      readingPackets: [readingPacket],
    };

    await saveSession(session);
    expect(s3Mock._store.has("sessions/student-1/reading/read-1.json")).toBe(true);
    const loaded = await loadSession("student-1", "reading", "read-1");

    expect(loaded).not.toBeNull();
    if (!loaded) return;
    expect(loaded.sessionType).toBe("reading");
    if (loaded.sessionType === "reading") {
      expect(loaded.bookContext.title).toBe("The Hungry Rabbit");
      expect(loaded.readingPackets).toHaveLength(1);
      expect(loaded.readingPackets[0].questionType).toBe("inference");
    }
  });

  it("saves and loads a Writing session preserving plan, turns, and status", async () => {
    const plan: WritingPlanPacket = {
      assignmentSummary: "Narrative about a lost dog.",
      genre: "narrative",
      yearLevel: "year-4",
      yearLevelSource: "user",
      successCriteria: ["Clear sequence", "Strong opening"],
      planningQuestions: [
        {
          question: "Who is the main character?",
          suggestedAnswers: ["A child searching for their dog", "The dog trying to get home"],
        },
      ],
      modelAnswers: {
        atYearLevel: "Once upon a time...",
        aboveYearLevel: "The rain hammered the corrugated roof...",
        aboveYearLevelLabel: "Year 5",
        whyAboveIsBetter: "Stronger sensory imagery.",
      },
      vocabularyToOffer: ["frantic", "echoing"],
      watchFor: ["losing the timeline"],
      coachingScript: "Ask the child to picture the opening scene.",
    };
    const draftPacket: DraftFeedbackPacket = {
      transcription: "the dog runned away",
      againstPrompt: "Addresses the prompt directly.",
      twoStars: [
        { evidenceQuote: "the dog runned away", comment: "strong hook" },
        { evidenceQuote: "the dog runned away", comment: "clear stakes" },
      ],
      oneWish: {
        evidenceQuote: "runned",
        comment: "irregular past tense",
        revisionSuggestion: "Change 'runned' to 'ran'.",
      },
      rubric: {
        dimensions: [
          { name: "Ideas & Content", score: 3, rationale: "Clear premise." },
          { name: "Structure & Organisation", score: 2, rationale: "Missing middle." },
          { name: "Language & Vocabulary", score: 2, rationale: "Repetitive." },
          { name: "Mechanics", score: 2, rationale: "Verb errors." },
        ],
        overallBand: "Working towards",
      },
      mechanicsNotes: ["Watch irregular past tense."],
      coachingScript: "Read aloud together.",
      nextStep: "revise_with_focus",
    };
    const session: WritingSession = {
      sessionType: "writing",
      sessionId: "write-1",
      studentId: "student-1",
      modelChoice: "fast",
      timestamp: "2026-05-16T10:00:00Z",
      updatedAt: "2026-05-16T11:00:00Z",
      usage: ZERO_USAGE,
      status: "active",
      prompt: {
        input: "Write a narrative about a lost dog.",
        imageKeys: ["sessions/student-1/write-1/prompt-image-0.jpeg"],
      },
      plan,
      turns: [
        {
          kind: "draft",
          turnIndex: 1,
          ts: "2026-05-16T11:00:00Z",
          input: { text: "the dog runned away" },
          packet: draftPacket,
        },
      ],
      draftCount: 1,
      questionCount: 0,
    };

    await saveSession(session);
    expect(s3Mock._store.has("sessions/student-1/writing/write-1.json")).toBe(true);
    const loaded = await loadSession("student-1", "writing", "write-1");

    expect(loaded).not.toBeNull();
    if (!loaded) return;
    expect(loaded.sessionType).toBe("writing");
    if (loaded.sessionType === "writing") {
      expect(loaded.status).toBe("active");
      expect(loaded.draftCount).toBe(1);
      expect(loaded.turns).toHaveLength(1);
      expect(loaded.turns[0].kind).toBe("draft");
      if (loaded.turns[0].kind === "draft") {
        expect(loaded.turns[0].packet.nextStep).toBe("revise_with_focus");
      }
      expect(loaded.plan.genre).toBe("narrative");
    }
  });

  it("saves and loads a Practice session at its own top-level key with origin preserved", async () => {
    const session: PracticeSession = {
      sessionType: "practice",
      sessionId: "prac-uuid-1",
      studentId: "student-1",
      modelChoice: "advanced",
      timestamp: "2026-05-16T12:00:00Z",
      updatedAt: "2026-05-16T12:05:00Z",
      usage: ZERO_USAGE,
      status: "active",
      origin: { sessionId: "homework-batch-9", questionId: 2 },
      subject: "math",
      yearLevel: "year-3",
      sourceCoachingPacket: PACKET,
      problemCount: 1,
      toolCallCount: 3,
      problems: [
        {
          problemIndex: 0,
          problem: "What is 3+3?",
          expectedAnswer: "6",
          difficulty: "same",
        },
      ],
      toolLog: [
        { turn: 1, tool: "generate_problem", ts: "2026-05-16T12:01:00Z" },
      ],
    };

    await saveSession(session);

    // Key is under the practice/ prefix — not nested under the origin homework.
    expect(s3Mock._store.has("sessions/student-1/practice/prac-uuid-1.json")).toBe(true);
    expect(s3Mock._store.has("sessions/student-1/homework-batch-9/practice-2.json")).toBe(false);

    const loaded = await loadSession("student-1", "practice", "prac-uuid-1");
    expect(loaded).not.toBeNull();
    if (!loaded) return;
    expect(loaded.sessionType).toBe("practice");
    if (loaded.sessionType === "practice") {
      expect(loaded.origin).toEqual({ sessionId: "homework-batch-9", questionId: 2 });
      expect(loaded.problems).toHaveLength(1);
      expect(loaded.toolCallCount).toBe(3);
      expect(loaded.subject).toBe("math");
      expect(loaded.modelChoice).toBe("advanced");
    }
  });
});

describe("listSessions", () => {
  const homeworkFixture = (sessionId: string, ts: string): HomeworkSession => ({
    sessionType: "homework",
    sessionId,
    studentId: "student-1",
    modelChoice: "fast",
    timestamp: ts,
    updatedAt: ts,
    usage: ZERO_USAGE,
    imageKeys: [],
    questions: [
      {
        questionId: 1,
        input: `Q for ${sessionId}`,
        subject: "math",
        yearLevel: "year-1",
        packet: PACKET,
      },
    ],
  });

  it("returns sessions sorted newest-first", async () => {
    // Patch ListObjectsV2 mock for this test only.
    const { _sendMock } = s3Mock;
    _sendMock.mockImplementation(async (cmd: { Bucket?: string; Key?: string; Body?: string; Prefix?: string }) => {
      if (cmd.Prefix) {
        return {
          Contents: [
            { Key: "sessions/student-1/homework/a.json", LastModified: new Date("2024-01-01") },
            { Key: "sessions/student-1/homework/b.json", LastModified: new Date("2024-01-03") },
            { Key: "sessions/student-1/homework/c.json", LastModified: new Date("2024-01-02") },
          ],
          IsTruncated: false,
        };
      }
      // Default to in-memory store get-or-put behaviour
      if (typeof cmd.Body === "string") {
        s3Mock._store.set(cmd.Key!, cmd.Body);
        return {};
      }
      const body = s3Mock._store.get(cmd.Key!);
      if (!body) {
        const err: Error & { name?: string } = new Error("NoSuchKey");
        err.name = "NoSuchKey";
        throw err;
      }
      return { Body: { transformToString: async () => body } };
    });
    await saveSession(homeworkFixture("a", "2024-01-01T00:00:00Z"));
    await saveSession(homeworkFixture("b", "2024-01-03T00:00:00Z"));
    await saveSession(homeworkFixture("c", "2024-01-02T00:00:00Z"));

    const { sessions, nextCursor } = await listSessions("student-1", "homework");

    expect(nextCursor).toBeNull();
    expect(sessions.map((s) => s.sessionId)).toEqual(["b", "c", "a"]);
  });

  it("skips .agent.json sidecar files and image files", async () => {
    const { _sendMock } = s3Mock;
    _sendMock.mockImplementation(async (cmd: { Body?: string; Key?: string; Prefix?: string }) => {
      if (cmd.Prefix) {
        return {
          Contents: [
            { Key: "sessions/student-1/homework/x.json", LastModified: new Date("2024-01-01") },
            { Key: "sessions/student-1/homework/x.agent.json", LastModified: new Date("2024-01-01") },
            { Key: "sessions/student-1/homework/x/image-0.jpeg", LastModified: new Date("2024-01-01") },
          ],
          IsTruncated: false,
        };
      }
      if (typeof cmd.Body === "string") {
        s3Mock._store.set(cmd.Key!, cmd.Body);
        return {};
      }
      const body = s3Mock._store.get(cmd.Key!);
      if (!body) {
        const err: Error & { name?: string } = new Error("NoSuchKey");
        err.name = "NoSuchKey";
        throw err;
      }
      return { Body: { transformToString: async () => body } };
    });
    await saveSession(homeworkFixture("x", "2024-01-01T00:00:00Z"));

    const { sessions } = await listSessions("student-1", "homework");

    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("x");
  });

  it("paginates with cursor", async () => {
    const { _sendMock } = s3Mock;
    const contents = Array.from({ length: 12 }, (_, i) => ({
      Key: `sessions/student-1/homework/s${i}.json`,
      LastModified: new Date(2024, 0, i + 1),
    }));
    _sendMock.mockImplementation(async (cmd: { Body?: string; Key?: string; Prefix?: string }) => {
      if (cmd.Prefix) return { Contents: contents, IsTruncated: false };
      if (typeof cmd.Body === "string") {
        s3Mock._store.set(cmd.Key!, cmd.Body);
        return {};
      }
      const body = s3Mock._store.get(cmd.Key!);
      if (!body) {
        const err: Error & { name?: string } = new Error("NoSuchKey");
        err.name = "NoSuchKey";
        throw err;
      }
      return { Body: { transformToString: async () => body } };
    });
    for (let i = 0; i < 12; i++) {
      await saveSession(homeworkFixture(`s${i}`, "2024-01-01T00:00:00Z"));
    }

    const first = await listSessions("student-1", "homework", undefined, 10);
    expect(first.sessions).toHaveLength(10);
    expect(first.nextCursor).not.toBeNull();

    const second = await listSessions(
      "student-1",
      "homework",
      first.nextCursor ?? undefined,
      10,
    );
    expect(second.sessions).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
  });

  it("keeps later activity out of an existing cursor snapshot", async () => {
    const original = [
      { Key: "sessions/student-1/homework/a.json", LastModified: new Date("2024-01-01") },
      { Key: "sessions/student-1/homework/b.json", LastModified: new Date("2024-01-02") },
      { Key: "sessions/student-1/homework/c.json", LastModified: new Date("2024-01-03") },
    ];
    let contents = original;
    s3Mock._sendMock.mockImplementation(async (cmd: { Body?: string; Key?: string; Prefix?: string }) => {
      if (cmd.Prefix) return { Contents: contents, IsTruncated: false };
      if (typeof cmd.Body === "string") { s3Mock._store.set(cmd.Key!, cmd.Body); return {}; }
      const body = s3Mock._store.get(cmd.Key!);
      if (!body) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
      return { Body: { transformToString: async () => body } };
    });
    await Promise.all(["a", "b", "c"].map((id) => saveSession(homeworkFixture(id, "2024-01-01T00:00:00Z"))));
    const first = await listSessions("student-1", "homework", undefined, 1);
    expect(first.sessions.map((session) => session.sessionId)).toEqual(["c"]);

    contents = [
      original[0],
      { ...original[1], LastModified: new Date("2099-01-01") },
      original[2],
      { Key: "sessions/student-1/homework/new.json", LastModified: new Date("2099-01-02") },
    ];
    const second = await listSessions("student-1", "homework", first.nextCursor!, 10);
    expect(second.sessions.map((session) => session.sessionId)).toEqual(["b", "a"]);
  });
});

describe("Agent sidecar", () => {
  it("saves and loads the sidecar at the .agent.json key", async () => {
    const sidecar: AgentSidecar = {
      bedrockMessages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [{ type: "text", text: "hi" }] },
      ],
      usagePerTurn: [
        { turnIndex: 1, inputTokens: 100, outputTokens: 50 },
      ],
    };

    await saveAgentSidecar("student-1", "writing", "write-1", sidecar);

    expect(s3Mock._store.has("sessions/student-1/writing/write-1.agent.json")).toBe(true);

    const loaded = await loadAgentSidecar("student-1", "writing", "write-1");
    expect(loaded).toEqual(sidecar);
  });

  it("returns null when sidecar is missing", async () => {
    const loaded = await loadAgentSidecar("student-1", "writing", "no-such-session");
    expect(loaded).toBeNull();
  });

  it("does not appear in listSessions results", async () => {
    const session: HomeworkSession = {
      sessionType: "homework",
      sessionId: "hw-1",
      studentId: "student-1",
      modelChoice: "fast",
      timestamp: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      usage: ZERO_USAGE,
      imageKeys: [],
      questions: [
        {
          questionId: 1,
          input: "Q",
          subject: "math",
          yearLevel: "year-1",
          packet: PACKET,
        },
      ],
    };

    const { _sendMock } = s3Mock;
    _sendMock.mockImplementation(async (cmd: { Body?: string; Key?: string; Prefix?: string }) => {
      if (cmd.Prefix) {
        return {
          Contents: Array.from(s3Mock._store.keys()).map((key) => ({
            Key: key,
            LastModified: new Date("2024-01-01"),
          })),
          IsTruncated: false,
        };
      }
      if (typeof cmd.Body === "string") {
        s3Mock._store.set(cmd.Key!, cmd.Body);
        return {};
      }
      const body = s3Mock._store.get(cmd.Key!);
      if (!body) {
        const err: Error & { name?: string } = new Error("NoSuchKey");
        err.name = "NoSuchKey";
        throw err;
      }
      return { Body: { transformToString: async () => body } };
    });

    await saveSession(session);
    await saveAgentSidecar("student-1", "homework", "hw-1", {
      bedrockMessages: [],
      usagePerTurn: [],
    });

    const { sessions } = await listSessions("student-1", "homework");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("hw-1");
  });
});

describe("uploadSessionImages", () => {
  it("uploads each image at the per-session key prefix and returns its keys", async () => {
    s3Mock._sendMock.mockResolvedValue({});

    const keys = await uploadSessionImages("student-1", "homework", "sess-1", [
      "data:image/jpeg;base64,/9j/abc",
      "data:image/png;base64,iVBORw0",
    ]);

    expect(keys).toEqual([
      "sessions/student-1/homework/sess-1/image-0.jpeg",
      "sessions/student-1/homework/sess-1/image-1.png",
    ]);
  });

  it("namespaces image keys when a prefix is provided (Writing turn images)", async () => {
    s3Mock._sendMock.mockResolvedValue({});

    const keys = await uploadSessionImages(
      "student-1",
      "writing",
      "sess-1",
      ["data:image/jpeg;base64,/9j/abc"],
      "draft-2-image",
    );

    expect(keys).toEqual([
      "sessions/student-1/writing/sess-1/draft-2-image-0.jpeg",
    ]);
  });

  it("returns empty array when no images provided", async () => {
    const keys = await uploadSessionImages("student-1", "homework", "sess-1", []);
    expect(keys).toEqual([]);
  });
});

describe("Homework submission storage", () => {
  it("uses deterministic submission-scoped image keys", async () => {
    s3Mock._sendMock.mockResolvedValue({});
    await expect(uploadHomeworkSubmissionImages("student-1", "sess-1", "sub-7", [
      "data:image/jpeg;base64,/9j/abc",
    ])).resolves.toEqual([
      "sessions/student-1/homework/sess-1/submission-sub-7-image-0.jpeg",
    ]);
  });

  it("acquires a claim with create-only semantics before work begins", async () => {
    s3Mock._sendMock.mockResolvedValueOnce({ ETag: '"claim-v1"' });
    const result = await acquireHomeworkSubmissionClaim({
      studentId: "student-1", sessionId: "sess-1", submissionId: "sub-1",
      payloadHash: "hash-a", ownerAttemptId: "attempt-1", now: "2026-08-19T00:00:00.000Z",
      leaseExpiresAt: "2026-08-19T00:06:00.000Z",
    });

    expect(result.kind).toBe("acquired");
    expect(s3Mock._sendMock).toHaveBeenCalledWith(expect.objectContaining({
      Key: "sessions/student-1/homework/sess-1/submission-sub-1.claim",
      IfNoneMatch: "*",
    }));
  });

  it("suppresses a live duplicate and rejects a different payload", async () => {
    const conflict = Object.assign(new Error("exists"), { name: "PreconditionFailed" });
    const liveClaim = {
      status: "processing", payloadHash: "hash-a", ownerAttemptId: "attempt-other",
      leaseExpiresAt: "2026-08-19T00:06:00.000Z", updatedAt: "2026-08-19T00:00:00.000Z", version: 1,
    };
    s3Mock._sendMock
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ ETag: '"claim-v1"', Body: { transformToString: async () => JSON.stringify(liveClaim) } });
    await expect(acquireHomeworkSubmissionClaim({
      studentId: "student-1", sessionId: "sess-1", submissionId: "sub-1", payloadHash: "hash-a",
      ownerAttemptId: "attempt-2", now: "2026-08-19T00:01:00.000Z", leaseExpiresAt: "2026-08-19T00:07:00.000Z",
    })).resolves.toMatchObject({ kind: "in_progress" });

    s3Mock._sendMock
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ ETag: '"claim-v1"', Body: { transformToString: async () => JSON.stringify(liveClaim) } });
    await expect(acquireHomeworkSubmissionClaim({
      studentId: "student-1", sessionId: "sess-1", submissionId: "sub-1", payloadHash: "hash-b",
      ownerAttemptId: "attempt-2", now: "2026-08-19T00:01:00.000Z", leaseExpiresAt: "2026-08-19T00:07:00.000Z",
    })).resolves.toMatchObject({ kind: "payload_mismatch" });
  });

  it("reclaims a failed claim conditionally and increments its version", async () => {
    const conflict = Object.assign(new Error("exists"), { name: "PreconditionFailed" });
    const failedClaim = {
      status: "failed", payloadHash: "hash-a", ownerAttemptId: "attempt-old",
      leaseExpiresAt: "2026-08-18T23:00:00.000Z", updatedAt: "2026-08-18T23:00:00.000Z", version: 2,
    };
    s3Mock._sendMock
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ ETag: '"claim-v2"', Body: { transformToString: async () => JSON.stringify(failedClaim) } })
      .mockResolvedValueOnce({ ETag: '"claim-v3"' });

    await expect(acquireHomeworkSubmissionClaim({
      studentId: "student-1", sessionId: "sess-1", submissionId: "sub-1", payloadHash: "hash-a",
      ownerAttemptId: "attempt-new", now: "2026-08-19T00:00:00.000Z", leaseExpiresAt: "2026-08-19T00:06:00.000Z",
    })).resolves.toMatchObject({ kind: "acquired", claim: { version: 3, ownerAttemptId: "attempt-new" } });
    expect(s3Mock._sendMock).toHaveBeenLastCalledWith(expect.objectContaining({ IfMatch: '"claim-v2"' }));
  });

  it("updates a claim only for the owning attempt", async () => {
    s3Mock._sendMock.mockResolvedValueOnce({ ETag: '"claim-v2"' });
    await updateHomeworkSubmissionClaim({
      studentId: "student-1", sessionId: "sess-1", submissionId: "sub-1", eTag: '"claim-v1"',
      claim: { status: "complete", payloadHash: "hash-a", ownerAttemptId: "attempt-1", leaseExpiresAt: "2026-08-19T00:06:00.000Z", updatedAt: "2026-08-19T00:02:00.000Z", version: 2 },
    });
    expect(s3Mock._sendMock).toHaveBeenCalledWith(expect.objectContaining({ IfMatch: '"claim-v1"' }));
  });
});
