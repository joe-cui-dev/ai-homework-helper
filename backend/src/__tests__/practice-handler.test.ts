import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { Writable } from "stream";

// ── Mocks ─────────────────────────────────────────────────────────────────

jest.mock("aws-jwt-verify", () => ({
  CognitoJwtVerifier: {
    create: jest.fn(() => ({ verify: mockVerify })),
  },
}));

jest.mock("../practice/practice", () => ({
  runPracticeTurn: jest.fn(),
}));

jest.mock("../practice/practiceStorage", () => ({
  createPracticeBundle: jest.fn(),
  loadPracticeBundle: jest.fn(),
  savePracticeBundle: jest.fn(),
}));

jest.mock("../shared/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    addContext: jest.fn(),
    appendKeys: jest.fn(),
    resetKeys: jest.fn(),
  },
}));

// awslambda global shim — Jest doesn't have the streamifyResponse runtime.
const collected: string[] = [];
class CollectStream extends Writable {
  setContentType(_t: string) {
    // no-op
  }
  _write(chunk: Buffer, _enc: string, cb: () => void) {
    collected.push(chunk.toString());
    cb();
  }
}
const makeStream = () => new CollectStream();
(globalThis as unknown as { awslambda: unknown }).awslambda = {
  streamifyResponse: <T,>(fn: T) => fn,
  HttpResponseStream: { from: (s: unknown) => s },
};

const mockVerify = jest.fn();

import type { Context } from "aws-lambda";
import { handler } from "../practice/handler";
import { runPracticeTurn } from "../practice/practice";
import {
  createPracticeBundle,
  loadPracticeBundle,
  savePracticeBundle,
} from "../practice/practiceStorage";
import type { CoachingPacket } from "../shared/types";
import type { PracticeSession } from "../shared/session";
import type { AgentSidecar } from "../shared/sessionStore";

const mockRunPracticeTurn = runPracticeTurn as jest.MockedFunction<typeof runPracticeTurn>;
const mockCreate = createPracticeBundle as jest.MockedFunction<typeof createPracticeBundle>;
const mockLoad = loadPracticeBundle as jest.MockedFunction<typeof loadPracticeBundle>;
const mockSave = savePracticeBundle as jest.MockedFunction<typeof savePracticeBundle>;

const PACKET: CoachingPacket = {
  questionId: 1,
  tldrAnswer: "12",
  whyItWorks: "Adding.",
  childHint: "?",
};

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

const session = (overrides: Partial<PracticeSession> = {}): PracticeSession => ({
  sessionType: "practice",
  sessionId: "prac-uuid",
  studentId: "student-1",
  modelChoice: "fast",
  timestamp: "2026-05-01T00:00:00Z",
  updatedAt: "2026-05-01T00:00:00Z",
  usage: ZERO_USAGE,
  status: "active",
  origin: { sessionId: "home-1", questionId: 1 },
  subject: "math",
  yearLevel: "year-3",
  sourceCoachingPacket: PACKET,
  problemCount: 0,
  toolCallCount: 0,
  problems: [],
  toolLog: [],
  ...overrides,
});

const sidecar = (): AgentSidecar => ({ bedrockMessages: [], usagePerTurn: [] });

const bundle = (overrides: Partial<PracticeSession> = {}) => ({
  session: session(overrides),
  sidecar: sidecar(),
});

const event = (
  rawPath: string,
  body: Record<string, unknown>,
  authHeader = "Bearer good-token",
): APIGatewayProxyEventV2 =>
  ({
    rawPath,
    headers: { authorization: authHeader },
    body: JSON.stringify(body),
    requestContext: {} as APIGatewayProxyEventV2["requestContext"],
    version: "2.0",
    routeKey: "$default",
    rawQueryString: "",
    isBase64Encoded: false,
    queryStringParameters: {},
  }) as APIGatewayProxyEventV2;

beforeEach(() => {
  jest.clearAllMocks();
  collected.length = 0;
  process.env.COGNITO_USER_POOL_ID = "us-east-1_test";
  process.env.COGNITO_APP_CLIENT_ID = "test-client";
  process.env.S3_BUCKET_NAME = "test-bucket";
});

const lastEvent = (): Record<string, unknown> => {
  const lines = collected.join("").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
};

const allEvents = (): Record<string, unknown>[] =>
  collected
    .join("")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("practice-handler routing", () => {
  it("returns error event when Authorization missing", async () => {
    await handler(event("/practice/turn", {}, ""), makeStream() as never, {} as Context);
    expect(lastEvent().type).toBe("error");
    expect(lastEvent().message).toMatch(/Authorization/);
  });

  it("returns error event when JWT invalid", async () => {
    mockVerify.mockRejectedValueOnce(new Error("bad"));
    await handler(
      event("/practice/turn", { sessionId: "prac-uuid" }),
      makeStream() as never,
      {} as Context,
    );
    expect(lastEvent().type).toBe("error");
    expect(lastEvent().message).toMatch(/Invalid/);
  });

  it("/practice/start creates session from origin and runs an opening turn", async () => {
    mockVerify.mockResolvedValueOnce({ sub: "student-1" });
    const created = bundle();
    mockCreate.mockResolvedValueOnce(created);
    mockRunPracticeTurn.mockResolvedValueOnce({
      session: created.session,
      agentMessage: "Let's start.",
      problem: "5+7",
      isSessionEnded: false,
      turnUsage: ZERO_USAGE,
    });

    await handler(
      event("/practice/start", { originSessionId: "home-1", questionId: 1 }),
      makeStream() as never,
      {} as Context,
    );

    expect(mockCreate).toHaveBeenCalledWith({
      studentId: "student-1",
      originSessionId: "home-1",
      originQuestionId: 1,
    });
    expect(mockRunPracticeTurn).toHaveBeenCalled();
    expect(mockSave).toHaveBeenCalled();
    const final = lastEvent();
    expect(final.type).toBe("turn_complete");
    expect(final.problem).toBe("5+7");
  });

  it("/practice/start surfaces creation failure as an error event", async () => {
    mockVerify.mockResolvedValueOnce({ sub: "student-1" });
    mockCreate.mockRejectedValueOnce(new Error("Question 1 not found in session home-1."));

    await handler(
      event("/practice/start", { originSessionId: "home-1", questionId: 1 }),
      makeStream() as never,
      {} as Context,
    );

    expect(lastEvent().type).toBe("error");
    expect(lastEvent().message).toMatch(/not found/);
    expect(mockRunPracticeTurn).not.toHaveBeenCalled();
  });

  it("/practice/turn loads bundle and runs the agent with parentMessage", async () => {
    mockVerify.mockResolvedValueOnce({ sub: "student-1" });
    const loaded = bundle();
    mockLoad.mockResolvedValueOnce(loaded);
    mockRunPracticeTurn.mockResolvedValueOnce({
      session: loaded.session,
      agentMessage: "Try this next.",
      problem: "8+6",
      isSessionEnded: false,
      turnUsage: ZERO_USAGE,
    });

    await handler(
      event("/practice/turn", {
        sessionId: "prac-uuid",
        parentMessage: "kid said 12",
      }),
      makeStream() as never,
      {} as Context,
    );

    expect(mockRunPracticeTurn).toHaveBeenCalledWith(
      loaded.session,
      loaded.sidecar,
      expect.objectContaining({ parentMessage: "kid said 12", forceEndSession: false }),
    );
    expect(mockSave).toHaveBeenCalled();
    expect(lastEvent().type).toBe("turn_complete");
  });

  it("/practice/turn rejects if session is already ended", async () => {
    mockVerify.mockResolvedValueOnce({ sub: "student-1" });
    mockLoad.mockResolvedValueOnce({
      session: session({ status: "ended", endedReason: "mastered" }),
      sidecar: sidecar(),
    });

    await handler(
      event("/practice/turn", {
        sessionId: "prac-uuid",
        parentMessage: "more please",
      }),
      makeStream() as never,
      {} as Context,
    );

    expect(mockRunPracticeTurn).not.toHaveBeenCalled();
    expect(lastEvent().type).toBe("error");
    expect(lastEvent().message).toMatch(/already ended/);
  });

  it("/practice/end calls runPracticeTurn with forceEndSession", async () => {
    mockVerify.mockResolvedValueOnce({ sub: "student-1" });
    const loaded = bundle();
    mockLoad.mockResolvedValueOnce(loaded);
    mockRunPracticeTurn.mockResolvedValueOnce({
      session: { ...loaded.session, status: "ended", endedReason: "abandoned" },
      agentMessage: "Recap…",
      isSessionEnded: true,
      endedReason: "abandoned",
      finalSummary: "Parent ended early.",
      turnUsage: ZERO_USAGE,
    });

    await handler(
      event("/practice/end", { sessionId: "prac-uuid" }),
      makeStream() as never,
      {} as Context,
    );

    expect(mockRunPracticeTurn).toHaveBeenCalledWith(
      loaded.session,
      loaded.sidecar,
      expect.objectContaining({ forceEndSession: true }),
    );
    const final = lastEvent();
    expect(final.type).toBe("turn_complete");
    expect(final.isSessionEnded).toBe(true);
    expect(final.endedReason).toBe("abandoned");
    expect(final.finalSummary).toMatch(/Parent ended/);
  });

  it("rejects unknown routes with an error event", async () => {
    mockVerify.mockResolvedValueOnce({ sub: "student-1" });
    await handler(
      event("/practice/bogus", {}),
      makeStream() as never,
      {} as Context,
    );
    const events = allEvents();
    expect(events[events.length - 1].type).toBe("error");
    expect(events[events.length - 1].message).toMatch(/Unknown route/);
  });
});
