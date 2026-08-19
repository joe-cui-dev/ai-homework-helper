import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHomeworkStream } from "./useHomeworkStream";
import type { BatchPacket, StreamEvent } from "../types";

const mocks = vi.hoisted(() => ({ streamHomework: vi.fn(), appendHomeworkPages: vi.fn() }));
vi.mock("../services/homeworkApi", () => mocks);

const oldPacket = { questionId: 1, questionText: "Old", subject: "math" as const, yearLevel: "year-3" as const, packet: { questionId: 1, tldrAnswer: "4", whyItWorks: "why", childHint: "hint" } };
const newPacket = { questionId: 2, questionText: "New", subject: "science" as const, yearLevel: "year-4" as const, packet: { questionId: 2, tldrAnswer: "leaf", whyItWorks: "why", childHint: "hint" } };
const complete = (packets: BatchPacket[] = [oldPacket], overrides: Partial<Extract<StreamEvent, { type: "complete" }>> = {}): Extract<StreamEvent, { type: "complete" }> => ({
  type: "complete", sessionId: "session-1", packets, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 }, modelChoice: "fast",
  pageCount: 1, questionCount: packets.length, updatedQuestionIds: [], possiblyRepeatedQuestionIds: [], hasNoCompleteQuestions: packets.length === 0,
  ...overrides,
});

describe("useHomeworkStream append", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.streamHomework.mockImplementation(async (_q, _t, onEvent: (event: StreamEvent) => void) => onEvent(complete()));
  });

  it("keeps existing results until the authoritative append completion", async () => {
    let release!: () => void;
    mocks.appendHomeworkPages.mockImplementation(async (_s, _id, _images, _token, onEvent: (event: StreamEvent) => void) => {
      onEvent({ type: "append_phase", phase: "generating" });
      await new Promise<void>((resolve) => { release = resolve; });
      onEvent(complete([oldPacket, newPacket], { pageCount: 2, questionCount: 2, updatedQuestionIds: [1] }));
    });
    const { result } = renderHook(() => useHomeworkStream());
    await act(() => result.current.submit("", "token", ["image"]));

    let appendPromise!: Promise<void>;
    act(() => { appendPromise = result.current.append("token", ["new-image"], "submission-1"); });
    expect(result.current.packets).toEqual([oldPacket]);
    expect(result.current.appendStatus).toBe("generating");

    await act(async () => { release(); await appendPromise; });
    expect(result.current.packets).toEqual([oldPacket, newPacket]);
    expect(result.current.pageCount).toBe(2);
    expect(result.current.updatedQuestionIds).toEqual([1]);
    expect(result.current.appendNotice).toBe("Pages added and coaching updated.");
  });

  it("confirms a context-only append without changing existing coaching", async () => {
    mocks.appendHomeworkPages.mockImplementation(async (_s, _id, _images, _token, onEvent: (event: StreamEvent) => void) => {
      onEvent(complete([oldPacket], { pageCount: 2, questionCount: 1 }));
    });
    const { result } = renderHook(() => useHomeworkStream());
    await act(() => result.current.submit("", "token", ["image"]));
    await act(() => result.current.append("token", ["new-image"], "submission-1"));
    expect(result.current.packets).toEqual([oldPacket]);
    expect(result.current.pageCount).toBe(2);
    expect(result.current.appendNotice).toBe("Pages added as context; no complete questions changed.");
  });

  it("keeps the committed view unchanged after an append error", async () => {
    mocks.appendHomeworkPages.mockImplementation(async (_s, _id, _images, _token, onEvent: (event: StreamEvent) => void) => {
      onEvent({ type: "error", code: "processing_failure", retryable: true, message: "Try again" });
    });
    const { result } = renderHook(() => useHomeworkStream());
    await act(() => result.current.submit("", "token", ["image"]));
    await act(() => result.current.append("token", ["new-image"], "submission-1"));
    expect(result.current.packets).toEqual([oldPacket]);
    expect(result.current.pageCount).toBe(1);
    expect(result.current.appendStatus).toBe("error");
    expect(result.current.appendError).toBe("Try again");
  });

  it("turns append EOF after saving into a retryable error without replacing results", async () => {
    mocks.appendHomeworkPages.mockImplementation(async (_s, _id, _images, _token, onEvent: (event: StreamEvent) => void) => {
      onEvent({ type: "append_phase", phase: "saving" });
      throw new Error("The response stream ended before a terminal event.");
    });
    const { result } = renderHook(() => useHomeworkStream());
    await act(() => result.current.submit("", "token", ["image"]));
    await act(() => result.current.append("token", ["new-image"], "submission-1"));

    expect(result.current.packets).toEqual([oldPacket]);
    expect(result.current.appendStatus).toBe("error");
    expect(result.current.appendError).toContain("terminal event");
  });

  it("does not mark an initial request done when the stream has no completion", async () => {
    mocks.streamHomework.mockRejectedValueOnce(new Error("The response stream ended before a terminal event."));
    const { result } = renderHook(() => useHomeworkStream());

    await act(() => result.current.submit("", "token", ["image"]));

    expect(result.current.status).toBe("error");
    expect(result.current.error).toContain("terminal event");
  });
});
