import type { APIGatewayProxyEventV2 } from "aws-lambda";

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock("aws-jwt-verify", () => ({
  CognitoJwtVerifier: {
    create: jest.fn(() => ({ verify: mockVerify })),
  },
}));

jest.mock("../shared/sessionStore", () => ({
  listSessions: jest.fn(),
  loadSession: jest.fn(),
}));

jest.mock("../practice/practiceStorage", () => ({
  listPracticeSessionsForOrigin: jest.fn().mockResolvedValue([]),
}));

jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn(),
}));

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn(() => ({ send: jest.fn() })),
  GetObjectCommand: jest.fn((input: unknown) => input),
}));

jest.mock("../shared/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    appendKeys: jest.fn(),
    resetKeys: jest.fn(),
  },
}));

const mockVerify = jest.fn();

import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { handler } from "../history/handler";
import { listSessions, loadSession } from "../shared/sessionStore";
import type { HomeworkSession } from "../shared/session";
import type { CoachingPacket } from "../shared/types";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { listPracticeSessionsForOrigin } from "../practice/practiceStorage";

const mockListSessions = listSessions as jest.MockedFunction<typeof listSessions>;
const mockLoadSession = loadSession as jest.MockedFunction<typeof loadSession>;
const mockGetSignedUrl = getSignedUrl as jest.MockedFunction<typeof getSignedUrl>;
const mockListPracticeSessions = listPracticeSessionsForOrigin as jest.MockedFunction<typeof listPracticeSessionsForOrigin>;

process.env.COGNITO_USER_POOL_ID = "us-east-1_test";
process.env.COGNITO_APP_CLIENT_ID = "test-client";
process.env.S3_BUCKET_NAME = "test-bucket";

function makeEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    headers: {},
    queryStringParameters: { type: "homework" },
    requestContext: {} as APIGatewayProxyEventV2["requestContext"],
    version: "2.0",
    routeKey: "$default",
    rawPath: "/sessions",
    rawQueryString: "",
    isBase64Encoded: false,
    ...overrides,
  };
}

const packet = (overrides: Partial<CoachingPacket> = {}): CoachingPacket => ({
  questionId: 1,
  tldrAnswer: "4",
  whyItWorks: "Adding two pairs of items totals four.",
  childHint: "What number comes after three?",
  ...overrides,
});

const ZERO = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

const baseSession = (overrides: Partial<HomeworkSession> = {}): HomeworkSession => ({
  sessionType: "homework",
  sessionId: "batch-abc",
  studentId: "student-1",
  modelChoice: "fast",
  timestamp: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
  usage: ZERO,
  imageKeys: [],
  questions: [
    {
      questionId: 1,
      input: "What is 2+2?",
      subject: "math",
      yearLevel: "year-1",
      packet: packet(),
    },
  ],
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSignedUrl.mockReset();
  process.env.S3_BUCKET_NAME = "test-bucket";
});

describe("history handler", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const response = (await handler(
      makeEvent(),
      {} as never,
    )) as APIGatewayProxyStructuredResultV2;

    expect(response.statusCode).toBe(401);
  });

  it("returns 401 when JWT is invalid", async () => {
    mockVerify.mockRejectedValueOnce(new Error("invalid token"));

    const response = (await handler(
      makeEvent({ headers: { authorization: "Bearer bad-token" } }),
      {} as never,
    )) as APIGatewayProxyStructuredResultV2;

    expect(response.statusCode).toBe(401);
  });

  it("returns sessions with pre-signed imageUrls and subjects derived from question.subject", async () => {
    mockVerify.mockResolvedValueOnce({ sub: "student-1" });
    mockListSessions.mockResolvedValueOnce({
      sessions: [
        baseSession({
          imageKeys: ["sessions/student-1/batch-abc/image-0.jpeg"],
        }),
      ],
      nextCursor: null,
    });
    mockGetSignedUrl.mockResolvedValueOnce("https://s3.example.com/presigned-url");

    const response = (await handler(
      makeEvent({ headers: { authorization: "Bearer valid-token" } }),
      {} as never,
    )) as APIGatewayProxyStructuredResultV2;

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body as string) as {
      sessions: {
        imageUrls: string[];
        imageCount: number;
        subjects: string[];
        questionPreview: string;
        questionCount: number;
        updatedAt: string;
      }[];
      nextCursor: null;
    };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].imageUrls).toEqual([
      "https://s3.example.com/presigned-url",
    ]);
    expect(body.sessions[0].subjects).toEqual(["math"]);
    expect(body.sessions[0].questionPreview).toBe("What is 2+2?");
    expect(body.sessions[0].questionCount).toBe(1);
    expect(body.sessions[0].imageCount).toBe(1);
    expect(body.sessions[0].updatedAt).toBe("2024-01-01T00:00:00Z");
    expect(body.nextCursor).toBeNull();
    expect(JSON.stringify(body.sessions[0])).not.toContain("tldrAnswer");
    expect(JSON.stringify(body.sessions[0])).not.toContain("usage");
  });

  it("deduplicates subjects when multiple questions share the same subject", async () => {
    mockVerify.mockResolvedValueOnce({ sub: "student-1" });
    mockListSessions.mockResolvedValueOnce({
      sessions: [
        baseSession({
          questions: [
            {
              questionId: 1,
              input: "Q1",
              subject: "math",
              yearLevel: "year-1",
              packet: packet(),
            },
            {
              questionId: 2,
              input: "Q2",
              subject: "math",
              yearLevel: "year-1",
              packet: packet({ questionId: 2 }),
            },
          ],
        }),
      ],
      nextCursor: null,
    });

    const response = (await handler(
      makeEvent({ headers: { authorization: "Bearer valid-token" } }),
      {} as never,
    )) as APIGatewayProxyStructuredResultV2;

    const body = JSON.parse(response.body as string) as {
      sessions: { subjects: string[] }[];
    };
    expect(body.sessions[0].subjects).toEqual(["math"]);
  });

  it("collects distinct subjects from a multi-subject batch", async () => {
    mockVerify.mockResolvedValueOnce({ sub: "student-1" });
    mockListSessions.mockResolvedValueOnce({
      sessions: [
        baseSession({
          questions: [
            {
              questionId: 1,
              input: "Q1",
              subject: "math",
              yearLevel: "year-1",
              packet: packet(),
            },
            {
              questionId: 2,
              input: "Q2",
              subject: "science",
              yearLevel: "year-1",
              packet: packet({ questionId: 2 }),
            },
          ],
        }),
      ],
      nextCursor: null,
    });

    const response = (await handler(
      makeEvent({ headers: { authorization: "Bearer valid-token" } }),
      {} as never,
    )) as APIGatewayProxyStructuredResultV2;

    const body = JSON.parse(response.body as string) as {
      sessions: { subjects: string[] }[];
    };
    expect(body.sessions[0].subjects).toEqual(["math", "science"]);
  });

  it("returns empty imageUrls for sessions with no images", async () => {
    mockVerify.mockResolvedValueOnce({ sub: "student-1" });
    mockListSessions.mockResolvedValueOnce({
      sessions: [baseSession()],
      nextCursor: null,
    });

    const response = (await handler(
      makeEvent({ headers: { authorization: "Bearer valid-token" } }),
      {} as never,
    )) as APIGatewayProxyStructuredResultV2;

    const body = JSON.parse(response.body as string) as {
      sessions: { imageUrls: string[] }[];
    };
    expect(body.sessions[0].imageUrls).toEqual([]);
  });

  it("forwards cursor and limit query params to listSessions", async () => {
    mockVerify.mockResolvedValueOnce({ sub: "student-1" });
    mockListSessions.mockResolvedValueOnce({ sessions: [], nextCursor: null });
    const cursor = Buffer.from("10").toString("base64");

    await handler(
      makeEvent({
        headers: { authorization: "Bearer valid-token" },
        queryStringParameters: { type: "homework", cursor, limit: "5" },
      }),
      {} as never,
    );

    expect(mockListSessions).toHaveBeenCalledWith("student-1", "homework", cursor, 5);
  });

  it("fills a history page past questionless Homework sessions", async () => {
    mockVerify.mockResolvedValueOnce({ sub: "student-1" });
    const cursor = Buffer.from("2").toString("base64");
    mockListSessions
      .mockResolvedValueOnce({ sessions: [baseSession({ sessionId: "waiting", questions: [] })], nextCursor: cursor })
      .mockResolvedValueOnce({ sessions: [baseSession({ sessionId: "ready" })], nextCursor: null });

    const response = await handler(makeEvent({ headers: { authorization: "Bearer valid-token" }, queryStringParameters: { type: "homework", limit: "1" } }), {} as never);
    const body = JSON.parse(response.body as string) as { sessions: Array<{ sessionId: string }>; nextCursor: string | null };
    expect(body.sessions.map((session) => session.sessionId)).toEqual(["ready"]);
    expect(mockListSessions).toHaveBeenNthCalledWith(2, "student-1", "homework", cursor, 1);
    expect(body.nextCursor).toBeNull();
  });

  it("projects final Questions without Page Context linkage or submission internals", async () => {
    mockVerify.mockResolvedValueOnce({ sub: "student-1" });
    mockLoadSession.mockResolvedValueOnce(baseSession({
        pages: [{ pageId: "page-secret", imageKey: "image-secret", context: { content: "private worksheet transcription" } }],
        submissions: [{ submissionId: "sub-secret", payloadHash: "hash-secret", timestamp: "2024-01-01T00:00:00Z", pageIds: ["page-secret"], addedQuestionIds: [], updatedQuestionIds: [], possiblyRepeatedQuestionIds: [], usage: ZERO }],
        questions: [{ ...baseSession().questions[0], sourcePageIds: ["page-secret"], revision: 2, possiblyRepeatedOfQuestionId: 9 }],
      }));
    mockGetSignedUrl.mockResolvedValueOnce("signed");
    const response = await handler(makeEvent({ headers: { authorization: "Bearer valid-token" }, queryStringParameters: { type: "homework", sessionId: "batch-abc" } }), {} as never);
    const body = JSON.parse(response.body as string) as Record<string, unknown>;
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("private worksheet transcription");
    expect(serialized).not.toContain("hash-secret");
    expect(serialized).not.toContain("sourcePageIds");
    expect(serialized).toContain("possiblyRepeatedOfQuestionId");
  });

  it("keeps ordered placeholders when one image cannot be presigned", async () => {
    mockVerify.mockResolvedValueOnce({ sub: "student-1" });
    mockLoadSession.mockResolvedValueOnce(baseSession({ imageKeys: ["first", "second"] }));
    mockGetSignedUrl.mockResolvedValueOnce("signed-first").mockRejectedValueOnce(new Error("temporary"));
    const response = await handler(makeEvent({ headers: { authorization: "Bearer valid-token" }, queryStringParameters: { type: "homework", sessionId: "batch-abc" } }), {} as never);
    const body = JSON.parse(response.body as string) as { session: { imageUrls: Array<string | null> } };
    expect(response.statusCode).toBe(200);
    expect(body.session.imageUrls).toEqual(["signed-first", null]);
  });

  it("returns 400 when the type query parameter is missing", async () => {
    mockVerify.mockResolvedValueOnce({ sub: "student-1" });

    const response = (await handler(
      makeEvent({
        headers: { authorization: "Bearer valid-token" },
        queryStringParameters: {},
      }),
      {} as never,
    )) as APIGatewayProxyStructuredResultV2;

    expect(response.statusCode).toBe(400);
  });

  it("returns 400 when the type query parameter is invalid", async () => {
    mockVerify.mockResolvedValueOnce({ sub: "student-1" });

    const response = (await handler(
      makeEvent({
        headers: { authorization: "Bearer valid-token" },
        queryStringParameters: { type: "practice" },
      }),
      {} as never,
    )) as APIGatewayProxyStructuredResultV2;

    expect(response.statusCode).toBe(400);
  });

  it("reads the latest purpose-built Session Detail when a session is selected", async () => {
    mockVerify.mockResolvedValueOnce({ sub: "student-1" });
    mockLoadSession.mockResolvedValueOnce(baseSession({
      sessionId: "batch-abc",
      updatedAt: "2026-08-19T00:00:00Z",
      pages: [
        { pageId: "page-1", imageKey: "first-key", context: { content: "secret first context" } },
        { pageId: "page-2", imageKey: "second-key", context: { content: "secret second context" } },
      ],
      questions: [{
        ...baseSession().questions[0], input: "Latest appended question",
        possiblyRepeatedOfQuestionId: 9, sourcePageIds: ["page-2"],
      }],
    }));
    mockGetSignedUrl.mockResolvedValueOnce("signed-first").mockResolvedValueOnce("signed-second");

    const response = await handler(makeEvent({
      headers: { authorization: "Bearer valid-token" },
      queryStringParameters: { type: "homework", sessionId: "batch-abc" },
    }), {} as never);
    const body = JSON.parse(response.body as string) as { session: { imageUrls: string[]; questions: Array<{ input: string; possiblyRepeatedOfQuestionId?: number }> } };

    expect(response.statusCode).toBe(200);
    expect(mockLoadSession).toHaveBeenCalledWith("student-1", "homework", "batch-abc");
    expect(mockListSessions).not.toHaveBeenCalled();
    expect(body.session.imageUrls).toEqual(["signed-first", "signed-second"]);
    expect(body.session.questions[0]).toMatchObject({ input: "Latest appended question", possiblyRepeatedOfQuestionId: 9 });
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(JSON.stringify(body)).not.toContain("sourcePageIds");
  });

  it("uses one non-enumerating unavailable response for missing selected sessions", async () => {
    mockVerify.mockResolvedValueOnce({ sub: "student-1" });
    mockLoadSession.mockResolvedValueOnce(null);

    const response = await handler(makeEvent({
      headers: { authorization: "Bearer valid-token" },
      queryStringParameters: { type: "homework", sessionId: "missing" },
    }), {} as never);

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body as string)).toEqual({ message: "Session unavailable." });
  });

  it("strips Writing image keys and degrades an unavailable draft image only", async () => {
    mockVerify.mockResolvedValueOnce({ sub: "student-1" });
    mockLoadSession.mockResolvedValueOnce({
      sessionType: "writing", sessionId: "writing-1", studentId: "student-1", modelChoice: "fast",
      timestamp: "2026-08-19T00:00:00Z", updatedAt: "2026-08-19T00:00:00Z", usage: ZERO,
      status: "active", prompt: { input: "Write a story", imageKeys: ["prompt-secret-key"] },
      plan: { assignmentSummary: "Story", genre: "narrative", yearLevel: "year-3", successCriteria: [], planningQuestions: [], coachingApproach: "Plan" },
      turns: [{ kind: "draft", turnIndex: 1, ts: "2026-08-19T00:01:00Z", input: { text: "Draft", imageKeys: ["draft-secret-key"] }, packet: {} }],
      draftCount: 1, questionCount: 0,
    } as never);
    mockGetSignedUrl.mockResolvedValueOnce("signed-prompt").mockRejectedValueOnce(new Error("temporary"));

    const response = await handler(makeEvent({ headers: { authorization: "Bearer valid-token" }, queryStringParameters: { type: "writing", sessionId: "writing-1" } }), {} as never);
    const serialized = response.body as string;
    const body = JSON.parse(serialized) as { session: { turns: Array<{ input: { imageUrls: Array<string | null> } }> } };
    expect(response.statusCode).toBe(200);
    expect(serialized).not.toContain("imageKeys");
    expect(serialized).not.toContain("secret-key");
    expect(body.session.turns[0].input.imageUrls).toEqual([null]);
  });

  it("returns every Practice summary under its Question in recent-activity order", async () => {
    mockVerify.mockResolvedValueOnce({ sub: "student-1" });
    mockLoadSession.mockResolvedValueOnce(baseSession());
    mockListPracticeSessions.mockResolvedValueOnce([
      { sessionId: "old", origin: { sessionId: "batch-abc", questionId: 1 }, status: "ended", problemCount: 2, updatedAt: "2026-08-18T00:00:00Z", usage: ZERO, modelChoice: "fast", finalSummary: "Good progress" },
      { sessionId: "new", origin: { sessionId: "batch-abc", questionId: 1 }, status: "active", problemCount: 1, updatedAt: "2026-08-19T00:00:00Z", usage: ZERO, modelChoice: "advanced" },
    ]);

    const response = await handler(makeEvent({ headers: { authorization: "Bearer valid-token" }, queryStringParameters: { type: "homework", sessionId: "batch-abc" } }), {} as never);
    const body = JSON.parse(response.body as string) as { session: { questions: Array<{ practiceSessions: Array<{ status: string; updatedAt: string }> }> } };
    expect(body.session.questions[0].practiceSessions.map((practice) => practice.updatedAt)).toEqual([
      "2026-08-19T00:00:00Z", "2026-08-18T00:00:00Z",
    ]);
    expect(body.session.questions[0].practiceSessions[1]).toMatchObject({ modelChoice: "fast", finalSummary: "Good progress" });
  });
});
