import { saveSession, saveAgentSidecar } from "../shared/sessionStore";
import type { AgentSidecar } from "../shared/sessionStore";
import type { WritingSession } from "../shared/session";
import type { WritingPlanPacket } from "../shared/types";
import {
  loadWritingBundle,
  saveWritingBundle,
} from "../writing/writingStorage";

jest.mock("@aws-sdk/client-s3", () => {
  const store = new Map<string, string>();
  const sendMock = jest.fn(async (cmd: { Body?: string; Key?: string; Prefix?: string }) => {
    if (typeof cmd.Body === "string") {
      store.set(cmd.Key!, cmd.Body);
      return {};
    }
    if (cmd.Prefix) {
      return {
        Contents: Array.from(store.keys()).map((key) => ({
          Key: key,
          LastModified: new Date("2024-01-01"),
        })),
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
    PutObjectCommand: jest.fn((input: unknown) => input),
    GetObjectCommand: jest.fn((input: unknown) => input),
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
  _sendMock: jest.Mock;
  _store: Map<string, string>;
};

beforeEach(() => {
  s3Mock._store.clear();
  process.env.S3_BUCKET_NAME = "test-bucket";
});

const PLAN: WritingPlanPacket = {
  assignmentSummary: "Narrative.",
  genre: "narrative",
  yearLevel: "year-3",
  successCriteria: [],
  planningQuestions: [],
  modelAnswers: {
    atYearLevel: "",
    aboveYearLevel: "",
    aboveYearLevelLabel: "Year 4",
    whyAboveIsBetter: "",
  },
  vocabularyToOffer: [],
  watchFor: [],
  coachingScript: "",
};

const baseSession = (overrides: Partial<WritingSession> = {}): WritingSession => ({
  sessionType: "writing",
  sessionId: "w-1",
  studentId: "student-1",
  modelChoice: "fast",
  timestamp: "2026-05-16T10:00:00Z",
  updatedAt: new Date().toISOString(),
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  status: "active",
  prompt: { input: "write a story", imageKeys: [] },
  plan: PLAN,
  turns: [],
  draftCount: 0,
  questionCount: 0,
  ...overrides,
});

describe("loadWritingBundle", () => {
  it("returns the user-facing WritingSession together with its sidecar", async () => {
    const session = baseSession();
    const sidecar: AgentSidecar = {
      bedrockMessages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
      usagePerTurn: [{ turnIndex: 1, inputTokens: 10, outputTokens: 5 }],
    };
    await saveSession(session);
    await saveAgentSidecar(session.studentId, "writing", session.sessionId, sidecar);

    const bundle = await loadWritingBundle({
      studentId: "student-1",
      sessionId: "w-1",
    });

    expect(bundle.session.sessionType).toBe("writing");
    expect(bundle.session.status).toBe("active");
    expect(bundle.sidecar.bedrockMessages).toHaveLength(1);
    expect(bundle.sidecar.usagePerTurn[0].inputTokens).toBe(10);
  });

  it("flips an active session older than the stale threshold to ended/abandoned", async () => {
    const ancient = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const session = baseSession({ updatedAt: ancient, status: "active" });
    await saveSession(session);

    const { session: loaded } = await loadWritingBundle({
      studentId: "student-1",
      sessionId: "w-1",
    });

    expect(loaded.status).toBe("ended");
    expect(loaded.endedReason).toBe("abandoned");
  });

  it("returns an empty sidecar when one was never written", async () => {
    await saveSession(baseSession());

    const { sidecar } = await loadWritingBundle({
      studentId: "student-1",
      sessionId: "w-1",
    });

    expect(sidecar.bedrockMessages).toEqual([]);
    expect(sidecar.usagePerTurn).toEqual([]);
  });

  it("rejects a session belonging to a different student with NOT_FOUND", async () => {
    await saveSession(baseSession({ studentId: "other-student" }));

    await expect(
      loadWritingBundle({ studentId: "student-1", sessionId: "w-1" }),
    ).rejects.toMatchObject({ message: "Writing session not found." });
  });

  it("returns NOT_FOUND when no writing session exists for the id (typed prefixes prevent cross-type collision)", async () => {
    await saveSession({
      sessionType: "homework",
      sessionId: "w-1",
      studentId: "student-1",
      modelChoice: "fast",
      timestamp: "t",
      updatedAt: "t",
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      imageKeys: [],
      questions: [],
    });

    await expect(
      loadWritingBundle({ studentId: "student-1", sessionId: "w-1" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("saveWritingBundle", () => {
  it("persists session and sidecar separately so the user-facing JSON has no Bedrock messages", async () => {
    const session = baseSession();
    const sidecar: AgentSidecar = {
      bedrockMessages: [
        { role: "assistant", content: [{ type: "text", text: "long tool trace" }] },
      ],
      usagePerTurn: [{ turnIndex: 1, inputTokens: 100, outputTokens: 50 }],
    };

    await saveWritingBundle({ session, sidecar });

    const sessionJson = s3Mock._store.get("sessions/student-1/writing/w-1.json");
    expect(sessionJson).toBeDefined();
    expect(sessionJson).not.toContain("long tool trace");

    const sidecarJson = s3Mock._store.get("sessions/student-1/writing/w-1.agent.json");
    expect(sidecarJson).toBeDefined();
    expect(sidecarJson).toContain("long tool trace");
  });
});
