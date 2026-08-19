import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../types";
import { HistorySidebar } from "./HistorySidebar";

const mocks = vi.hoisted(() => ({
  fetchSessionDetail: vi.fn(),
  removeSession: vi.fn(),
}));

const oldSession: SessionSummary = {
  sessionId: "session-1",
  timestamp: "2026-08-18T00:00:00Z",
  updatedAt: "2026-08-18T00:00:00Z",
  sessionType: "homework",
  modelChoice: "fast",
  subjects: ["math"],
  imageUrls: ["old-first", "old-second"],
  questions: [{
    questionId: 1, input: "Old question", subject: "math", yearLevel: "year-3",
    packet: { questionId: 1, tldrAnswer: "old", whyItWorks: "old why", childHint: "old hint" },
  }],
};

vi.mock("../hooks/useSessionHistory", () => ({
  useSessionHistory: () => ({
    sessions: [oldSession], loading: false, loadingMore: false, error: null,
    nextCursor: null, loadMore: vi.fn(), removeSession: mocks.removeSession,
  }),
}));
vi.mock("../services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/api")>()),
  fetchSessionDetail: mocks.fetchSessionDetail,
}));

describe("HistorySidebar", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows one representative card thumbnail and fetches latest detail on selection", async () => {
    const latest = {
      ...oldSession,
      updatedAt: "2026-08-19T00:00:00Z",
      imageUrls: ["latest-first", "latest-second", "latest-third"],
      questions: [{
        ...oldSession.questions[0], input: "Latest appended question",
        possiblyRepeatedOfQuestionId: 9,
      }],
    };
    mocks.fetchSessionDetail.mockResolvedValue(latest);
    render(<MemoryRouter><HistorySidebar token="token" module="homework" open onClose={vi.fn()} /></MemoryRouter>);

    expect(screen.getAllByRole("img", { name: /Upload/ })).toHaveLength(1);
    expect(screen.getByText("2 images")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Old question"));
    expect(await screen.findByText("Latest appended question")).toBeInTheDocument();
    expect(screen.getByText("Possibly repeated")).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: /Upload/ })).toHaveLength(4);
    expect(mocks.fetchSessionDetail).toHaveBeenCalledWith("token", "homework", "session-1");
  });

  it("removes a stale card when selected detail is unavailable", async () => {
    mocks.fetchSessionDetail.mockRejectedValue(Object.assign(new Error("Session unavailable."), { status: 404 }));
    render(<MemoryRouter><HistorySidebar token="token" module="homework" open onClose={vi.fn()} /></MemoryRouter>);
    await userEvent.click(screen.getByText("Old question"));

    await waitFor(() => expect(mocks.removeSession).toHaveBeenCalledWith("session-1"));
    expect(await screen.findByText("Session unavailable.")).toBeInTheDocument();
  });
});
