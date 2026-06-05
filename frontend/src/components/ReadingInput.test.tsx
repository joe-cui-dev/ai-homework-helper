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
    vi.mocked(compressImage).mockResolvedValue("data:image/png;base64,cover");
  });

  it("requires an uploaded cover before submitting", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<ReadingInput onSubmit={onSubmit} disabled={false} />);

    expect(screen.getByRole("button", { name: /Generate questions/ })).toBeDisabled();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(["cover"], "cover.png", { type: "image/png" }));

    await waitFor(() => expect(screen.getByAltText("Book cover")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Generate questions/ }));

    expect(onSubmit).toHaveBeenCalledWith(["data:image/png;base64,cover"]);
  });
});
