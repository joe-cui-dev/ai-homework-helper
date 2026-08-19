import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddHomeworkPages } from "./AddHomeworkPages";

vi.mock("./ImageAttachmentField", () => ({
  ImageAttachmentField: ({ onChange, disabled }: { onChange: (value: Array<{ id: string; name: string; fingerprint: string; dataUrl: string }>) => void; disabled: boolean }) => (
    <div>
      <button disabled={disabled} onClick={() => onChange([{ id: "a", name: "a.png", fingerprint: "a", dataUrl: "image-a" }])}>choose a</button>
      <button disabled={disabled} onClick={() => onChange([{ id: "b", name: "b.png", fingerprint: "b", dataUrl: "image-b" }])}>choose b</button>
    </div>
  ),
}));

describe("AddHomeworkPages", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("reuses a submission id for Retry and rotates it when attachments change", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const view = render(<AddHomeworkPages disabled={false} remainingPages={4} remainingQuestions={20} error={null} completedPageCount={1} onSubmit={onSubmit} />);
    await user.click(screen.getByRole("button", { name: "choose a" }));
    await user.click(screen.getByRole("button", { name: "Add pages" }));
    const firstId = onSubmit.mock.calls[0][1] as string;

    view.rerender(<AddHomeworkPages disabled={false} remainingPages={4} remainingQuestions={20} error="Try again" completedPageCount={1} onSubmit={onSubmit} />);
    await user.click(screen.getByRole("button", { name: "Retry adding pages" }));
    expect(onSubmit.mock.calls[1][1]).toBe(firstId);

    await user.click(screen.getByRole("button", { name: "choose b" }));
    await user.click(screen.getByRole("button", { name: "Retry adding pages" }));
    expect(onSubmit.mock.calls[2][1]).not.toBe(firstId);
  });

  it("explains both hard limits", () => {
    const { rerender } = render(<AddHomeworkPages disabled={false} remainingPages={0} remainingQuestions={1} error={null} completedPageCount={10} onSubmit={vi.fn()} />);
    expect(screen.getByText(/10-page limit/)).toBeInTheDocument();
    rerender(<AddHomeworkPages disabled={false} remainingPages={1} remainingQuestions={0} error={null} completedPageCount={1} onSubmit={vi.fn()} />);
    expect(screen.getByText(/30-question limit/)).toBeInTheDocument();
  });
});
