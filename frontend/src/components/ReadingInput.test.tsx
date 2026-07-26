import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReadingInput } from "./ReadingInput";
import { compressImage } from "../services/api";

vi.mock("../services/api", () => ({
  compressImage: vi.fn(),
}));

describe("ReadingInput", () => {
  beforeEach(() => {
    vi.mocked(compressImage).mockImplementation((file: File) =>
      Promise.resolve(`data:image/png;base64,${file.name}`),
    );
  });

  it("requires an uploaded cover before submitting", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<ReadingInput onSubmit={onSubmit} disabled={false} />);

    expect(screen.getByRole("button", { name: /Generate questions/ })).toBeDisabled();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(["cover"], "cover.png", { type: "image/png" }));

    await waitFor(() => expect(screen.getByAltText("cover preview")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Generate questions/ }));

    expect(onSubmit).toHaveBeenCalledWith(["data:image/png;base64,cover.png"]);
  });

  it("labels the first attachment as the cover and later ones as pages", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<ReadingInput onSubmit={onSubmit} disabled={false} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, [
      new File(["cover"], "cover.png", { type: "image/png" }),
      new File(["page"], "page.png", { type: "image/png" }),
    ]);

    await waitFor(() => expect(screen.getByText("cover")).toBeInTheDocument());
    expect(screen.getByText("p1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Generate questions/ }));
    expect(onSubmit).toHaveBeenCalledWith([
      "data:image/png;base64,cover.png",
      "data:image/png;base64,page.png",
    ]);
  });
});
