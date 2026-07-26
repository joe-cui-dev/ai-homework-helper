import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QuestionInput } from "./QuestionInput";
import { compressImage } from "../services/api";

vi.mock("../services/api", () => ({
  compressImage: vi.fn(),
}));

describe("QuestionInput", () => {
  beforeEach(() => {
    vi.mocked(compressImage).mockImplementation((file: File) =>
      Promise.resolve(`data:image/png;base64,${file.name}`),
    );
  });

  it("submits the trimmed homework question", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<QuestionInput onSubmit={onSubmit} disabled={false} />);

    await user.type(
      screen.getByPlaceholderText(/Type your homework question/),
      "  What is 6 x 7?  ",
    );
    await user.click(screen.getByRole("button", { name: /Ask the tutor/ }));

    expect(onSubmit).toHaveBeenCalledWith("What is 6 x 7?", []);
  });

  it("does not submit an empty question", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<QuestionInput onSubmit={onSubmit} disabled={false} />);

    expect(screen.getByRole("button", { name: /Ask the tutor/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Ask the tutor/ }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits an image-only question, mapping attachments to a data URL array", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<QuestionInput onSubmit={onSubmit} disabled={false} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(["q"], "question.png", { type: "image/png" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Ask the tutor/ })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: /Ask the tutor/ }));

    expect(onSubmit).toHaveBeenCalledWith("", ["data:image/png;base64,question.png"]);
  });

  it("disables submit while local image preparation is in progress", async () => {
    let resolveCompress: (value: string) => void = () => {};
    vi.mocked(compressImage).mockImplementation(
      () => new Promise((resolve) => { resolveCompress = resolve; }),
    );
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<QuestionInput onSubmit={onSubmit} disabled={false} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(["q"], "question.png", { type: "image/png" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Preparing photo/ })).toBeDisabled(),
    );

    resolveCompress("data:image/png;base64,question.png");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Ask the tutor/ })).toBeEnabled(),
    );
  });
});
