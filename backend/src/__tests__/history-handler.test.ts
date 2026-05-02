import type { APIGatewayProxyEventV2 } from "aws-lambda";

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock("aws-jwt-verify", () => ({
  CognitoJwtVerifier: {
    create: jest.fn(() => ({ verify: mockVerify })),
  },
}));

jest.mock("../storage", () => ({
  listSessions: jest.fn(),
}));

jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn(),
}));

jest.mock("@aws-sdk/client-s3", () => {
  const sendMock = jest.fn();
  return {
    S3Client: jest.fn(() => ({ send: sendMock })),
    GetObjectCommand: jest.fn((input: unknown) => input),
    _sendMock: sendMock,
  };
});

jest.mock("../logger", () => ({
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
import { handler } from "../history-handler";
import { listSessions } from "../storage";
import type { SessionRecord } from "../storage";
import type { CoachingPacket } from "../types";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const mockListSessions = listSessions as jest.MockedFunction<typeof listSessions>;
const mockGetSignedUrl = getSignedUrl as jest.MockedFunction<typeof getSignedUrl>;

process.env.COGNITO_USER_POOL_ID = "us-east-1_test";
process.env.COGNITO_APP_CLIENT_ID = "test-client";
process.env.S3_BUCKET_NAME = "test-bucket";

function makeEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    headers: {},
    queryStringParameters: {},
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
  subject: "math",
  yearLevel: "year-1",
  tldrAnswer: "4",
  whyItWorks: "Adding two pairs of items totals four.",
  howToCoach: "Use counters to model the sum together.",
  watchFor: ["Skipping a counter"],
  childHint: "What number comes after three?",
  ...overrides,
});

const baseSession: SessionRecord = {
  sessionId: "batch-abc",
  timestamp: "2024-01-01T00:00:00Z",
  questions: [{ questionId: 1, input: "What is 2+2?", packet: packet() }],
};

beforeEach(() => {
  jest.clearAllMocks();
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

  it("returns sessions with pre-signed imageUrls and subjects derived from packet.subject", async () => {
    mockVerify.mockResolvedValueOnce({ sub: "student-1" });
    mockListSessions.mockResolvedValueOnce({
      sessions: [
        {
          ...baseSession,
          imageKeys: ["sessions/student-1/batch-abc/image-0.jpeg"],
        },
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
        subjects: string[];
        questions: { input: string; packet: CoachingPacket }[];
      }[];
      nextCursor: null;
    };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].imageUrls).toEqual([
      "https://s3.example.com/presigned-url",
    ]);
    expect(body.sessions[0].subjects).toEqual(["math"]);
    expect(body.sessions[0].questions[0].input).toBe("What is 2+2?");
    expect(body.sessions[0].questions[0].packet.tldrAnswer).toBe("4");
    expect(body.nextCursor).toBeNull();
  });

  it("deduplicates subjects when multiple questions share the same subject", async () => {
    mockVerify.mockResolvedValueOnce({ sub: "student-1" });
    mockListSessions.mockResolvedValueOnce({
      sessions: [
        {
          ...baseSession,
          questions: [
            { questionId: 1, input: "Q1", packet: packet({ subject: "math" }) },
            {
              questionId: 2,
              input: "Q2",
              packet: packet({ questionId: 2, subject: "math" }),
            },
          ],
        },
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
        {
          ...baseSession,
          questions: [
            { questionId: 1, input: "Q1", packet: packet({ subject: "math" }) },
            {
              questionId: 2,
              input: "Q2",
              packet: packet({ questionId: 2, subject: "science" }),
            },
          ],
        },
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
      sessions: [baseSession],
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
        queryStringParameters: { cursor, limit: "5" },
      }),
      {} as never,
    );

    expect(mockListSessions).toHaveBeenCalledWith("student-1", cursor, 5);
  });
});
