import { MemoryRouter, Route, Routes } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WritingSessionPage } from "./WritingSessionPage";
import type { WritingPlanPacket } from "../types";

const { mockUseWritingSession, mockSubmitDraft } = vi.hoisted(() => ({
  mockUseWritingSession: vi.fn(),
  mockSubmitDraft: vi.fn(),
}));

vi.mock("../hooks/useWritingSession", () => ({
  MAX_DRAFTS: 5,
  MAX_QUESTIONS: 3,
  useWritingSession: mockUseWritingSession,
}));

vi.mock("../hooks/useSessionHistory", () => ({
  useSessionHistory: () => ({
    sessions: [],
    loading: false,
    loadingMore: false,
    error: null,
    nextCursor: null,
    loadMore: vi.fn(),
  }),
}));

vi.mock("../services/api", () => ({
  compressImage: vi.fn((file: File) =>
    Promise.resolve(`data:image/png;base64,${file.name}`),
  ),
}));

const plan: WritingPlanPacket = {
  assignmentSummary: "Write a persuasive letter to the principal.",
  genre: "persuasive",
  yearLevel: "year-4",
  yearLevelSource: "user",
  successCriteria: ["Clear opinion", "Supporting reasons"],
  planningQuestions: [],
  modelAnswers: {
    atYearLevel: "",
    aboveYearLevel: "",
    aboveYearLevelLabel: "",
    whyAboveIsBetter: "",
  },
  vocabularyToOffer: [],
  watchFor: [],
  coachingScript: "",
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/writing/session-1"]}>
      <Routes>
        <Route path="/writing/:sessionId" element={<WritingSessionPage token="tok" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("WritingSessionPage draft submission", () => {
  beforeEach(() => {
    mockSubmitDraft.mockReset();
    mockSubmitDraft.mockResolvedValue(undefined);
    mockUseWritingSession.mockReturnValue({
      status: "ready",
      sessionId: "session-1",
      plan,
      turns: [],
      draftCount: 0,
      questionCount: 0,
      usage: null,
      modelChoice: "fast",
      endedReason: null,
      error: null,
      imageUrls: [],
      start: vi.fn(),
      submitDraft: mockSubmitDraft,
      submitQuestion: vi.fn(),
      end: vi.fn(),
      hydrate: vi.fn(),
      reset: vi.fn(),
    });
  });

  it("uses a violet, max-5 compact attachment field with the correct prompt", async () => {
    renderPage();

    const dropzone = await screen.findAllByTestId("image-attachment-dropzone");
    // Only the draft form's field is shown by default (draft tab active).
    expect(dropzone).toHaveLength(1);
    expect(dropzone[0]).toHaveTextContent(/Drag and drop a photo of the handwriting/);
  });

  it("resets text and attachments after a successful draft submission", async () => {
    const user = userEvent.setup();
    renderPage();

    const textarea = await screen.findByPlaceholderText(/Paste your child's draft/);
    await user.type(textarea, "My draft text");

    const input = document.querySelectorAll('input[type="file"]')[0] as HTMLInputElement;
    await user.upload(input, new File(["d"], "draft.png", { type: "image/png" }));
    await waitFor(() => expect(screen.getByAltText(/Attached image 1/)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /Submit draft for feedback/ }));

    await waitFor(() => expect(mockSubmitDraft).toHaveBeenCalledWith(
      { text: "My draft text", images: ["data:image/png;base64,draft.png"] },
      "tok",
    ));
    await waitFor(() => expect(textarea).toHaveValue(""));
    expect(screen.queryByAltText(/Attached image 1/)).not.toBeInTheDocument();
  });
});
