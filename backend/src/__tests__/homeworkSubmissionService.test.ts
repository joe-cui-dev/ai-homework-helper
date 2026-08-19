import { processHomeworkSubmission, HomeworkSubmissionError, type HomeworkSubmissionDependencies } from "../homework/submissionService";
import type { HomeworkSession } from "../shared/session";

const ZERO = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
const packet = (questionId: number) => ({ questionId, tldrAnswer: "answer", whyItWorks: "why", childHint: "hint" });
const baseSession = (): HomeworkSession => ({
  sessionType: "homework", sessionId: "session-1", studentId: "student-1", modelChoice: "advanced",
  timestamp: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z", usage: ZERO,
  pages: [{ pageId: "old-1", imageKey: "owned-key", context: { content: "old context" } }], submissions: [],
  questions: [{ questionId: 4, input: "Old question", subject: "math", yearLevel: "year-3", sourcePageIds: ["old-1"], packet: packet(4) }],
});

const dependencies = (): jest.Mocked<HomeworkSubmissionDependencies> => ({
  loadSessionWithVersion: jest.fn().mockResolvedValue({ session: baseSession(), eTag: '"session-v1"' }),
  saveSession: jest.fn().mockResolvedValue(undefined), saveSessionIfVersion: jest.fn().mockResolvedValue(undefined),
  acquireClaim: jest.fn().mockResolvedValue({ kind: "acquired", eTag: '"claim-v1"', claim: { status: "processing", payloadHash: "payload-hash", ownerAttemptId: "attempt-1", leaseExpiresAt: "2026-08-19T00:07:00.000Z", updatedAt: "2026-08-19T00:00:00.000Z", version: 1 } }),
  updateClaim: jest.fn().mockResolvedValue('"claim-v2"'),
  analyze: jest.fn().mockResolvedValue({
    newPageContexts: [{ pageId: "submission-sub-1-page-0", content: "new context" }],
    candidates: [{ text: "New question", subject: "science", yearLevel: "year-4", sourcePageIds: ["submission-sub-1-page-0"], relation: { kind: "new", confidence: "high" } }],
    usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.001 }, fallbackPageIds: [],
  }),
  generatePackets: jest.fn().mockResolvedValue({ packets: [packet(5)], usage: { inputTokens: 4, outputTokens: 3, costUsd: 0.002 } }),
  uploadInitialImages: jest.fn().mockResolvedValue(["initial-key"]),
  uploadAppendImages: jest.fn().mockResolvedValue(["append-key"]), loadImage: jest.fn().mockResolvedValue({ mediaType: "image/jpeg", data: new Uint8Array([1]) }),
  now: jest.fn(() => new Date("2026-08-19T00:00:00.000Z")), newSessionId: jest.fn().mockReturnValue("session-new"), newAttemptId: jest.fn().mockReturnValue("attempt-1"), hashImages: jest.fn().mockReturnValue("payload-hash"),
});

describe("processHomeworkSubmission", () => {
  it("owns the claim before append analysis and commits all state once", async () => {
    const deps = dependencies();
    const event = await processHomeworkSubmission({ studentId: "student-1", request: { kind: "append_pages", sessionId: "session-1", submissionId: "sub-1", images: ["data:image/jpeg;base64,abc"] }, emit: jest.fn(), deps });

    expect(deps.acquireClaim.mock.invocationCallOrder[0]).toBeLessThan(deps.analyze.mock.invocationCallOrder[0]);
    expect(deps.analyze).toHaveBeenCalledWith(expect.objectContaining({ modelChoice: "advanced", priorPages: [{ pageId: "old-1", content: "old context" }] }));
    expect(deps.generatePackets).toHaveBeenCalledWith([expect.objectContaining({ questionId: 5, sourcePageIds: ["submission-sub-1-page-0"] })], expect.arrayContaining([{ pageId: "old-1", content: "old context" }, { pageId: "submission-sub-1-page-0", content: "new context" }]), "advanced");
    const saved = deps.saveSessionIfVersion.mock.calls[0][0] as HomeworkSession;
    expect(saved.pages?.map((page) => page.context.content)).toEqual(["old context", "new context"]);
    expect(saved.usage).toEqual({ inputTokens: 14, outputTokens: 5, costUsd: 0.003 });
    expect(event).toMatchObject({ type: "complete", pageCount: 2, questionCount: 2, hasNoCompleteQuestions: false });
  });

  it("replays a committed submission without claim, AI, upload, or added usage", async () => {
    const deps = dependencies();
    const session = baseSession();
    session.submissions = [{ submissionId: "sub-1", payloadHash: "payload-hash", timestamp: session.updatedAt, pageIds: [], addedQuestionIds: [], updatedQuestionIds: [4], possiblyRepeatedQuestionIds: [], usage: { inputTokens: 9, outputTokens: 2, costUsd: 0.01 } }];
    deps.loadSessionWithVersion.mockResolvedValue({ session, eTag: '"v2"' });

    const emit = jest.fn();
    const event = await processHomeworkSubmission({ studentId: "student-1", request: { kind: "append_pages", sessionId: "session-1", submissionId: "sub-1", images: ["data:image/jpeg;base64,abc"] }, emit, deps });
    expect(event.updatedQuestionIds).toEqual([4]);
    expect(deps.acquireClaim).not.toHaveBeenCalled();
    expect(deps.analyze).not.toHaveBeenCalled();
    expect(deps.uploadAppendImages).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(event);
  });

  it("replays before evaluating limits when the committed result filled the Session", async () => {
    const deps = dependencies();
    const session = baseSession();
    session.pages = Array.from({ length: 10 }, (_, index) => ({ pageId: `page-${index}`, imageKey: `key-${index}`, context: { content: `context-${index}` } }));
    session.questions = Array.from({ length: 30 }, (_, index) => ({ ...baseSession().questions[0], questionId: index + 1, packet: packet(index + 1) }));
    session.submissions = [{ submissionId: "sub-1", payloadHash: "payload-hash", timestamp: session.updatedAt, pageIds: ["page-9"], addedQuestionIds: [30], updatedQuestionIds: [], possiblyRepeatedQuestionIds: [], usage: ZERO }];
    deps.loadSessionWithVersion.mockResolvedValue({ session, eTag: '"v2"' });

    await expect(processHomeworkSubmission({ studentId: "student-1", request: { kind: "append_pages", sessionId: "session-1", submissionId: "sub-1", images: ["data:image/jpeg;base64,abc"] }, emit: jest.fn(), deps })).resolves.toMatchObject({ pageCount: 10, questionCount: 30 });
    expect(deps.acquireClaim).not.toHaveBeenCalled();
  });

  it("returns retryable in-progress and never starts AI for a live duplicate", async () => {
    const deps = dependencies();
    deps.acquireClaim.mockResolvedValue({ kind: "in_progress", claim: { status: "processing", payloadHash: "payload-hash", ownerAttemptId: "other", leaseExpiresAt: "2026-08-19T00:07:00.000Z", updatedAt: "2026-08-19T00:00:00.000Z", version: 1 } });
    await expect(processHomeworkSubmission({ studentId: "student-1", request: { kind: "append_pages", sessionId: "session-1", submissionId: "sub-1", images: ["data:image/jpeg;base64,abc"] }, emit: jest.fn(), deps })).rejects.toMatchObject({ code: "in_progress", retryable: true });
    expect(deps.analyze).not.toHaveBeenCalled();
  });

  it.each(["../claim", "path/claim", "作業", "line\nbreak", `x${"a".repeat(128)}`])(
    "rejects unsafe submission IDs before storage or model work: %j",
    async (submissionId) => {
      const deps = dependencies();
      await expect(processHomeworkSubmission({
        studentId: "student-1",
        request: { kind: "append_pages", sessionId: "session-1", submissionId, images: ["data:image/jpeg;base64,abc"] },
        emit: jest.fn(), deps,
      })).rejects.toThrow("Submission ID");
      expect(deps.loadSessionWithVersion).not.toHaveBeenCalled();
      expect(deps.acquireClaim).not.toHaveBeenCalled();
      expect(deps.analyze).not.toHaveBeenCalled();
    },
  );

  it("leaves the prior Session authoritative and marks the claim failed on pre-commit failure", async () => {
    const deps = dependencies();
    deps.uploadAppendImages.mockRejectedValue(new Error("upload failed"));
    await expect(processHomeworkSubmission({ studentId: "student-1", request: { kind: "append_pages", sessionId: "session-1", submissionId: "sub-1", images: ["data:image/jpeg;base64,abc"] }, emit: jest.fn(), deps })).rejects.toThrow("upload failed");
    expect(deps.saveSessionIfVersion).not.toHaveBeenCalled();
    expect(deps.updateClaim).toHaveBeenCalledWith(expect.objectContaining({ claim: expect.objectContaining({ status: "failed" }) }));
  });

  it("reloads a conditional conflict and replays if another attempt committed", async () => {
    const deps = dependencies();
    deps.saveSessionIfVersion.mockRejectedValue(Object.assign(new Error("conflict"), { code: "conflict" }));
    const committed = baseSession();
    committed.submissions = [{ submissionId: "sub-1", payloadHash: "payload-hash", timestamp: committed.updatedAt, pageIds: [], addedQuestionIds: [], updatedQuestionIds: [], possiblyRepeatedQuestionIds: [], usage: ZERO }];
    deps.loadSessionWithVersion.mockResolvedValueOnce({ session: baseSession(), eTag: '"v1"' }).mockResolvedValueOnce({ session: committed, eTag: '"v2"' });
    const emit = jest.fn();
    const event = await processHomeworkSubmission({ studentId: "student-1", request: { kind: "append_pages", sessionId: "session-1", submissionId: "sub-1", images: ["data:image/jpeg;base64,abc"] }, emit, deps });
    expect(event).toMatchObject({ type: "complete", sessionId: "session-1" });
    expect(emit).toHaveBeenCalledWith(event);
  });

  it("publishes an initial waiting Session only after analysis, images, and save succeed", async () => {
    const deps = dependencies();
    deps.newSessionId.mockReturnValueOnce("session-new");
    deps.analyze.mockResolvedValue({ newPageContexts: [{ pageId: "initial-page-0", content: "cover context" }], candidates: [], usage: ZERO, fallbackPageIds: [] });
    deps.generatePackets.mockResolvedValue({ packets: [], usage: ZERO });
    const event = await processHomeworkSubmission({ studentId: "student-1", request: { kind: "initial", question: "", images: ["data:image/jpeg;base64,abc"], modelChoice: "fast" }, emit: jest.fn(), deps });
    expect(deps.saveSession).toHaveBeenCalledWith(expect.objectContaining({ pages: [expect.objectContaining({ context: { content: "cover context" } })], questions: [] }));
    expect(event).toMatchObject({ hasNoCompleteQuestions: true, questionCount: 0, pageCount: 1 });
  });
});

void HomeworkSubmissionError;
