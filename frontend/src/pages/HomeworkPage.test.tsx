import { MemoryRouter } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HomeworkPage } from "./HomeworkPage";

const { mockUseHomeworkStream } = vi.hoisted(() => ({ mockUseHomeworkStream: vi.fn() }));
vi.mock("../hooks/useHomeworkStream", () => ({ useHomeworkStream: mockUseHomeworkStream }));
vi.mock("../components/ModuleHistoryButton", () => ({ ModuleHistoryButton: () => null }));

const state = (overrides = {}) => ({
  status: "done", sessionId: "session-1", packets: [{
    questionId: 1, questionText: "Visible old question", subject: "math", yearLevel: "year-3",
    packet: { questionId: 1, tldrAnswer: "4", whyItWorks: "why", childHint: "hint" },
  }], pending: [], totalQuestions: 1, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 }, modelChoice: "fast",
  error: null, appendStatus: "idle", appendError: null, updatedQuestionIds: [], possiblyRepeatedQuestionIds: [], clearAppendError: vi.fn(),
  appendNotice: null,
  pageCount: 1, hasNoCompleteQuestions: false, submit: vi.fn(), stop: vi.fn(), append: vi.fn(), reset: vi.fn(),
  ...overrides,
});

describe("HomeworkPage append behavior", () => {
  beforeEach(() => mockUseHomeworkStream.mockReset());

  it("keeps results visible and disables competing actions while saving", () => {
    mockUseHomeworkStream.mockReturnValue(state({ appendStatus: "saving" }));
    render(<MemoryRouter><HomeworkPage token="token" /></MemoryRouter>);
    expect(screen.getByText("Visible old question")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Coach another question" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Stop processing/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Practice this question/i })).not.toBeInTheDocument();
  });

  it("shows the question-limit explanation instead of an append input", () => {
    mockUseHomeworkStream.mockReturnValue(state({ totalQuestions: 30 }));
    render(<MemoryRouter><HomeworkPage token="token" /></MemoryRouter>);
    expect(screen.getByText(/30-question limit/)).toBeInTheDocument();
    expect(screen.queryByText("Add worksheet photos")).not.toBeInTheDocument();
  });

  it("invites the next page for a context-only waiting Session", () => {
    mockUseHomeworkStream.mockReturnValue(state({ packets: [], totalQuestions: 0, hasNoCompleteQuestions: true }));
    render(<MemoryRouter><HomeworkPage token="token" /></MemoryRouter>);
    expect(screen.getByText(/add the next worksheet page/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Add more pages" })).toBeInTheDocument();
  });

  it("announces a context-only append outcome", () => {
    mockUseHomeworkStream.mockReturnValue(state({ appendNotice: "Pages added as context; no complete questions changed." }));
    render(<MemoryRouter><HomeworkPage token="token" /></MemoryRouter>);
    expect(screen.getByText(/Pages added as context/)).toHaveAttribute("role", "status");
  });
});
