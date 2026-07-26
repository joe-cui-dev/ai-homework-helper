import { MemoryRouter } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WritingPage } from "./WritingPage";

const { mockUseWritingSession, mockStart } = vi.hoisted(() => ({
  mockUseWritingSession: vi.fn(),
  mockStart: vi.fn(),
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

function renderPage() {
  return render(
    <MemoryRouter>
      <WritingPage token="tok" />
    </MemoryRouter>,
  );
}

describe("WritingPage attachment field", () => {
  beforeEach(() => {
    mockStart.mockReset();
    mockUseWritingSession.mockReturnValue({
      status: "idle",
      sessionId: null,
      error: null,
      start: mockStart,
    });
  });

  it("renders a violet drop area accepting up to 5 assignment photos", () => {
    renderPage();

    const dropzone = screen.getByTestId("image-attachment-dropzone");
    expect(dropzone).toHaveTextContent(/Drag and drop a photo of the assignment/);
    expect(dropzone).toHaveTextContent(/up to 5/);
    expect(dropzone.className).toContain("focus-visible:ring-violet-400");
  });

  it("submits attached images as data URLs alongside the prompt text", async () => {
    const user = userEvent.setup();
    renderPage();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(["a"], "assignment.png", { type: "image/png" }));
    await waitFor(() => expect(screen.getByAltText(/Attached image 1/)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /Build the writing plan/ }));

    expect(mockStart).toHaveBeenCalledWith(
      { text: "", images: ["data:image/png;base64,assignment.png"] },
      "tok",
      undefined,
      "fast",
    );
  });
});
